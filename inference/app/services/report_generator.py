from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

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
            raise ValueError(
                f"claim missing evidence refs: person={person_key} dimension={dimension} type={claim_type}"
            )
        return DimensionClaim(
            claim_id=self._claim_id(person_key, dimension, claim_type, index),
            text=self._normalize_text(text),
            evidence_refs=cleaned_refs,
            confidence=0.8 if claim_type == "strengths" else 0.72,
        )

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
        quality = ReportQualityMeta(
            generated_at=self._now_iso(),
            build_ms=max(0, build_ms),
            validation_ms=0,
            claim_count=claim_count,
            invalid_claim_count=invalid_claim_count,
            needs_evidence_count=needs_evidence_count,
        )

        return AnalysisReportResponse(
            session_id=req.session_id,
            overall=overall,
            per_person=per_person,
            quality=quality,
        )
