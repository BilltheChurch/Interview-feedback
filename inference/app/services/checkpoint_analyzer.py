from __future__ import annotations

import json
import logging
import time

from app.exceptions import ValidationError
from app.schemas import (
    AnalysisReportResponse,
    CheckpointDimensionSignal,
    CheckpointRequest,
    CheckpointResponse,
    CheckpointSpeakerNote,
    DimensionClaim,
    DimensionFeedback,
    EvidenceRef,
    MergeCheckpointsRequest,
    OverallFeedback,
    PersonFeedbackItem,
    PersonSummary,
    ReportQualityMeta,
    SummarySection,
    SynthesisContextMeta,
    TeamDynamics,
)
from app.services.dashscope_llm import DashScopeLLM

logger = logging.getLogger(__name__)

DIMENSIONS = ["leadership", "collaboration", "logic", "structure", "initiative"]


class CheckpointAnalyzer:
    """Analyzes 5-minute interview windows incrementally during recording."""

    def __init__(self, llm: DashScopeLLM):
        self.llm = llm

    def analyze_checkpoint(self, req: CheckpointRequest) -> CheckpointResponse:
        """Analyze a single 5-minute checkpoint window.

        Input: recent utterances + memos + stats for the window.
        Output: compact summary with per-speaker observations and dimension signals.
        """
        if not req.utterances:
            return CheckpointResponse(
                session_id=req.session_id,
                checkpoint_index=req.checkpoint_index,
                timestamp_ms=0,
                summary="No utterances in this checkpoint window.",
                per_speaker_notes=[],
                dimension_signals=[],
            )

        system_prompt = self._build_checkpoint_system_prompt(req.locale)
        user_prompt = self._build_checkpoint_user_prompt(req)

        parsed = self.llm.generate_json(
            system_prompt=system_prompt, user_prompt=user_prompt
        )

        timestamp_ms = max(u.end_ms for u in req.utterances)
        return self._parse_checkpoint_output(
            parsed, req.session_id, req.checkpoint_index, timestamp_ms
        )

    def merge_checkpoints(self, req: MergeCheckpointsRequest) -> AnalysisReportResponse:
        """Merge checkpoint summaries into a final structured report.

        This replaces the massive single-call synthesize for long interviews.
        Input: list of checkpoint summaries + final stats + evidence.
        Output: same AnalysisReportResponse schema as synthesize.
        """
        started_at = time.time()

        system_prompt = self._build_merge_system_prompt(req.locale)
        user_prompt = self._build_merge_user_prompt(req)

        parsed = self.llm.generate_json(
            system_prompt=system_prompt, user_prompt=user_prompt
        )

        valid_evidence_ids = {e.evidence_id for e in req.evidence}

        # Identify eligible speakers from stats (exclude interviewer + zero-talk)
        interviewer_keys = self._identify_interviewer_keys(req)
        eligible_keys = {
            s.speaker_key
            for s in req.final_stats
            if s.speaker_key not in interviewer_keys
            and (s.speaker_name or "") not in interviewer_keys
            and s.talk_time_ms > 0
        }

        overall, per_person = self._parse_merge_output(
            parsed, valid_evidence_ids, eligible_keys, req.locale
        )

        per_person = [p for p in per_person if p.person_key in eligible_keys]
        if not per_person:
            raise ValidationError("No eligible speakers after merge post-filter")

        elapsed_ms = int((time.time() - started_at) * 1000)
        claim_count = 0
        needs_evidence = 0
        for person in per_person:
            for dim in person.dimensions:
                for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                    claim_count += 1
                    if not claim.evidence_refs:
                        needs_evidence += 1

        quality = ReportQualityMeta(
            generated_at=__import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ).isoformat(),
            build_ms=elapsed_ms,
            claim_count=claim_count,
            needs_evidence_count=needs_evidence,
            report_source="llm_synthesized",
            synthesis_context=SynthesisContextMeta(
                rubric_used=False,
                free_notes_used=False,
                historical_sessions_count=0,
                name_bindings_count=0,
                stages_count=0,
                transcript_tokens_approx=0,
                transcript_truncated=False,
            ),
        )

        return AnalysisReportResponse(
            session_id=req.session_id,
            overall=overall,
            per_person=per_person,
            quality=quality,
        )

    @staticmethod
    def _identify_interviewer_keys(req: MergeCheckpointsRequest) -> set[str]:
        """Identify interviewer keys from checkpoint speaker notes and stats."""
        interviewer_keys: set[str] = set()
        # Stats with speaker_key containing "teacher" or "interviewer"
        for s in req.final_stats:
            name = (s.speaker_name or "").lower()
            key = s.speaker_key.lower()
            if "teacher" in key or "interviewer" in name or "teacher" in name:
                interviewer_keys.add(s.speaker_key)
                if s.speaker_name:
                    interviewer_keys.add(s.speaker_name)
        return interviewer_keys

    @staticmethod
    def _build_checkpoint_system_prompt(locale: str) -> str:
        locale_hint = "Chinese (zh-CN)" if locale == "zh-CN" else "English"
        return (
            "You are an expert interview analyst. Analyze this 5-minute segment of an interview.\n\n"
            "RULES:\n"
            "1. Identify key observations about each speaker's behavior.\n"
            "2. Note any dimension signals (leadership, collaboration, logic, structure, initiative).\n"
            "3. Keep observations concise — 1-2 sentences each.\n"
            "4. Focus on concrete behaviors, not general impressions.\n"
            "5. Only analyze interviewee speakers (stream_role: 'students'), not the interviewer.\n\n"
            "OUTPUT FORMAT: Strict JSON:\n"
            "{\n"
            '  "summary": "Brief 1-2 sentence summary of this segment",\n'
            '  "per_speaker_notes": [{"speaker_key": "...", "observations": ["..."]}],\n'
            '  "dimension_signals": [{"dimension": "leadership|collaboration|logic|structure|initiative", '
            '"speaker_key": "...", "signal": "positive|negative|neutral", "note": "..."}]\n'
            "}\n\n"
            f"LANGUAGE: {locale_hint}\n"
        )

    @staticmethod
    def _build_checkpoint_user_prompt(req: CheckpointRequest) -> str:
        utterances = [
            {
                "speaker_name": u.speaker_name,
                "stream_role": u.stream_role,
                "text": u.text[:400],
                "start_ms": u.start_ms,
                "end_ms": u.end_ms,
            }
            for u in req.utterances
        ]

        memos = [
            {"text": m.text[:300], "type": m.type, "tags": m.tags}
            for m in req.memos
        ]

        stats = [
            {
                "speaker_key": s.speaker_key,
                "speaker_name": s.speaker_name,
                "talk_time_ms": s.talk_time_ms,
                "turns": s.turns,
            }
            for s in req.stats
        ]

        prompt_data = {
            "task": "analyze_checkpoint",
            "session_id": req.session_id,
            "checkpoint_index": req.checkpoint_index,
            "utterances": utterances,
            "memos": memos,
            "stats": stats,
        }
        return json.dumps(prompt_data, ensure_ascii=False)

    @staticmethod
    def _parse_checkpoint_output(
        parsed: dict,
        session_id: str,
        checkpoint_index: int,
        timestamp_ms: int,
    ) -> CheckpointResponse:
        summary = str(parsed.get("summary", "")).strip()

        per_speaker_notes = []
        for note_raw in parsed.get("per_speaker_notes", []):
            if not isinstance(note_raw, dict):
                continue
            speaker_key = str(note_raw.get("speaker_key", "")).strip()
            if not speaker_key:
                continue
            observations = [
                str(o).strip()
                for o in note_raw.get("observations", [])
                if str(o).strip()
            ]
            per_speaker_notes.append(
                CheckpointSpeakerNote(
                    speaker_key=speaker_key,
                    observations=observations[:5],
                )
            )

        dimension_signals = []
        for sig_raw in parsed.get("dimension_signals", []):
            if not isinstance(sig_raw, dict):
                continue
            dim = str(sig_raw.get("dimension", "")).strip()
            if dim not in DIMENSIONS:
                continue
            speaker_key = str(sig_raw.get("speaker_key", "")).strip()
            signal = str(sig_raw.get("signal", "neutral")).strip()
            if signal not in ("positive", "negative", "neutral"):
                signal = "neutral"
            note = str(sig_raw.get("note", "")).strip()
            dimension_signals.append(
                CheckpointDimensionSignal(
                    dimension=dim,
                    speaker_key=speaker_key,
                    signal=signal,
                    note=note[:300],
                )
            )

        return CheckpointResponse(
            session_id=session_id,
            checkpoint_index=checkpoint_index,
            timestamp_ms=timestamp_ms,
            summary=summary[:500],
            per_speaker_notes=per_speaker_notes,
            dimension_signals=dimension_signals[:20],
        )

    @staticmethod
    def _build_merge_system_prompt(locale: str) -> str:
        locale_hint = "Chinese (zh-CN)" if locale == "zh-CN" else "English"
        return (
            "You are an expert interview analyst generating a final structured feedback report.\n\n"
            "You are given checkpoint summaries from multiple 5-minute windows of an interview, "
            "plus final statistics and evidence references.\n\n"
            "CRITICAL RULES:\n"
            "1. Every claim MUST cite 1-5 evidence references using evidence_id values from the evidence list.\n"
            "2. DO NOT invent evidence IDs — only use IDs from the evidence list provided.\n"
            "3. Synthesize observations across ALL checkpoints to form holistic assessments.\n"
            "4. Only generate feedback for INTERVIEWEES, NOT the interviewer.\n"
            "5. For each interviewee, evaluate ALL 5 dimensions.\n"
            "6. Use checkpoint observations + evidence to build claims with proper citations.\n"
            "7. For dimensions with weak evidence, generate ONE claim with low confidence (0.3-0.4).\n"
            "8. MINIMUM OUTPUT: For each person, generate at least 1 strength and 1 risk across all dimensions.\n\n"
            "OUTPUT FORMAT: Strict JSON matching the output_contract.\n"
            f"LANGUAGE: {locale_hint}\n"
        )

    @staticmethod
    def _build_merge_user_prompt(req: MergeCheckpointsRequest) -> str:
        checkpoints = []
        for cp in req.checkpoints:
            checkpoints.append({
                "checkpoint_index": cp.checkpoint_index,
                "timestamp_ms": cp.timestamp_ms,
                "summary": cp.summary,
                "per_speaker_notes": [
                    {"speaker_key": n.speaker_key, "observations": n.observations}
                    for n in cp.per_speaker_notes
                ],
                "dimension_signals": [
                    {
                        "dimension": s.dimension,
                        "speaker_key": s.speaker_key,
                        "signal": s.signal,
                        "note": s.note,
                    }
                    for s in cp.dimension_signals
                ],
            })

        evidence_pack = [
            {
                "evidence_id": e.evidence_id,
                "speaker_key": e.speaker_key,
                "time_range_ms": e.time_range_ms,
                "quote": e.quote[:400],
            }
            for e in req.evidence
        ]

        stats = [
            {
                "speaker_key": s.speaker_key,
                "speaker_name": s.speaker_name,
                "talk_time_ms": s.talk_time_ms,
                "turns": s.turns,
            }
            for s in req.final_stats
        ]

        memos = [
            {"text": m.text[:300], "type": m.type, "tags": m.tags}
            for m in req.final_memos
        ]

        prompt_data = {
            "task": "merge_checkpoints",
            "session_id": req.session_id,
            "checkpoints": checkpoints,
            "evidence_pack": evidence_pack,
            "final_stats": stats,
            "final_memos": memos,
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
                                "strengths": [{"claim_id": "c_{person}_{dim}_{nn}", "text": "string", "evidence_refs": ["e_XXXXX"], "confidence": 0.7}],
                                "risks": [{"claim_id": "...", "text": "...", "evidence_refs": ["..."], "confidence": 0.7}],
                                "actions": [{"claim_id": "...", "text": "...", "evidence_refs": ["..."], "confidence": 0.7}],
                            }
                        ],
                        "summary": {"strengths": ["string"], "risks": ["string"], "actions": ["string"]},
                    }
                ],
            },
        }
        return json.dumps(prompt_data, ensure_ascii=False)

    @staticmethod
    def _parse_merge_output(
        parsed: dict,
        valid_evidence_ids: set[str],
        eligible_keys: set[str],
        locale: str,
    ) -> tuple[OverallFeedback, list[PersonFeedbackItem]]:
        """Parse merge LLM output — same structure as synthesize output."""
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
            if eligible_keys and person_key not in eligible_keys:
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

                dimensions.append(
                    DimensionFeedback(
                        dimension=dim_name,
                        strengths=strengths,
                        risks=risks_list,
                        actions=actions,
                    )
                )

            # Ensure all 5 dimensions present
            present_dims = {d.dimension for d in dimensions}
            for dim_name in DIMENSIONS:
                if dim_name not in present_dims:
                    dimensions.append(
                        DimensionFeedback(dimension=dim_name, strengths=[], risks=[], actions=[])
                    )

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
            raise ValidationError("Merge LLM output has no per_person data")

        return overall, per_person
