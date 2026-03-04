from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone

from app.exceptions import ValidationError
from app.schemas import (
    AnalysisReportResponse,
    DimensionClaim,
    DimensionFeedback,
    InterviewQuality,
    KeyFinding,
    OverallFeedback,
    PersonFeedbackItem,
    PersonSummary,
    QuestionAnalysis,
    Recommendation,
    ReportQualityMeta,
    SuggestedDimension,
    SummarySection,
    SynthesisContextMeta,
    SynthesizeReportRequest,
    TeamDynamics,
    TranscriptUtterance,
)
from app.services.backends.llm_dashscope import DashScopeLLMAdapter

logger = logging.getLogger(__name__)

# Legacy default dimensions (used when no dimension_presets provided)
DIMENSIONS = ["leadership", "collaboration", "logic", "structure", "initiative"]

# Default dimension presets with Chinese labels and guidance
DEFAULT_DIMENSION_PRESETS: list[dict] = [
    {"key": "leadership", "label_zh": "领导力", "description": "展现领导力、主动推进讨论、统筹全局的能力"},
    {"key": "collaboration", "label_zh": "协作能力", "description": "团队合作、倾听他人、建设性互动的能力"},
    {"key": "logic", "label_zh": "逻辑思维", "description": "分析问题、推理论证、逻辑清晰度"},
    {"key": "structure", "label_zh": "结构化表达", "description": "表达条理性、信息组织能力、框架化思维"},
    {"key": "initiative", "label_zh": "主动性", "description": "主动提出方案、积极参与、展现进取心"},
]


def _get_dimension_keys(req: SynthesizeReportRequest) -> list[str]:
    """Get dimension keys from session_context.dimension_presets or defaults."""
    if (
        req.session_context
        and req.session_context.dimension_presets
        and len(req.session_context.dimension_presets) > 0
    ):
        return [d.key for d in req.session_context.dimension_presets]
    return DIMENSIONS


def _get_dimension_presets_dicts(req: SynthesizeReportRequest) -> list[dict]:
    """Get dimension presets as dicts from session_context or defaults."""
    if (
        req.session_context
        and req.session_context.dimension_presets
        and len(req.session_context.dimension_presets) > 0
    ):
        return [
            {"key": d.key, "label_zh": d.label_zh, "description": d.description}
            for d in req.session_context.dimension_presets
        ]
    return list(DEFAULT_DIMENSION_PRESETS)


