from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from app.exceptions import ValidationError
from app.schemas import (
    AnalysisEvent,
    AnalysisReportRequest,
    AnalysisReportResponse,
    DimensionClaim,
    DimensionFeedback,
    EvidenceRef,
    Memo,
    OverallFeedback,
    PersonFeedbackItem,
    PersonSummary,
    RegenerateClaimRequest,
    RegenerateClaimResponse,
    ReportQualityMeta,
    SpeakerStat,
    SummarySection,
    TeamDynamics,
)
from app.services.dashscope_llm import DashScopeLLM


DIMENSIONS: tuple[str, ...] = (
    "leadership",
    "collaboration",
    "logic",
    "structure",
    "initiative",
)

DIMENSION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "leadership": ("leadership", "leader", "主导", "推动", "带领", "组织", "决策"),
    "collaboration": ("collaboration", "协作", "配合", "support", "倾听", "补充", "互动"),
    "logic": ("logic", "logical", "推理", "论证", "依据", "分析", "reason"),
    "structure": ("structure", "结构", "框架", "步骤", "拆解", "总结"),
    "initiative": ("initiative", "主动", "推进", "提议", "行动", "next step"),
}


@dataclass(slots=True)
class ReportGenerator:
    llm: DashScopeLLM

    @staticmethod
    def _normalize_text(value: str) -> str:
        return " ".join(str(value or "").strip().split())

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _person_alias_map(stats: list[SpeakerStat]) -> dict[str, str]:
        aliases: dict[str, str] = {}
        for item in stats:
            speaker_key = item.speaker_key.strip()
            if not speaker_key:
                continue
            aliases[speaker_key.lower()] = speaker_key
            if item.speaker_name:
                aliases[item.speaker_name.strip().lower()] = speaker_key
        return aliases

    @staticmethod
    def _evidence_by_id(evidence: list[EvidenceRef]) -> dict[str, EvidenceRef]:
        return {item.evidence_id: item for item in evidence}

    @staticmethod
    def _utterance_to_evidence_ids(evidence: list[EvidenceRef]) -> dict[str, list[str]]:
        mapping: dict[str, list[str]] = {}
        for item in evidence:
            for utterance_id in item.utterance_ids:
                bucket = mapping.get(utterance_id, [])
                bucket.append(item.evidence_id)
                mapping[utterance_id] = bucket
        return mapping

    @staticmethod
    def _evidence_by_speaker_key(evidence: list[EvidenceRef], aliases: dict[str, str]) -> dict[str, list[str]]:
        mapping: dict[str, list[str]] = {}
        for item in evidence:
            speaker_key = str(item.speaker_key or "").strip().lower()
            canonical = aliases.get(speaker_key)
            if not canonical:
                continue
            bucket = mapping.get(canonical, [])
            bucket.append(item.evidence_id)
            mapping[canonical] = bucket
        return mapping

    @staticmethod
    def _dimension_from_memo(memo: Memo) -> str:
        text = ReportGenerator._normalize_text(memo.text).lower()
        tags = " ".join(tag.lower() for tag in memo.tags)
        signal = f"{tags} {text}"
        for dimension, keywords in DIMENSION_KEYWORDS.items():
            if any(keyword in signal for keyword in keywords):
                return dimension
        if memo.type == "question":
            return "logic"
        if memo.type == "decision":
            return "structure"
        if memo.type == "score":
            return "initiative"
        return "collaboration"

    @staticmethod
    def _claim_bucket_from_memo(memo: Memo) -> str:
        if memo.type == "question":
            return "risks"
        if memo.type in {"decision", "score"}:
            return "actions"
        return "strengths"

    @staticmethod
    def _claim_id(person_key: str, dimension: str, claim_type: str, index: int) -> str:
        safe_person = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in person_key) or "unknown"
        return f"c_{safe_person}_{dimension}_{claim_type}_{index:02d}"

    @staticmethod
    def _memo_refs(
        memo: Memo,
        *,
        utterance_to_evidence: dict[str, list[str]],
        all_evidence: list[EvidenceRef],
    ) -> list[str]:
        refs: list[str] = []
        if memo.anchors and memo.anchors.mode == "utterance":
            for utterance_id in memo.anchors.utterance_ids or []:
                refs.extend(utterance_to_evidence.get(utterance_id, []))
        elif memo.anchors and memo.anchors.mode == "time" and memo.anchors.time_range_ms:
            start_ms, end_ms = memo.anchors.time_range_ms[0], memo.anchors.time_range_ms[1]
            for item in all_evidence:
                overlap = min(end_ms, item.time_range_ms[1]) - max(start_ms, item.time_range_ms[0])
                if overlap > 0:
                    refs.append(item.evidence_id)
        deduped = []
        seen = set()
        for ref in refs:
            if ref in seen:
                continue
            seen.add(ref)
            deduped.append(ref)
        return deduped

    @staticmethod
    def _speaker_keys_from_memo_refs(refs: list[str], evidence_by_id: dict[str, EvidenceRef], aliases: dict[str, str]) -> list[str]:
        speakers: list[str] = []
        seen = set()
        for ref in refs:
            evidence = evidence_by_id.get(ref)
            if not evidence or not evidence.speaker_key:
                continue
            canonical = aliases.get(evidence.speaker_key.strip().lower())
            if not canonical or canonical in seen:
                continue
            seen.add(canonical)
            speakers.append(canonical)
        return speakers

    @staticmethod
    def _build_template_claim_text(*, dimension: str, claim_type: str, stat: SpeakerStat) -> str:
        if claim_type == "strengths":
            if stat.turns >= 4:
                return f"{dimension} 维度表现稳定，发言轮次与参与度达到预期。"
            return f"{dimension} 维度已有基础表现，但仍需增加稳定输出。"
        if claim_type == "risks":
            if stat.interruptions >= 3:
                return f"{dimension} 维度存在打断偏多的问题，影响信息接收与协作节奏。"
            if stat.talk_time_ms <= 20_000:
                return f"{dimension} 维度发言时长偏少，关键观点表达覆盖不足。"
            return f"{dimension} 维度在高压场景下仍有优化空间。"
        return f"{dimension} 维度建议在下次面试中给出更明确的可执行动作与收束结论。"

    def _claim_with_refs(
        self,
        *,
        person_key: str,
        dimension: str,
        claim_type: str,
        index: int,
        text: str,
        refs: list[str],
    ) -> DimensionClaim:
        cleaned_refs = [ref for ref in refs if ref]
        if not cleaned_refs:
            raise ValidationError(
                f"claim missing evidence refs: person={person_key} dimension={dimension} type={claim_type}"
            )
        return DimensionClaim(
            claim_id=self._claim_id(person_key, dimension, claim_type, index),
            text=self._normalize_text(text),
            evidence_refs=cleaned_refs,
            confidence=0.8 if claim_type == "strengths" else 0.72,
        )

    @staticmethod
    def _safe_text_for_prompt(value: str) -> str:
        text = ReportGenerator._normalize_text(value)
        return text[:800]

    def _polish_report_with_llm(
        self,
        *,
        session_id: str,
        locale: str,
        per_person: list[PersonFeedbackItem],
        overall: OverallFeedback,
        evidence: list[EvidenceRef],
    ) -> tuple[list[PersonFeedbackItem], OverallFeedback, bool]:
        evidence_by_id = {item.evidence_id: item for item in evidence}
        claim_rows: list[dict[str, object]] = []
        claim_index: dict[tuple[str, str, str, str], DimensionClaim] = {}
        for person in per_person:
            for dimension in person.dimensions:
                for claim_type in ("strengths", "risks", "actions"):
                    for claim in getattr(dimension, claim_type):
                        claim_rows.append(
                            {
                                "person_key": person.person_key,
                                "dimension": dimension.dimension,
                                "claim_type": claim_type,
                                "claim_id": claim.claim_id,
                                "text": claim.text,
                                "evidence_refs": claim.evidence_refs,
                            }
                        )
                        claim_index[(person.person_key, dimension.dimension, claim_type, claim.claim_id)] = claim

        evidence_pack = [
            {
                "evidence_id": item.evidence_id,
                "speaker_key": item.speaker_key,
                "time_range_ms": item.time_range_ms,
                "quote": self._safe_text_for_prompt(item.quote),
            }
            for item in evidence
        ]
        system_prompt = (
            "You rewrite interview feedback claims with better clarity while keeping facts unchanged. "
            "Return strict JSON only. Never invent evidence ids. "
            "Only use evidence ids from allowed lists per claim. "
            "Use concise professional Chinese unless locale asks otherwise."
        )
        user_prompt = json.dumps(
            {
                "task": "polish_report_claims",
                "session_id": session_id,
                "locale": locale,
                "claims": claim_rows,
                "evidence_pack": evidence_pack,
                "overall": {
                    "summary_sections": [section.model_dump() for section in overall.summary_sections],
                    "team_dynamics": overall.team_dynamics.model_dump(),
                },
                "output_contract": {
                    "claim_text_updates": [
                        {
                            "person_key": "string",
                            "dimension": "leadership|collaboration|logic|structure|initiative",
                            "claim_type": "strengths|risks|actions",
                            "claim_id": "string",
                            "text": "string",
                            "evidence_refs": ["must be subset of existing claim refs or any evidence ids in evidence_pack"],
                        }
                    ],
                    "overall": {
                        "summary_sections": [{"topic": "string", "bullets": ["string"], "evidence_ids": ["string"]}],
                        "team_dynamics": {"highlights": ["string"], "risks": ["string"]},
                    },
                },
            },
            ensure_ascii=False,
        )
        parsed = self.llm.generate_json(system_prompt=system_prompt, user_prompt=user_prompt)
        updates = parsed.get("claim_text_updates")
        if not isinstance(updates, list):
            raise ValidationError("llm report polish response missing claim_text_updates")

        changed = False
        for row in updates:
            if not isinstance(row, dict):
                continue
            person_key = str(row.get("person_key", "")).strip()
            dimension = str(row.get("dimension", "")).strip()
            claim_type = str(row.get("claim_type", "")).strip()
            claim_id = str(row.get("claim_id", "")).strip()
            if not person_key or not dimension or not claim_type or not claim_id:
                continue
            target = claim_index.get((person_key, dimension, claim_type, claim_id))
            if not target:
                continue
            new_text = self._normalize_text(str(row.get("text", "")))
            if new_text:
                target.text = new_text
                changed = True
            refs_value = row.get("evidence_refs")
            if isinstance(refs_value, list):
                cleaned_refs: list[str] = []
                for item in refs_value:
                    ref = str(item or "").strip()
                    if not ref or ref not in evidence_by_id:
                        continue
                    cleaned_refs.append(ref)
                deduped_refs: list[str] = []
                seen = set()
                for ref in cleaned_refs:
                    if ref in seen:
                        continue
                    seen.add(ref)
                    deduped_refs.append(ref)
                if deduped_refs:
                    target.evidence_refs = deduped_refs[:3]
                    changed = True

        overall_row = parsed.get("overall")
        if isinstance(overall_row, dict):
            sections: list[SummarySection] = []
            for item in overall_row.get("summary_sections", []):
                if not isinstance(item, dict):
                    continue
                topic = self._normalize_text(str(item.get("topic", "")))
                if not topic:
                    continue
                bullets = [self._normalize_text(str(b)) for b in item.get("bullets", []) if self._normalize_text(str(b))]
                evidence_ids = []
                for evidence_id in item.get("evidence_ids", []):
                    ref = str(evidence_id or "").strip()
                    if ref and ref in evidence_by_id:
                        evidence_ids.append(ref)
                sections.append(SummarySection(topic=topic, bullets=bullets[:6], evidence_ids=evidence_ids[:6]))
            if sections:
                overall.summary_sections = sections[:6]
                changed = True
            team = overall_row.get("team_dynamics")
            if isinstance(team, dict):
                highlights = [
                    self._normalize_text(str(item))
                    for item in team.get("highlights", [])
                    if self._normalize_text(str(item))
                ]
                risks = [
                    self._normalize_text(str(item))
                    for item in team.get("risks", [])
                    if self._normalize_text(str(item))
                ]
                if highlights or risks:
                    overall.team_dynamics = TeamDynamics(highlights=highlights[:6], risks=risks[:6])
                    changed = True

        if not changed:
            raise ValidationError("llm report polish returned no usable updates")
        return per_person, overall, True

    def _fallback_refs_for_person(
        self,
        *,
        person_key: str,
        evidence_by_person: dict[str, list[str]],
        all_refs: list[str],
    ) -> list[str]:
        refs = evidence_by_person.get(person_key, [])
        if refs:
            return refs[:2]
        return all_refs[:2]

    def _ensure_dimensions(
        self,
        *,
        person_key: str,
        stat: SpeakerStat,
        dimensions_map: dict[str, dict[str, list[DimensionClaim]]],
        fallback_refs: list[str],
    ) -> list[DimensionFeedback]:
        output: list[DimensionFeedback] = []
        for dimension in DIMENSIONS:
            bucket = dimensions_map.get(dimension, {"strengths": [], "risks": [], "actions": []})
            for claim_type in ("strengths", "risks", "actions"):
                if bucket[claim_type]:
                    continue
                bucket[claim_type].append(
                    self._claim_with_refs(
                        person_key=person_key,
                        dimension=dimension,
                        claim_type=claim_type,
                        index=1,
                        text=self._build_template_claim_text(dimension=dimension, claim_type=claim_type, stat=stat),
                        refs=fallback_refs,
                    )
                )
            output.append(
                DimensionFeedback(
                    dimension=dimension,  # type: ignore[arg-type]
                    strengths=bucket["strengths"],
                    risks=bucket["risks"],
                    actions=bucket["actions"],
                )
            )
        return output

    def _person_stats(self, req: AnalysisReportRequest) -> list[SpeakerStat]:
        if req.stats:
            return req.stats
        fallback: list[SpeakerStat] = []
        seen = set()
        for item in req.transcript:
            key = (item.speaker_name or item.cluster_id or item.stream_role).strip()
            if not key or key in seen:
                continue
            seen.add(key)
            fallback.append(
                SpeakerStat(
                    speaker_key=key,
                    speaker_name=item.speaker_name or key,
                    talk_time_ms=0,
                    turns=0,
                    silence_ms=0,
                    interruptions=0,
                    interrupted_by_others=0,
                )
            )
        return fallback or [
            SpeakerStat(
                speaker_key="unknown",
                speaker_name="unknown",
                talk_time_ms=0,
                turns=0,
                silence_ms=0,
                interruptions=0,
                interrupted_by_others=0,
            )
        ]

    def _build_overall(
        self,
        *,
        memos: list[Memo],
        events: list[AnalysisEvent],
        all_refs: list[str],
        per_person: list[PersonFeedbackItem],
    ) -> OverallFeedback:
        memo_bullets = [self._normalize_text(item.text) for item in memos[-8:] if self._normalize_text(item.text)]
        if not memo_bullets:
            memo_bullets = ["本场暂无有效 memo，建议结合证据回看后补充关键观察。"]
        event_bullets = []
        for event in events[-6:]:
            actor = event.actor or "participant"
            quote = self._normalize_text(event.quote or "")
            if quote:
                event_bullets.append(f"{actor}: {quote}")
            else:
                event_bullets.append(f"{actor}: {event.event_type}")
        if not event_bullets:
            event_bullets = ["暂无显著事件，建议结合 transcript 核对互动细节。"]

        summary_sections = [
            SummarySection(topic="Teacher Memos", bullets=memo_bullets[:6], evidence_ids=all_refs[:4]),
            SummarySection(topic="Interaction Events", bullets=event_bullets[:6], evidence_ids=all_refs[:4]),
        ]
        team_highlights = [
            item.summary.strengths[0]
            for item in per_person
            if item.summary.strengths
        ][:4]
        team_risks = [
            item.summary.risks[0]
            for item in per_person
            if item.summary.risks
        ][:4]
        return OverallFeedback(
            summary_sections=summary_sections,
            team_dynamics=TeamDynamics(
                highlights=team_highlights or ["团队在关键节点能维持基本推进。"],
                risks=team_risks or ["建议在下一轮增加明确分工和时间管理。"],
            ),
        )

    def generate(self, req: AnalysisReportRequest) -> AnalysisReportResponse:
        started_at = datetime.now(timezone.utc)
        stats = self._person_stats(req)
        aliases = self._person_alias_map(stats)
        evidence_by_id = self._evidence_by_id(req.evidence)
        utterance_to_evidence = self._utterance_to_evidence_ids(req.evidence)
        evidence_by_person = self._evidence_by_speaker_key(req.evidence, aliases)
        all_refs = [item.evidence_id for item in req.evidence]

        claims_by_person: dict[str, dict[str, dict[str, list[DimensionClaim]]]] = {}
        for stat in stats:
            claims_by_person[stat.speaker_key] = {
                dimension: {"strengths": [], "risks": [], "actions": []} for dimension in DIMENSIONS
            }

        for memo in req.memos:
            refs = self._memo_refs(memo, utterance_to_evidence=utterance_to_evidence, all_evidence=req.evidence)
            speakers = self._speaker_keys_from_memo_refs(refs, evidence_by_id, aliases)
            dimension = self._dimension_from_memo(memo)
            claim_type = self._claim_bucket_from_memo(memo)
            if not speakers and len(stats) == 1:
                speakers = [stats[0].speaker_key]
            for speaker_key in speakers:
                fallback_refs = self._fallback_refs_for_person(
                    person_key=speaker_key,
                    evidence_by_person=evidence_by_person,
                    all_refs=all_refs,
                )
                claim_refs = refs[:2] if refs else fallback_refs
                claim_rows = claims_by_person[speaker_key][dimension][claim_type]
                claim_rows.append(
                    self._claim_with_refs(
                        person_key=speaker_key,
                        dimension=dimension,
                        claim_type=claim_type,
                        index=len(claim_rows) + 1,
                        text=memo.text,
                        refs=claim_refs,
                    )
                )

        per_person: list[PersonFeedbackItem] = []
        for stat in stats:
            person_key = stat.speaker_key
            display_name = stat.speaker_name or person_key
            fallback_refs = self._fallback_refs_for_person(
                person_key=person_key,
                evidence_by_person=evidence_by_person,
                all_refs=all_refs,
            )
            if not fallback_refs:
                raise ValueError(f"person '{person_key}' has no evidence refs; report generation aborted")
            dimensions = self._ensure_dimensions(
                person_key=person_key,
                stat=stat,
                dimensions_map=claims_by_person[person_key],
                fallback_refs=fallback_refs,
            )
            summary = PersonSummary(
                strengths=[item.strengths[0].text for item in dimensions if item.strengths][:3],
                risks=[item.risks[0].text for item in dimensions if item.risks][:3],
                actions=[item.actions[0].text for item in dimensions if item.actions][:3],
            )
            per_person.append(
                PersonFeedbackItem(
                    person_key=person_key,
                    display_name=display_name,
                    dimensions=dimensions,
                    summary=summary,
                )
            )

        overall = self._build_overall(
            memos=req.memos,
            events=req.events,
            all_refs=all_refs,
            per_person=per_person,
        )

        report_source: str = "memo_first"
        report_error: str | None = None
        report_degraded = False
        try:
            per_person, overall, _ = self._polish_report_with_llm(
                session_id=req.session_id,
                locale=req.locale,
                per_person=per_person,
                overall=overall,
                evidence=req.evidence,
            )
            report_source = "llm_enhanced"
        except Exception as exc:
            report_source = "llm_failed"
            report_error = self._normalize_text(str(exc))[:300]
            report_degraded = True

        claim_count = 0
        invalid_claim_count = 0
        needs_evidence_count = 0
        for person in per_person:
            for dimension in person.dimensions:
                for claim in [*dimension.strengths, *dimension.risks, *dimension.actions]:
                    claim_count += 1
                    if not claim.evidence_refs:
                        invalid_claim_count += 1
                        needs_evidence_count += 1

        finished_at = datetime.now(timezone.utc)
        build_ms = int((finished_at - started_at).total_seconds() * 1000)
        model_name = getattr(self.llm, "model_name", None)
        if model_name is not None:
            model_name = str(model_name).strip() or None
        quality = ReportQualityMeta(
            generated_at=self._now_iso(),
            build_ms=max(0, build_ms),
            validation_ms=0,
            claim_count=claim_count,
            invalid_claim_count=invalid_claim_count,
            needs_evidence_count=needs_evidence_count,
            report_source=report_source,  # type: ignore[arg-type]
            report_model=model_name,
            report_degraded=report_degraded,
            report_error=report_error,
        )

        return AnalysisReportResponse(
            session_id=req.session_id,
            overall=overall,
            per_person=per_person,
            quality=quality,
        )

    def regenerate_claim(self, req: RegenerateClaimRequest) -> RegenerateClaimResponse:
        allowed_refs = []
        allowed_set = set()
        for item in req.allowed_evidence_ids:
            ref = str(item or "").strip()
            if not ref or ref in allowed_set:
                continue
            allowed_set.add(ref)
            allowed_refs.append(ref)
        if not allowed_refs:
            raise ValidationError("allowed_evidence_ids is empty")

        evidence_by_id = self._evidence_by_id(req.evidence)
        missing = [ref for ref in allowed_refs if ref not in evidence_by_id]
        if missing:
            raise ValidationError(f"allowed evidence ids not found in evidence payload: {missing[:5]}")

        evidence_pack = [
            {
                "evidence_id": ref,
                "speaker_key": evidence_by_id[ref].speaker_key,
                "time_range_ms": evidence_by_id[ref].time_range_ms,
                "quote": self._safe_text_for_prompt(evidence_by_id[ref].quote),
            }
            for ref in allowed_refs
        ]
        system_prompt = (
            "You regenerate one interview feedback claim. "
            "Return strict JSON only with keys: text, evidence_refs. "
            "evidence_refs must be a non-empty subset of allowed evidence ids. "
            "Do not invent facts."
        )
        user_prompt = json.dumps(
            {
                "task": "regenerate_claim",
                "session_id": req.session_id,
                "locale": req.locale,
                "person_key": req.person_key,
                "display_name": req.display_name,
                "dimension": req.dimension,
                "claim_type": req.claim_type,
                "claim_id": req.claim_id,
                "claim_text": req.claim_text,
                "text_hint": req.text_hint,
                "allowed_evidence_ids": allowed_refs,
                "evidence_pack": evidence_pack,
            },
            ensure_ascii=False,
        )
        parsed = self.llm.generate_json(system_prompt=system_prompt, user_prompt=user_prompt)
        text = self._normalize_text(str(parsed.get("text", "")))
        if not text:
            raise ValidationError("llm regenerate claim returned empty text")
        refs_value = parsed.get("evidence_refs")
        if not isinstance(refs_value, list):
            raise ValidationError("llm regenerate claim missing evidence_refs")
        refs: list[str] = []
        seen = set()
        for item in refs_value:
            ref = str(item or "").strip()
            if not ref or ref not in allowed_set or ref in seen:
                continue
            seen.add(ref)
            refs.append(ref)
        if not refs:
            raise ValidationError("llm regenerate claim returned no valid evidence refs")

        claim_id = req.claim_id or self._claim_id(req.person_key, req.dimension, req.claim_type, 1)
        claim = DimensionClaim(
            claim_id=claim_id,
            text=text,
            evidence_refs=refs[:3],
            confidence=0.8 if req.claim_type == "strengths" else 0.72,
        )
        return RegenerateClaimResponse(
            session_id=req.session_id,
            person_key=req.person_key,
            dimension=req.dimension,
            claim_type=req.claim_type,
            claim=claim,
        )
