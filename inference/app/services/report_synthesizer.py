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
    DimensionPreset,
    KeyFinding,
    OverallFeedback,
    PersonFeedbackItem,
    PersonSummary,
    ReportQualityMeta,
    SuggestedDimension,
    SummarySection,
    SynthesisContextMeta,
    SynthesizeReportRequest,
    TeamDynamics,
    TranscriptUtterance,
)
from app.services.dashscope_llm import DashScopeLLM

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

    def __init__(self, llm: DashScopeLLM):
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
    ) -> list:
        """Filter out interviewer, unresolved clusters, and speakers with no evidence.

        A speaker is eligible if:
        - Not the interviewer, AND
        - Has a display name (speaker_name) OR is mentioned in memos, AND
        - Has talk_time > 0 OR is mentioned in memos/bindings.

        Unresolved clusters (e.g. c1, c2) have no speaker_name and aren't in memos.
        """
        _memo_keys = memo_mentioned_keys or set()
        eligible = []
        for s in stats:
            if s.speaker_key in interviewer_keys:
                continue
            if (s.speaker_name or "") in interviewer_keys:
                continue
            # Skip unresolved clusters: no display name AND not mentioned in memos
            has_name = bool(s.speaker_name)
            in_memos = s.speaker_key in _memo_keys or (s.speaker_name or "") in _memo_keys
            if not has_name and not in_memos:
                continue
            # Must have talk time or be mentioned in memos
            if s.talk_time_ms > 0 or in_memos:
                eligible.append(s)
        return eligible

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
            req.transcript, max_tokens=6000
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
        eligible_keys = {
            s.speaker_key for s in self._filter_eligible_speakers(
                req.stats, interviewer_keys, memo_mentioned_keys
            )
        }
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
        if not per_person:
            raise ValidationError("No eligible speakers after post-LLM filter")

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
            + "CRITICAL RULES:\n"
            "1. Every claim MUST cite 1-5 evidence references using the evidence_id values from the evidence_pack.\n"
            "2. DO NOT invent evidence IDs — only use IDs from the evidence_pack.\n"
            "3. Cross-reference the interviewer's memos and free-form notes with the actual transcript.\n"
            "4. If a memo says someone showed a skill — find the specific transcript moment and cite it.\n"
            "5. If memo observations conflict with transcript evidence, flag the discrepancy.\n"
            "6. Only generate feedback for INTERVIEWEES (stream_role: \"students\"), NOT the interviewer (stream_role: \"teacher\"). The interviewer's role is to observe and take notes, not to be evaluated.\n"
            "7. 使用 `session_context.dimension_presets` 作为评估框架。对每个预设维度分配 0-10 分。\n"
            "8. For dimensions with weak evidence, generate ONE claim with low confidence (0.3-0.4) rather than empty arrays. Only use empty arrays if truly ZERO mentions exist.\n"
            "9. Group observations by interview stage when stage data is available.\n"
            "10. Use the free-form notes AND structured memos as primary evidence sources alongside transcript quotes.\n"
            "11. If a person has talk_time_ms of 0 AND has no evidence or memos mentioning them, skip them entirely — do not generate per_person entry for them.\n"
            "12. Ground every claim in evidence. Use evidence_pack quotes, memos, and transcript as sources. A memo like 'Tina gave good suggestions' IS valid evidence for a Tina leadership claim.\n"
            "13. Set confidence below 0.4 for any claim based on a single piece of evidence.\n"
            "14. Memos and free-form notes from the interviewer are FIRST-CLASS evidence sources — they should be cited and referenced just like transcript quotes.\n"
            "15. IMPORTANT: Match evidence to speakers by reading the quote TEXT content. If an evidence quote mentions a person by name (e.g., 'Tina gave a good suggestion about X'), that evidence is attributable to that person. Use the speaker_key field AND the quote text together to determine attribution.\n"
            "16. Even if a person has low talk_time_ms, generate claims for them if memos or evidence mention their contributions.\n"
            "17. MINIMUM OUTPUT: For each person in interviewee_stats, you MUST generate at least 1 strength claim and 1 risk claim across all dimensions combined. A report with all empty claim arrays is INVALID.\n"
            "18. CRITICAL: If name_aliases are provided, treat aliases as the SAME person. "
            "For example, if name_aliases = {\"Rice\": [\"小米\"], \"Stephenie\": [\"思涵\"]}, then 小米 IS Rice and 思涵 IS Stephenie. "
            "Merge all observations about an alias into the primary name's per_person entry. Use the primary name as person_key. "
            "Do NOT create separate per_person entries for aliases. When writing text, always use the primary English name.\n"
            "19. For each claim, also select 1-3 transcript segments that best support the claim. "
            "Output as `supporting_utterances: [utterance_id, ...]` in each claim object. "
            "Prefer segments containing key arguments, specific examples, or behavioral evidence.\n"
            "20. 生成 `narrative`（2-4 句连贯段落）+ ≥3 个 `key_findings`（类型: strength/risk/observation）。\n"
            "21. Use stats_observations (if provided) to enrich analysis with quantitative insights. "
            "Incorporate relevant statistics into claims naturally.\n"
            "22. claim.text 必须是纯自然语言 — 不要在文本中嵌入 [e_XXXXX] 引用。引用放在 evidence_refs 数组中。\n"
            "23. 优先使用 tier_1 证据（面试者发言）。tier_3（面试官评价性发言）仅作为补充佐证。\n"
            "24. 生成 `overall.narrative` 作为围绕 `session_context.position_title` 的连贯段落，不要使用要点列表。\n"
            "25. 如果某个预设维度无法评估（证据完全不足），设置 `not_applicable: true` 和 `score: 5`。\n"
            "26. 如果面试内容暗示需要预设之外的维度，输出 `suggested_dimensions`。\n\n"
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
        eligible_stats = self._filter_eligible_speakers(
            req.stats, interviewer_keys, memo_mentioned_keys
        )

        # Only show named speakers in all_stats to avoid LLM creating entries for cluster IDs
        stats = [
            {
                "speaker_key": s.speaker_key,
                "speaker_name": s.speaker_name,
                "talk_time_ms": s.talk_time_ms,
                "turns": s.turns,
            }
            for s in req.stats
            if s.speaker_name
        ]

        interviewee_stats = [
            {
                "speaker_key": s.speaker_key,
                "speaker_name": s.speaker_name,
                "talk_time_ms": s.talk_time_ms,
                "turns": s.turns,
            }
            for s in eligible_stats
        ]

        # Get dimension presets
        dim_presets = _get_dimension_presets_dicts(req)

        # Build output contract (v2 with scores and narrative)
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
        eligible_stats = self._filter_eligible_speakers(
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
        except Exception:
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
