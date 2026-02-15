from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from app.exceptions import ValidationError
from app.schemas import (
    AnalysisReportResponse,
    DimensionClaim,
    DimensionFeedback,
    OverallFeedback,
    PersonFeedbackItem,
    PersonSummary,
    ReportQualityMeta,
    SummarySection,
    SynthesisContextMeta,
    SynthesizeReportRequest,
    TeamDynamics,
    TranscriptUtterance,
)
from app.services.dashscope_llm import DashScopeLLM

logger = logging.getLogger(__name__)

DIMENSIONS = ["leadership", "collaboration", "logic", "structure", "initiative"]


class ReportSynthesizer:
    """LLM-core report generation with deep citations."""

    def __init__(self, llm: DashScopeLLM):
        self.llm = llm

    def synthesize(self, req: SynthesizeReportRequest) -> AnalysisReportResponse:
        """Main entry point. LLM synthesizes report from full context.
        Falls back to memo-first if LLM fails."""
        started_at = time.time()

        try:
            # 1. Truncate transcript if needed
            truncated_transcript, was_truncated = self._truncate_transcript(
                req.transcript, max_tokens=6000
            )

            # 2. Build prompts
            system_prompt = self._build_system_prompt(req)
            user_prompt = self._build_user_prompt(req, truncated_transcript)

            # 3. Call LLM
            parsed = self.llm.generate_json(
                system_prompt=system_prompt, user_prompt=user_prompt
            )

            # 4. Parse and validate LLM output
            valid_evidence_ids = {e.evidence_id for e in req.evidence}
            overall, per_person = self._parse_llm_output(parsed, valid_evidence_ids, locale=req.locale)

            # 5. Build quality meta
            elapsed_ms = int((time.time() - started_at) * 1000)
            claim_count = 0
            needs_evidence = 0
            for person in per_person:
                for dim in person.dimensions:
                    for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                        claim_count += 1
                        if not claim.evidence_refs:
                            needs_evidence += 1

            source = "llm_synthesized_truncated" if was_truncated else "llm_synthesized"

            synthesis_context = SynthesisContextMeta(
                rubric_used=req.rubric is not None,
                free_notes_used=bool(req.free_form_notes),
                historical_sessions_count=len(req.historical),
                name_bindings_count=len(req.memo_speaker_bindings),
                stages_count=len(req.stages),
                transcript_tokens_approx=sum(
                    self._estimate_tokens(u.text) for u in truncated_transcript
                ),
                transcript_truncated=was_truncated,
            )

            quality = ReportQualityMeta(
                generated_at=datetime.now(timezone.utc).isoformat(),
                build_ms=elapsed_ms,
                claim_count=claim_count,
                needs_evidence_count=needs_evidence,
                report_source=source,
                synthesis_context=synthesis_context,
            )

            return AnalysisReportResponse(
                session_id=req.session_id,
                overall=overall,
                per_person=per_person,
                quality=quality,
            )

        except Exception as exc:
            logger.warning(
                "LLM synthesis failed for %s, falling back to memo-first: %s",
                req.session_id,
                str(exc),
            )
            return self._fallback_memo_first(req, started_at, str(exc))

    def _build_system_prompt(self, req: SynthesizeReportRequest) -> str:
        locale_hint = "Chinese (zh-CN)" if req.locale == "zh-CN" else "English"
        return (
            "You are an expert interview analyst generating structured feedback reports.\n\n"
            "CRITICAL RULES:\n"
            "1. Every claim MUST cite 1-5 evidence references using the evidence_id values from the evidence_pack.\n"
            "2. DO NOT invent evidence IDs — only use IDs from the evidence_pack.\n"
            "3. Cross-reference the interviewer's memos with the actual transcript.\n"
            "4. If a memo says someone showed a skill — find the specific transcript moment and cite it.\n"
            "5. If memo observations conflict with transcript evidence, flag the discrepancy.\n"
            "6. Evaluate each person against ALL 5 dimensions: leadership, collaboration, logic, structure, initiative.\n"
            "7. Group observations by interview stage when stage data is available.\n"
            "8. Use the free-form notes as additional context but prioritize structured memos.\n"
            "9. If historical data is provided, note improvements or regressions.\n"
            "10. Each dimension MUST have at least 1 strength, 1 risk, and 1 action.\n\n"
            "OUTPUT FORMAT: Strict JSON matching the output_contract.\n"
            f"LANGUAGE: {locale_hint} — use professional, concise language.\n"
        )

    def _build_user_prompt(
        self,
        req: SynthesizeReportRequest,
        truncated_transcript: list[TranscriptUtterance],
    ) -> str:
        evidence_pack = [
            {
                "evidence_id": e.evidence_id,
                "speaker_key": e.speaker_key,
                "time_range_ms": e.time_range_ms,
                "quote": e.quote[:800],
            }
            for e in req.evidence
        ]

        transcript_segments = [
            {
                "utterance_id": u.utterance_id,
                "speaker_name": u.speaker_name,
                "text": u.text[:600],
                "start_ms": u.start_ms,
                "end_ms": u.end_ms,
            }
            for u in truncated_transcript
        ]

        memos_with_bindings = []
        binding_map = {b.memo_id: b for b in req.memo_speaker_bindings}
        for memo in req.memos:
            entry = {
                "memo_id": memo.memo_id,
                "text": memo.text,
                "type": memo.type,
                "tags": memo.tags,
                "created_at_ms": memo.created_at_ms,
            }
            if memo.stage:
                entry["stage"] = memo.stage
            binding = binding_map.get(memo.memo_id)
            if binding:
                entry["bound_speakers"] = binding.matched_speaker_keys
            memos_with_bindings.append(entry)

        stats = [
            {
                "speaker_key": s.speaker_key,
                "speaker_name": s.speaker_name,
                "talk_time_ms": s.talk_time_ms,
                "turns": s.turns,
            }
            for s in req.stats
        ]

        prompt_data: dict = {
            "task": "synthesize_report",
            "session_id": req.session_id,
            "transcript_segments": transcript_segments,
            "memos_with_bindings": memos_with_bindings,
            "evidence_pack": evidence_pack,
            "stats": stats,
            "stages": req.stages,
            "output_contract": {
                "overall": {
                    "summary_sections": [
                        {"topic": "string", "bullets": ["string with [e_XXXXX] citations"], "evidence_ids": ["string"]}
                    ],
                    "team_dynamics": {"highlights": ["string"], "risks": ["string"]},
                },
                "per_person": [
                    {
                        "person_key": "string (from stats speaker_key)",
                        "display_name": "string",
                        "dimensions": [
                            {
                                "dimension": "leadership|collaboration|logic|structure|initiative",
                                "strengths": [{"claim_id": "c_{person}_{dim}_{nn}", "text": "string with [e_XXXXX]", "evidence_refs": ["e_XXXXX"], "confidence": 0.7}],
                                "risks": [{"claim_id": "...", "text": "...", "evidence_refs": ["..."], "confidence": 0.7}],
                                "actions": [{"claim_id": "...", "text": "...", "evidence_refs": ["..."], "confidence": 0.7}],
                            }
                        ],
                        "summary": {"strengths": ["string"], "risks": ["string"], "actions": ["string"]},
                    }
                ],
            },
        }

        if req.rubric:
            prompt_data["rubric"] = {
                "template_name": req.rubric.template_name,
                "dimensions": [
                    {"name": d.name, "description": d.description, "weight": d.weight}
                    for d in req.rubric.dimensions
                ],
            }

        if req.session_context:
            prompt_data["session_context"] = {
                "mode": req.session_context.mode,
                "interviewer_name": req.session_context.interviewer_name,
                "position_title": req.session_context.position_title,
            }

        if req.free_form_notes:
            prompt_data["free_form_notes"] = req.free_form_notes[:2000]

        if req.historical:
            prompt_data["historical"] = [
                {
                    "session_id": h.session_id,
                    "date": h.date,
                    "summary": h.summary,
                    "strengths": h.strengths,
                    "risks": h.risks,
                }
                for h in req.historical
            ]

        return json.dumps(prompt_data, ensure_ascii=False)

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        """CJK-aware token estimation.

        Chinese text averages ~1.5 tokens per character (most tokenizers split
        hanzi into 1-2 tokens). English text averages ~1.3 tokens per
        whitespace-delimited word.
        """
        if not text:
            return 0
        cjk_chars = sum(
            1 for c in text if '\u4e00' <= c <= '\u9fff' or '\u3400' <= c <= '\u4dbf'
        )
        if cjk_chars > len(text) * 0.3:
            return int(len(text) * 1.5)  # Chinese: ~1.5 tokens per char
        else:
            return int(len(text.split()) * 1.3)  # English: ~1.3 tokens per word

    def _truncate_transcript(
        self, transcript: list[TranscriptUtterance], max_tokens: int = 6000
    ) -> tuple[list[TranscriptUtterance], bool]:
        """Truncate if total token count exceeds max_tokens."""
        total_tokens = sum(self._estimate_tokens(u.text) for u in transcript)
        if total_tokens <= max_tokens:
            return list(transcript), False

        # Strategy: keep first utterance from each speaker + most recent utterances
        sorted_utt = sorted(transcript, key=lambda u: u.start_ms)
        first_per_speaker: dict[str, TranscriptUtterance] = {}
        for u in sorted_utt:
            key = u.speaker_name or u.cluster_id or "unknown"
            if key not in first_per_speaker:
                first_per_speaker[key] = u

        must_keep_ids = {u.utterance_id for u in first_per_speaker.values()}

        # Add the last N utterances to fill remaining budget
        result = [u for u in sorted_utt if u.utterance_id in must_keep_ids]
        current_tokens = sum(self._estimate_tokens(u.text) for u in result)

        # Fill from the end (most recent = most relevant)
        for u in reversed(sorted_utt):
            if u.utterance_id in must_keep_ids:
                continue
            word_count = self._estimate_tokens(u.text)
            if current_tokens + word_count > max_tokens:
                continue
            result.append(u)
            current_tokens += word_count

        result.sort(key=lambda u: u.start_ms)
        return result, True

    @staticmethod
    def _insufficient_data_text(dim_name: str, locale: str) -> str:
        if locale.startswith("zh"):
            return f"{dim_name} 维度数据不足，暂无法评估。"
        return f"Insufficient data for {dim_name} assessment — awaiting more evidence."

    def _parse_llm_output(
        self, parsed: dict, valid_evidence_ids: set[str], locale: str = "zh-CN"
    ) -> tuple[OverallFeedback, list[PersonFeedbackItem]]:
        """Parse and validate LLM JSON output into Pydantic models."""
        # Parse overall
        overall_raw = parsed.get("overall", {})
        summary_sections = []
        for section in overall_raw.get("summary_sections", []):
            if not isinstance(section, dict):
                continue
            topic = str(section.get("topic", "")).strip()
            if not topic:
                continue
            bullets = [str(b).strip() for b in section.get("bullets", []) if str(b).strip()]
            eids = [
                str(eid).strip()
                for eid in section.get("evidence_ids", [])
                if str(eid).strip() in valid_evidence_ids
            ]
            summary_sections.append(
                SummarySection(topic=topic, bullets=bullets[:6], evidence_ids=eids[:6])
            )

        team_raw = overall_raw.get("team_dynamics", {})
        highlights = [str(h).strip() for h in team_raw.get("highlights", []) if str(h).strip()]
        risks = [str(r).strip() for r in team_raw.get("risks", []) if str(r).strip()]

        overall = OverallFeedback(
            summary_sections=summary_sections[:6],
            team_dynamics=TeamDynamics(highlights=highlights[:6], risks=risks[:6]),
        )

        # Parse per_person
        per_person = []
        for person_raw in parsed.get("per_person", []):
            if not isinstance(person_raw, dict):
                continue
            person_key = str(person_raw.get("person_key", "")).strip()
            display_name = str(person_raw.get("display_name", person_key)).strip()
            if not person_key:
                continue

            dimensions = []
            for dim_raw in person_raw.get("dimensions", []):
                if not isinstance(dim_raw, dict):
                    continue
                dim_name = str(dim_raw.get("dimension", "")).strip()
                if dim_name not in DIMENSIONS:
                    continue

                def parse_claims(claims_raw: list) -> list[DimensionClaim]:
                    claims = []
                    for c in claims_raw:
                        if not isinstance(c, dict):
                            continue
                        cid = str(c.get("claim_id", "")).strip()
                        text = str(c.get("text", "")).strip()
                        if not text:
                            continue
                        refs = [
                            str(r).strip()
                            for r in c.get("evidence_refs", [])
                            if str(r).strip() in valid_evidence_ids
                        ]
                        conf = float(c.get("confidence", 0.7))
                        conf = max(0.0, min(1.0, conf))
                        if not refs:
                            # Use first available evidence as fallback
                            refs = list(valid_evidence_ids)[:1]
                        claims.append(
                            DimensionClaim(
                                claim_id=cid or f"c_{person_key}_{dim_name}_{len(claims)+1:02d}",
                                text=text,
                                evidence_refs=refs[:5],
                                confidence=conf,
                            )
                        )
                    return claims

                strengths = parse_claims(dim_raw.get("strengths", []))
                risks_list = parse_claims(dim_raw.get("risks", []))
                actions = parse_claims(dim_raw.get("actions", []))

                insufficient_text = self._insufficient_data_text(dim_name, locale)
                dimensions.append(
                    DimensionFeedback(
                        dimension=dim_name,
                        strengths=strengths if strengths else [
                            DimensionClaim(claim_id=f"c_{person_key}_{dim_name}_s1", text=insufficient_text, evidence_refs=list(valid_evidence_ids)[:1], confidence=0.3)
                        ],
                        risks=risks_list if risks_list else [
                            DimensionClaim(claim_id=f"c_{person_key}_{dim_name}_r1", text=insufficient_text, evidence_refs=list(valid_evidence_ids)[:1], confidence=0.3)
                        ],
                        actions=actions if actions else [
                            DimensionClaim(claim_id=f"c_{person_key}_{dim_name}_a1", text=insufficient_text, evidence_refs=list(valid_evidence_ids)[:1], confidence=0.3)
                        ],
                    )
                )

            # Ensure all 5 dimensions present
            present_dims = {d.dimension for d in dimensions}
            for dim_name in DIMENSIONS:
                if dim_name not in present_dims:
                    fallback_ref = list(valid_evidence_ids)[:1]
                    insufficient_text = self._insufficient_data_text(dim_name, locale)
                    dimensions.append(
                        DimensionFeedback(
                            dimension=dim_name,
                            strengths=[DimensionClaim(claim_id=f"c_{person_key}_{dim_name}_s1", text=insufficient_text, evidence_refs=fallback_ref, confidence=0.3)],
                            risks=[DimensionClaim(claim_id=f"c_{person_key}_{dim_name}_r1", text=insufficient_text, evidence_refs=fallback_ref, confidence=0.3)],
                            actions=[DimensionClaim(claim_id=f"c_{person_key}_{dim_name}_a1", text=insufficient_text, evidence_refs=fallback_ref, confidence=0.3)],
                        )
                    )

            # Sort dimensions to canonical order
            dim_order = {d: i for i, d in enumerate(DIMENSIONS)}
            dimensions.sort(key=lambda d: dim_order.get(d.dimension, 99))

            summary_raw = person_raw.get("summary", {})
            summary = PersonSummary(
                strengths=[str(s) for s in summary_raw.get("strengths", [])][:3],
                risks=[str(r) for r in summary_raw.get("risks", [])][:3],
                actions=[str(a) for a in summary_raw.get("actions", [])][:3],
            )

            per_person.append(
                PersonFeedbackItem(
                    person_key=person_key,
                    display_name=display_name,
                    dimensions=dimensions,
                    summary=summary,
                )
            )

        if not per_person:
            raise ValidationError("LLM output has no per_person data")

        return overall, per_person

    def _fallback_memo_first(
        self,
        req: SynthesizeReportRequest,
        started_at: float,
        error_msg: str,
    ) -> AnalysisReportResponse:
        """Use existing report_generator-style memo-first as fallback."""
        from app.services.report_generator import ReportGenerator

        fallback_gen = ReportGenerator(llm=self.llm)

        # Convert SynthesizeReportRequest to AnalysisReportRequest
        from app.schemas import AnalysisReportRequest

        fallback_req = AnalysisReportRequest(
            session_id=req.session_id,
            transcript=req.transcript,
            memos=req.memos,
            stats=req.stats,
            evidence=req.evidence,
            events=req.events,
            locale=req.locale,
        )

        try:
            result = fallback_gen.generate(fallback_req)
        except Exception:
            # Even fallback failed — build minimal valid response
            valid_refs = [e.evidence_id for e in req.evidence][:1]

            def _fb_text(dim: str) -> str:
                return self._insufficient_data_text(dim, req.locale)

            result = AnalysisReportResponse(
                session_id=req.session_id,
                overall=OverallFeedback(),
                per_person=[
                    PersonFeedbackItem(
                        person_key=s.speaker_key,
                        display_name=s.speaker_name or s.speaker_key,
                        dimensions=[
                            DimensionFeedback(
                                dimension=dim,
                                strengths=[DimensionClaim(claim_id=f"c_fb_{dim}_s", text=_fb_text(dim), evidence_refs=valid_refs, confidence=0.2)],
                                risks=[DimensionClaim(claim_id=f"c_fb_{dim}_r", text=_fb_text(dim), evidence_refs=valid_refs, confidence=0.2)],
                                actions=[DimensionClaim(claim_id=f"c_fb_{dim}_a", text=_fb_text(dim), evidence_refs=valid_refs, confidence=0.2)],
                            )
                            for dim in DIMENSIONS
                        ],
                    )
                    for s in (req.stats or [])
                ] or [
                    PersonFeedbackItem(
                        person_key="unknown",
                        display_name="unknown",
                        dimensions=[
                            DimensionFeedback(
                                dimension=dim,
                                strengths=[DimensionClaim(claim_id=f"c_fb_{dim}_s", text=_fb_text(dim), evidence_refs=valid_refs, confidence=0.2)],
                                risks=[DimensionClaim(claim_id=f"c_fb_{dim}_r", text=_fb_text(dim), evidence_refs=valid_refs, confidence=0.2)],
                                actions=[DimensionClaim(claim_id=f"c_fb_{dim}_a", text=_fb_text(dim), evidence_refs=valid_refs, confidence=0.2)],
                            )
                            for dim in DIMENSIONS
                        ],
                    )
                ],
            )

        elapsed_ms = int((time.time() - started_at) * 1000)
        result.quality = ReportQualityMeta(
            generated_at=datetime.now(timezone.utc).isoformat(),
            build_ms=elapsed_ms,
            report_source="memo_first_fallback",
            report_error=error_msg[:500],
        )
        return result