class ReportSynthesizer:
    """LLM-core report generation with deep citations."""

    def __init__(self, llm: DashScopeLLMAdapter):
        self.llm = llm

    @staticmethod
    def _identify_interviewer_keys(req: SynthesizeReportRequest) -> set[str]:
        """Identify speaker keys that belong to the interviewer (teacher).

        Uses two signals:
        1. Transcript utterances with stream_role='teacher' -> their speaker_name
        2. session_context.interviewer_name if provided
        """
        interviewer_keys: set[str] = set()

        # From transcript stream_role
        for u in req.transcript:
            if u.stream_role == "teacher" and u.speaker_name:
                interviewer_keys.add(u.speaker_name)

        # From session context
        if req.session_context and req.session_context.interviewer_name:
            interviewer_keys.add(req.session_context.interviewer_name)

        return interviewer_keys

    @staticmethod
    def _filter_eligible_speakers(
        stats: list, interviewer_keys: set[str],
        memo_mentioned_keys: set[str] | None = None,
    ) -> tuple[list, list]:
        """Returns (active_speakers, zero_turn_speakers).

        active: turns > 0, not interviewer, has name or in memos → sent to LLM
        zero_turn: turns == 0 but in memos → code generates evidence_insufficient

        Unresolved clusters (e.g. c1, c2) have no speaker_name and aren't in memos.
        """
        import re as _re

        _memo_keys = memo_mentioned_keys or set()
        active, zero_turn = [], []
        for s in stats:
            if s.speaker_key in interviewer_keys:
                continue
            if (s.speaker_name or "") in interviewer_keys:
                continue
            # Skip unresolved clusters: no display name AND not mentioned in memos
            has_name = bool(s.speaker_name) and not _re.match(r'^c\d+$', s.speaker_name)
            in_memos = s.speaker_key in _memo_keys or (s.speaker_name or "") in _memo_keys
            if not has_name and not in_memos:
                continue
            if s.turns > 0 and s.talk_time_ms > 0:
                active.append(s)
            elif in_memos:
                zero_turn.append(s)
        return active, zero_turn

    @staticmethod
    def _extract_memo_mentioned_keys(req: SynthesizeReportRequest) -> set[str]:
        """Extract speaker keys mentioned in memos via bindings or text matching."""
        keys: set[str] = set()

        # 1. From explicit memo-speaker bindings
        for binding in req.memo_speaker_bindings:
            keys.update(binding.matched_speaker_keys)

        # 2. Build name→speaker_key lookup (includes aliases)
        name_to_key: dict[str, str] = {}
        for s in req.stats:
            name_to_key[s.speaker_key.lower()] = s.speaker_key
            if s.speaker_name:
                name_to_key[s.speaker_name.lower()] = s.speaker_key

        # 3. Add aliases from name_aliases config
        for primary_name, aliases in req.name_aliases.items():
            # Find speaker_key for the primary name
            target_key: str | None = None
            for s in req.stats:
                if s.speaker_key == primary_name or s.speaker_name == primary_name:
                    target_key = s.speaker_key
                    break
            if target_key:
                for alias in aliases:
                    name_to_key[alias.lower()] = target_key

        # 4. Scan memo text + free_form_notes for matches
        all_text = " ".join(m.text for m in req.memos)
        if req.free_form_notes:
            all_text += " " + req.free_form_notes
        all_text_lower = all_text.lower()

        for name, speaker_key in name_to_key.items():
            if name in all_text_lower:
                keys.add(speaker_key)

        return keys

    @staticmethod
    def _normalize_alias_in_text(text: str, name_aliases: dict[str, list[str]]) -> str:
        """Replace bare alias mentions with 'alias(PrimaryName)' so the LLM
        never misattributes an alias to the wrong person.

        Only replaces aliases that appear as standalone tokens (not already
        followed by the primary name in parentheses).
        """
        import re

        for primary, aliases in name_aliases.items():
            for alias in aliases:
                # Skip if already annotated: alias(PrimaryName)
                pattern = re.compile(
                    re.escape(alias) + r"(?!\s*[\(（]" + re.escape(primary) + r")",
                )
                text = pattern.sub(f"{alias}({primary})", text)
        return text

    @staticmethod
    def _merge_alias_entries(
        per_person: list[PersonFeedbackItem],
        name_aliases: dict[str, list[str]],
    ) -> list[PersonFeedbackItem]:
        """Merge per_person entries whose person_key or display_name matches an alias."""
        # Build alias→primary lookup
        alias_to_primary: dict[str, str] = {}
        for primary, aliases in name_aliases.items():
            for alias in aliases:
                alias_to_primary[alias.lower()] = primary

        # Group entries by resolved primary key
        merged: dict[str, PersonFeedbackItem] = {}
        for p in per_person:
            resolved_key = p.person_key
            # Check if person_key is an alias
            if p.person_key.lower() in alias_to_primary:
                resolved_key = alias_to_primary[p.person_key.lower()]
            # Check if display_name is an alias (LLM might use "unknown" as key but alias as display)
            elif p.display_name.lower() in alias_to_primary:
                resolved_key = alias_to_primary[p.display_name.lower()]

            if resolved_key in merged:
                # Merge dimensions into existing entry
                existing = merged[resolved_key]
                existing_dims = {d.dimension: d for d in existing.dimensions}
                for dim in p.dimensions:
                    if dim.dimension in existing_dims:
                        ed = existing_dims[dim.dimension]
                        ed.strengths.extend(dim.strengths)
                        ed.risks.extend(dim.risks)
                        ed.actions.extend(dim.actions)
                    else:
                        existing.dimensions.append(dim)
            else:
                # Re-key to primary name
                merged[resolved_key] = PersonFeedbackItem(
                    person_key=resolved_key,
                    display_name=resolved_key if resolved_key != p.person_key else p.display_name,
                    dimensions=list(p.dimensions),
                    summary=p.summary,
                )

        return list(merged.values())

    def synthesize(self, req: SynthesizeReportRequest) -> AnalysisReportResponse:
        """Main entry point. LLM synthesizes report from full context.

        On failure, raises the exception directly so the caller (edge worker)
        can invoke its own fallback chain.  The worker already has a three-tier
        fallback: synthesize → analysis/report → memo_first.  An internal
        fallback here would double the latency (two sequential LLM calls) and
        exceed the worker's per-attempt timeout, causing a timeout cascade.
        """
        started_at = time.time()

        # 1. Truncate transcript if needed
        truncated_transcript, was_truncated = self._truncate_transcript(
            req.transcript, max_tokens=4000
        )

        # 2. Build prompts
        system_prompt = self._build_system_prompt(req)
        user_prompt = self._build_user_prompt(req, truncated_transcript)

        # 3. Call LLM
        parsed = self.llm.generate_json(
            system_prompt=system_prompt, user_prompt=user_prompt
        )

        # 4. Parse and validate LLM output (with interviewer filtering)
        valid_evidence_ids = {e.evidence_id for e in req.evidence}
        interviewer_keys = self._identify_interviewer_keys(req)
        memo_mentioned_keys = self._extract_memo_mentioned_keys(req)
        active_speakers, zero_turn_speakers = self._filter_eligible_speakers(
            req.stats, interviewer_keys, memo_mentioned_keys
        )
        eligible_keys = {s.speaker_key for s in active_speakers}
        # DIAG: log raw LLM output shape (defensive — must not crash synthesis)
        try:
            raw_pp = parsed.get("per_person", [])
            if isinstance(raw_pp, list):
                all_stat_keys = [(s.speaker_key, s.speaker_name, s.talk_time_ms) for s in req.stats]
                logger.info("SYNTH-DIAG all_stats=%s eligible_keys=%s raw_per_person_count=%d valid_evidence_ids=%d",
                            all_stat_keys, eligible_keys, len(raw_pp), len(valid_evidence_ids))
                for pp in raw_pp[:2]:
                    if isinstance(pp, dict):
                        pk = pp.get("person_key", "?")
                        dims = pp.get("dimensions", [])
                        if isinstance(dims, list):
                            dim_info = []
                            for d in dims[:2]:
                                if isinstance(d, dict):
                                    dn = d.get("dimension", "?")
                                    s_raw = d.get("strengths", [])
                                    r_raw = d.get("risks", [])
                                    a_raw = d.get("actions", [])
                                    s_count = len(s_raw) if isinstance(s_raw, list) else 0
                                    r_count = len(r_raw) if isinstance(r_raw, list) else 0
                                    a_count = len(a_raw) if isinstance(a_raw, list) else 0
                                    dim_info.append(f"{dn}:S{s_count}R{r_count}A{a_count}")
                                    # Log first claim details if any
                                    for raw_list, label in [(s_raw, "S"), (r_raw, "R"), (a_raw, "A")]:
                                        if isinstance(raw_list, list) and len(raw_list) > 0:
                                            c0 = raw_list[0]
                                            if isinstance(c0, dict):
                                                c_text = str(c0.get("text", ""))[:50]
                                                c_refs = c0.get("evidence_refs", [])
                                                logger.info("SYNTH-DIAG     %s[0]: text=%s refs=%s",
                                                            label, c_text, c_refs)
                            logger.info("SYNTH-DIAG   person=%s dims=%d [%s]", pk, len(dims), " ".join(dim_info))
        except Exception as diag_exc:
            logger.debug("SYNTH-DIAG logging failed: %s", diag_exc)

        dimension_keys = _get_dimension_keys(req)
        dim_presets = _get_dimension_presets_dicts(req)
        dim_label_map = {d["key"]: d["label_zh"] for d in dim_presets}

        overall, per_person = self._parse_llm_output(
            parsed, valid_evidence_ids, locale=req.locale,
            interviewer_keys=interviewer_keys, eligible_keys=eligible_keys,
            dimension_keys=dimension_keys, dim_label_map=dim_label_map,
        )

        # 4b. Merge alias entries back into primary (safety net if LLM ignores instruction)
        if req.name_aliases:
            per_person = self._merge_alias_entries(per_person, req.name_aliases)

        # 4c. Post-LLM safety filter: strip per_person entries not in eligible set
        per_person = [
            p for p in per_person if p.person_key in eligible_keys
        ]

        # 4d. Double insurance: if LLM sneaked zero-turn speakers, clear their claims
        zero_turn_key_set = {s.speaker_key for s in zero_turn_speakers}
        for p in per_person:
            if p.person_key in zero_turn_key_set:
                for dim in p.dimensions:
                    dim.strengths = []
                    dim.risks = []
                    dim.actions = []
                    dim.evidence_insufficient = True
                    dim.score_rationale = "该候选人未在面试中发言，无法评估。"

        # 4e. Generate placeholder entries for zero-turn speakers (not scored)
        for s in zero_turn_speakers:
            per_person.append(PersonFeedbackItem(
                person_key=s.speaker_key,
                display_name=s.speaker_name or s.speaker_key,
                dimensions=[DimensionFeedback(
                    dimension=dk,
                    label_zh=dim_label_map.get(dk, dk),
                    score=0.0,
                    score_rationale="该候选人未在面试中发言，无法评估。",
                    evidence_insufficient=True,
                    not_applicable=True,
                    strengths=[], risks=[], actions=[],
                ) for dk in dimension_keys],
                summary=PersonSummary(strengths=[], risks=[], actions=[]),
            ))

        if not per_person:
            raise ValidationError("No eligible speakers after post-LLM filter")

        # 4f. Unresolved speaker confidence clamp (code-enforced, not prompt-dependent)
        unresolved_keys = {
            s.speaker_key for s in req.stats
            if getattr(s, 'binding_status', 'resolved') == 'unresolved'
        }
        for p in per_person:
            if p.person_key in unresolved_keys:
                for dim in p.dimensions:
                    for claim in dim.strengths + dim.risks + dim.actions:
                        claim.confidence = min(claim.confidence, 0.5)
                    if not dim.score_rationale.startswith("⚠️"):
                        dim.score_rationale = f"⚠️ 身份未确认 — {dim.score_rationale}"

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

    def _build_system_prompt(self, req: SynthesizeReportRequest) -> str:
        locale_hint = "Chinese (zh-CN)" if req.locale == "zh-CN" else "English"

        # Build interview context anchoring
        ctx = req.session_context or {}
        if hasattr(ctx, "model_dump"):
            ctx_dict = ctx.model_dump() if req.session_context else {}
        else:
            ctx_dict = ctx if isinstance(ctx, dict) else {}

        interview_type = ctx_dict.get("interview_type", "未指定") if ctx_dict else "未指定"
        position_title = ctx_dict.get("position_title", "未指定") if ctx_dict else "未指定"
        company_name = ctx_dict.get("company_name", "") if ctx_dict else ""
        interviewer_name = ctx_dict.get("interviewer_name", "未指定") if ctx_dict else "未指定"

        context_anchor = (
            f"你正在为以下面试生成评估报告：\n"
            f"- 面试类型: {interview_type}\n"
            f"- 目标职位/项目: {position_title}"
            f"{' @ ' + company_name if company_name else ''}\n"
            f"- 面试官: {interviewer_name}\n"
            f"\n所有评价必须围绕候选人是否适合「{position_title if position_title != '未指定' else '该职位'}」展开。"
            f"不要给出泛泛的能力评估——每个 claim 都要与目标职位/项目的具体要求关联。\n\n"
        )

        # Build scoring rubric text
        scoring_rubric = (
            "评分标准（0-10 量表）：\n"
            "  0-2: 严重不足 — 缺乏基本能力表现\n"
            "  3-4: 偏弱 — 有零星表现但整体不足\n"
            "  5-6: 基本达标 — 满足基本要求但无亮点\n"
            "  7-8: 良好 — 有明显优势和具体案例支撑\n"
            "  9-10: 优秀 — 表现突出，有多个强有力的证据\n\n"
        )

        return (
            "You are an expert interview analyst generating structured feedback reports.\n\n"
            + context_anchor
            + scoring_rubric
            + "RULES:\n"
            "1. EVIDENCE: Every claim cites 1-5 evidence_ids from evidence_pack only (no invented IDs). "
            "Memos/free-form notes are first-class evidence — cross-reference with transcript. "
            "Match evidence to speakers via speaker_key AND quote text content. "
            "claim.text 必须是纯自然语言，引用放 evidence_refs 数组。优先 tier_1 证据，tier_3 仅作补充。\n"
            "2. CONFIDENCE: Single-evidence claims → confidence < 0.4. Weak-evidence dimensions → ONE claim at 0.3-0.4. "
            "binding_status='unresolved' speakers → ALL claim confidence ≤ 0.5 (code-enforced).\n"
            "3. SCOPE: Only evaluate INTERVIEWEES (stream_role: \"students\"), never the interviewer. "
            "Zero-turn speakers are pre-filtered — do NOT generate entries for speakers not in interviewee_stats. "
            "For each person in interviewee_stats (all have turns > 0), generate ≥1 strength + ≥1 risk claim.\n"
            "4. DIMENSIONS: 使用 dimension_presets 评估框架，每维度 0-10 分。"
            "证据不足设 not_applicable: true + score: 5。如需额外维度，输出 suggested_dimensions。\n"
            "5. ALIASES: name_aliases 中的别名是同一人，合并到 primary name 的 per_person entry（person_key = primary name）。\n"
            "6. CLAIMS: Each claim includes supporting_utterances (1-3 utterance_ids). "
            "Group observations by stage when available. Incorporate stats_observations naturally.\n"
            "7. OVERALL: 生成 narrative（2-4句连贯段落，围绕 position_title）+ ≥3 key_findings。"
            "Memo 与 transcript 矛盾时标注差异。\n"
            "8. RECOMMENDATION: decision (recommend/tentative/not_recommend), confidence (0-1), rationale (中文), context_type.\n"
            "9. QUESTION_ANALYSIS: 每个面试官问题 → question_text, answer_utterance_ids, answer_quality (A/B/C/D), comment, "
            "related_dimensions, scoring_rationale, answer_highlights, answer_weaknesses, suggested_better_answer。\n"
            "10. INTERVIEW_QUALITY: coverage_ratio (0-1), follow_up_depth (int), structure_score (0-10), suggestions (中文).\n\n"
            "OUTPUT FORMAT: Strict JSON matching the output_contract.\n"
            f"LANGUAGE: {locale_hint} — use professional, concise language.\n"
        )

    def _build_user_prompt(
        self,
        req: SynthesizeReportRequest,
        truncated_transcript: list[TranscriptUtterance],
    ) -> str:
        # Build evidence_pack with source_tier
        evidence_pack = []
        for e in req.evidence:
            item: dict = {
                "evidence_id": e.evidence_id,
                "speaker_key": e.speaker_key,
                "time_range_ms": e.time_range_ms,
                "quote": e.quote[:400],
            }
            # Add source_tier: use existing value if available, default to 1
            source_tier = getattr(e, "source_tier", None)
            item["source_tier"] = source_tier if source_tier is not None else 1
            evidence_pack.append(item)

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

        # Pre-normalize alias mentions in memo text so the LLM sees
        # "思涵(Stephenie)" instead of bare "思涵", preventing misattribution.
        normalize = (
            (lambda t: self._normalize_alias_in_text(t, req.name_aliases))
            if req.name_aliases
            else (lambda t: t)
        )

        memos_with_bindings = []
        binding_map = {b.memo_id: b for b in req.memo_speaker_bindings}
        for memo in req.memos:
            entry = {
                "memo_id": memo.memo_id,
                "text": normalize(memo.text),
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

        # Identify interviewer and filter eligible interviewees
        interviewer_keys = self._identify_interviewer_keys(req)
        memo_mentioned_keys = self._extract_memo_mentioned_keys(req)
        active_stats, _zero_turn = self._filter_eligible_speakers(
            req.stats, interviewer_keys, memo_mentioned_keys
        )

        # Only show named speakers in all_stats to avoid LLM creating entries for cluster IDs
        def _has_valid_name(s) -> bool:
            return bool(s.speaker_name) and not re.match(r'^c\d+$', s.speaker_name) and s.speaker_name != "unknown"

        stats = [
            {
                "speaker_key": s.speaker_key,
                "speaker_name": s.speaker_name,
                "talk_time_ms": s.talk_time_ms,
                "turns": s.turns,
            }
            for s in req.stats
            if _has_valid_name(s)
        ]

        interviewee_stats = [
            {
                "speaker_key": s.speaker_key,
                "speaker_name": s.speaker_name if _has_valid_name(s) else f"{s.speaker_key} (未确认身份)",
                "talk_time_ms": s.talk_time_ms,
                "turns": s.turns,
                "binding_status": getattr(s, 'binding_status', 'resolved'),
            }
            for s in active_stats  # only active speakers (from P1)
        ]

        # Get dimension presets
        dim_presets = _get_dimension_presets_dicts(req)

        # Build output contract (v2 with scores and narrative + v3 enrichment)
        output_contract = {
            "overall": {
                "narrative": "string — cohesive 2-4 sentence paragraph, NO [e_XXXXX] references",
                "narrative_evidence_refs": ["e_XXXXX"],
                "key_findings": [
                    {
                        "type": "strength|risk|observation",
                        "text": "string — pure text, no citations",
                        "evidence_refs": ["e_XXXXX"],
                    }
                ],
                "suggested_dimensions": [
                    {
                        "key": "string",
                        "label_zh": "string",
                        "reason": "string",
                        "action": "add|replace|mark_not_applicable",
                        "replaces": "string|null",
                    }
                ],
                "recommendation": {
                    "decision": "recommend / tentative / not_recommend",
                    "confidence": 0.85,
                    "rationale": "一句话推荐理由（中文）",
                    "context_type": "hiring",
                },
                "question_analysis": [
                    {
                        "question_text": "面试官的原始问题",
                        "answer_utterance_ids": ["回答的utterance id列表"],
                        "answer_quality": "A/B/C/D",
                        "comment": "回答质量简评（中文，1-2句）",
                        "related_dimensions": ["关联的维度key"],
                        "scoring_rationale": "评分理由（中文，2-3句）",
                        "answer_highlights": ["亮点1：引用候选人具体表述", "亮点2"],
                        "answer_weaknesses": ["不足1：具体缺陷描述", "不足2"],
                        "suggested_better_answer": "改进方向建议（中文，2-3句）",
                    }
                ],
                "interview_quality": {
                    "coverage_ratio": "被有效探查的维度数/总维度数 (0-1)",
                    "follow_up_depth": "面试官有效追问次数 (int)",
                    "structure_score": "0-10",
                    "suggestions": "对面试官的建议（中文，1-2句）",
                },
            },
            "per_person": [
                {
                    "person_key": "string (from stats speaker_key, interviewees only)",
                    "display_name": "string",
                    "dimensions": [
                        {
                            "dimension": "string (from dimension_presets[].key)",
                            "label_zh": "string (from dimension_presets[].label_zh)",
                            "score": 8.5,
                            "score_rationale": "string — 1-2 sentences",
                            "evidence_insufficient": False,
                            "not_applicable": False,
                            "strengths": [
                                {
                                    "claim_id": "c_{person}_{dim}_{nn}",
                                    "text": "string — pure natural language, NO [e_XXXXX]",
                                    "evidence_refs": ["e_XXXXX"],
                                    "confidence": 0.85,
                                    "supporting_utterances": ["utterance_id"],
                                }
                            ],
                            "risks": ["...same structure as strengths..."],
                            "actions": ["...same structure as strengths..."],
                        }
                    ],
                    "summary": {
                        "strengths": ["string"],
                        "risks": ["string"],
                        "actions": ["string"],
                    },
                }
            ],
        }

        prompt_data: dict = {
            "task": "synthesize_report",
            "session_id": req.session_id,
            "transcript_segments": transcript_segments,
            "memos_with_bindings": memos_with_bindings,
            "evidence_pack": evidence_pack,
            "all_stats": stats,
            "interviewee_stats (ONLY generate per_person entries for these speakers)": interviewee_stats,
            "interviewer_keys (DO NOT evaluate these speakers)": list(interviewer_keys),
            "stages": req.stages,
            "evaluation_dimensions": dim_presets,
            "output_contract": output_contract,
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
            sc_dict: dict = {
                "mode": req.session_context.mode,
                "interviewer_name": req.session_context.interviewer_name,
                "position_title": req.session_context.position_title,
            }
            if req.session_context.company_name:
                sc_dict["company_name"] = req.session_context.company_name
            if req.session_context.interview_type:
                sc_dict["interview_type"] = req.session_context.interview_type
            prompt_data["session_context"] = sc_dict

        if req.free_form_notes:
            prompt_data["free_form_notes"] = normalize(req.free_form_notes[:2000])

        if req.name_aliases:
            prompt_data["name_aliases (SAME person, merge into primary name's per_person entry)"] = req.name_aliases

        if req.stats_observations:
            prompt_data["stats_observations"] = req.stats_observations

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
        self, transcript: list[TranscriptUtterance], max_tokens: int = 4000
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
        self, parsed: dict, valid_evidence_ids: set[str], locale: str = "zh-CN",
        interviewer_keys: set[str] | None = None,
        eligible_keys: set[str] | None = None,
        dimension_keys: list[str] | None = None,
        dim_label_map: dict[str, str] | None = None,
    ) -> tuple[OverallFeedback, list[PersonFeedbackItem]]:
        """Parse and validate LLM JSON output into Pydantic models.

        Supports both v2 format (narrative + key_findings + scores) and
        legacy format (summary_sections + team_dynamics) for backward compatibility.
        """
        _dim_keys = dimension_keys or DIMENSIONS
        _dim_label_map = dim_label_map or {}

        # Parse overall
        overall_raw = parsed.get("overall", {})

        # --- v2 fields ---
        narrative = str(overall_raw.get("narrative", "")).strip()
        narrative_evidence_refs = [
            str(r).strip()
            for r in overall_raw.get("narrative_evidence_refs", [])
            if str(r).strip() in valid_evidence_ids
        ]
        key_findings = []
        for kf in overall_raw.get("key_findings", []):
            if not isinstance(kf, dict):
                continue
            kf_type = str(kf.get("type", "observation")).strip()
            if kf_type not in ("strength", "risk", "observation"):
                kf_type = "observation"
            kf_text = str(kf.get("text", "")).strip()
            if not kf_text:
                continue
            kf_refs = [
                str(r).strip()
                for r in kf.get("evidence_refs", [])
                if str(r).strip() in valid_evidence_ids
            ]
            key_findings.append(KeyFinding(type=kf_type, text=kf_text, evidence_refs=kf_refs[:5]))

        suggested_dimensions = []
        for sd in overall_raw.get("suggested_dimensions", []):
            if not isinstance(sd, dict):
                continue
            sd_key = str(sd.get("key", "")).strip()
            if not sd_key:
                continue
            sd_action = str(sd.get("action", "add")).strip()
            if sd_action not in ("add", "replace", "mark_not_applicable"):
                sd_action = "add"
            suggested_dimensions.append(SuggestedDimension(
                key=sd_key,
                label_zh=str(sd.get("label_zh", "")).strip(),
                reason=str(sd.get("reason", "")).strip(),
                action=sd_action,
                replaces=sd.get("replaces"),
            ))

        # --- v3 enrichment fields (optional) ---
        recommendation = None
        rec_raw = overall_raw.get("recommendation")
        if isinstance(rec_raw, dict) and rec_raw.get("decision"):
            rec_decision = str(rec_raw.get("decision", "")).strip()
            if rec_decision in ("recommend", "tentative", "not_recommend"):
                try:
                    rec_conf = float(rec_raw.get("confidence", 0.0))
                    rec_conf = max(0.0, min(1.0, rec_conf))
                except (TypeError, ValueError):
                    rec_conf = 0.0
                recommendation = Recommendation(
                    decision=rec_decision,
                    confidence=rec_conf,
                    rationale=str(rec_raw.get("rationale", "")).strip(),
                    context_type=str(rec_raw.get("context_type", "hiring")).strip(),
                )

        question_analysis = None
        qa_raw = overall_raw.get("question_analysis")
        if isinstance(qa_raw, list) and qa_raw:
            question_analysis = []
            for qa in qa_raw:
                if not isinstance(qa, dict):
                    continue
                q_text = str(qa.get("question_text", "")).strip()
                if not q_text:
                    continue
                answer_ids = [str(uid).strip() for uid in qa.get("answer_utterance_ids", []) if str(uid).strip()]
                quality = str(qa.get("answer_quality", "")).strip().upper()
                if quality not in ("A", "B", "C", "D"):
                    quality = "C"  # Default for unparseable quality grades
                comment = str(qa.get("comment", "")).strip()
                related_dims = [str(d).strip() for d in qa.get("related_dimensions", []) if str(d).strip()]
                scoring_rationale = str(qa.get("scoring_rationale", "")).strip()
                answer_highlights = [str(h).strip() for h in qa.get("answer_highlights", []) if str(h).strip()]
                answer_weaknesses = [str(w).strip() for w in qa.get("answer_weaknesses", []) if str(w).strip()]
                suggested_better_answer = str(qa.get("suggested_better_answer", "")).strip()
                question_analysis.append(QuestionAnalysis(
                    question_text=q_text,
                    answer_utterance_ids=answer_ids,
                    answer_quality=quality,
                    comment=comment,
                    related_dimensions=related_dims,
                    scoring_rationale=scoring_rationale,
                    answer_highlights=answer_highlights,
                    answer_weaknesses=answer_weaknesses,
                    suggested_better_answer=suggested_better_answer,
                ))
            if not question_analysis:
                question_analysis = None

        interview_quality = None
        iq_raw = overall_raw.get("interview_quality")
        if isinstance(iq_raw, dict):
            try:
                cov = float(iq_raw.get("coverage_ratio", 0.0))
                cov = max(0.0, min(1.0, cov))
            except (TypeError, ValueError):
                cov = 0.0
            try:
                fud = int(iq_raw.get("follow_up_depth", 0))
                fud = max(0, fud)
            except (TypeError, ValueError):
                fud = 0
            try:
                ss = float(iq_raw.get("structure_score", 0.0))
                ss = max(0.0, min(10.0, ss))
            except (TypeError, ValueError):
                ss = 0.0
            suggestions = str(iq_raw.get("suggestions", "")).strip()
            interview_quality = InterviewQuality(
                coverage_ratio=cov,
                follow_up_depth=fud,
                structure_score=ss,
                suggestions=suggestions,
            )

        # --- Legacy fields (backward compat) ---
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

        # Fallback: if LLM returned old format (summary_sections) but no narrative,
        # convert summary_sections to narrative
        if not narrative and summary_sections:
            narrative = " ".join(
                " ".join(s.bullets) for s in summary_sections
            )[:2000]
        # Fallback: if no key_findings, generate from team_dynamics
        if not key_findings:
            for h in highlights:
                key_findings.append(KeyFinding(type="strength", text=h, evidence_refs=[]))
            for r in risks:
                key_findings.append(KeyFinding(type="risk", text=r, evidence_refs=[]))

        overall = OverallFeedback(
            narrative=narrative,
            narrative_evidence_refs=narrative_evidence_refs[:10],
            key_findings=key_findings[:10],
            suggested_dimensions=suggested_dimensions[:5],
            recommendation=recommendation,
            question_analysis=question_analysis,
            interview_quality=interview_quality,
            summary_sections=summary_sections[:6],
            team_dynamics=TeamDynamics(highlights=highlights[:6], risks=risks[:6]),
        )

        # Parse per_person (filtering out interviewer and ineligible speakers)
        _interviewer_keys = interviewer_keys or set()
        _eligible_keys = eligible_keys  # None means no filtering
        per_person = []
        for person_raw in parsed.get("per_person", []):
            if not isinstance(person_raw, dict):
                continue
            person_key = str(person_raw.get("person_key", "")).strip()
            display_name = str(person_raw.get("display_name", person_key)).strip()
            if not person_key:
                continue

            # Skip interviewer/teacher
            if person_key in _interviewer_keys or display_name in _interviewer_keys:
                logger.info("Filtering out interviewer %s from per_person output", person_key)
                continue

            # Skip speakers not in eligible set (if filtering is active)
            if _eligible_keys is not None and person_key not in _eligible_keys:
                logger.info("Filtering out ineligible speaker %s from per_person output", person_key)
                continue

            dimensions = []
            for dim_raw in person_raw.get("dimensions", []):
                if not isinstance(dim_raw, dict):
                    continue
                dim_name = str(dim_raw.get("dimension", "")).strip()
                if dim_name not in _dim_keys:
                    continue

                # Parse v2 dimension fields
                label_zh = str(dim_raw.get("label_zh", _dim_label_map.get(dim_name, ""))).strip()
                score = dim_raw.get("score", 5.0)
                try:
                    score = float(score)
                    score = max(0.0, min(10.0, score))
                except (TypeError, ValueError):
                    score = 5.0
                score_rationale = str(dim_raw.get("score_rationale", "")).strip()
                evidence_insufficient = bool(dim_raw.get("evidence_insufficient", False))
                not_applicable = bool(dim_raw.get("not_applicable", False))

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
                        # Extract supporting_utterances (transcript segment IDs)
                        supporting = c.get("supporting_utterances", [])
                        supp_ids = [str(s).strip() for s in supporting if str(s).strip()]
                        # If no valid refs found, keep empty — do NOT auto-fill
                        # with arbitrary evidence (non-deterministic set ordering)
                        claims.append(
                            DimensionClaim(
                                claim_id=cid or f"c_{person_key}_{dim_name}_{len(claims)+1:02d}",
                                text=text,
                                evidence_refs=refs[:5],
                                confidence=conf,
                                supporting_utterances=supp_ids[:3],
                            )
                        )
                    return claims

                strengths = parse_claims(dim_raw.get("strengths", []))
                risks_list = parse_claims(dim_raw.get("risks", []))
                actions = parse_claims(dim_raw.get("actions", []))

                # Allow empty arrays — no placeholder backfill
                dimensions.append(
                    DimensionFeedback(
                        dimension=dim_name,
                        label_zh=label_zh,
                        score=score,
                        score_rationale=score_rationale,
                        evidence_insufficient=evidence_insufficient,
                        not_applicable=not_applicable,
                        strengths=strengths,
                        risks=risks_list,
                        actions=actions,
                    )
                )

            # Ensure all dimension_keys present with empty arrays for missing ones
            present_dims = {d.dimension for d in dimensions}
            for dk in _dim_keys:
                if dk not in present_dims:
                    dimensions.append(
                        DimensionFeedback(
                            dimension=dk,
                            label_zh=_dim_label_map.get(dk, ""),
                            score=5.0,
                            score_rationale="",
                            evidence_insufficient=True,
                            not_applicable=False,
                            strengths=[],
                            risks=[],
                            actions=[],
                        )
                    )

            # Sort dimensions to match preset order
            dim_order = {d: i for i, d in enumerate(_dim_keys)}
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

        # Filter to eligible speakers only
        interviewer_keys = self._identify_interviewer_keys(req)
        memo_mentioned_keys = self._extract_memo_mentioned_keys(req)
        eligible_stats, _zero_turn = self._filter_eligible_speakers(
            req.stats, interviewer_keys, memo_mentioned_keys
        )

        fallback_req = AnalysisReportRequest(
            session_id=req.session_id,
            transcript=req.transcript,
            memos=req.memos,
            stats=req.stats,
            evidence=req.evidence,
            events=req.events,
            locale=req.locale,
        )

        dim_keys = _get_dimension_keys(req)

        try:
            result = fallback_gen.generate(fallback_req)
            # Filter out interviewer from fallback result
            if result.per_person:
                eligible_key_set = {s.speaker_key for s in eligible_stats}
                result.per_person = [
                    p for p in result.per_person
                    if p.person_key not in interviewer_keys
                    and (not eligible_key_set or p.person_key in eligible_key_set)
                ]
        except Exception:  # noqa: BLE001 — fallback report must not crash
            # Even fallback failed — build minimal valid response with empty dimensions
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
                                strengths=[],
                                risks=[],
                                actions=[],
                            )
                            for dim in dim_keys
                        ],
                    )
                    for s in eligible_stats
                ] or [
                    PersonFeedbackItem(
                        person_key="unknown",
                        display_name="unknown",
                        dimensions=[
                            DimensionFeedback(
                                dimension=dim,
                                strengths=[],
                                risks=[],
                                actions=[],
                            )
                            for dim in dim_keys
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
