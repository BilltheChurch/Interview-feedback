import json
import re

import pytest

from app.schemas import (
    AnalysisReportResponse,
    DimensionPreset,
    EvidenceRef,
    Memo,
    MemoSpeakerBinding,
    RubricDimension,
    RubricTemplate,
    SessionContext,
    SpeakerStat,
    StageDescription,
    SynthesizeReportRequest,
    TranscriptUtterance,
)
from app.services.report_synthesizer import ReportSynthesizer


class MockLLMForSynthesis:
    """Returns a valid LLM JSON response matching the v2 output contract."""

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
        return {
            "overall": {
                "narrative": "Alice demonstrated strong system design skills and clear communication throughout the interview. She provided well-structured architecture proposals and handled scaling questions effectively.",
                "narrative_evidence_refs": ["e_000001", "e_000002"],
                "key_findings": [
                    {
                        "type": "strength",
                        "text": "Strong system design fundamentals with layered architecture thinking",
                        "evidence_refs": ["e_000001"],
                    },
                    {
                        "type": "risk",
                        "text": "Limited depth in behavioral questions",
                        "evidence_refs": ["e_000002"],
                    },
                    {
                        "type": "observation",
                        "text": "Communication was clear and well-structured throughout",
                        "evidence_refs": ["e_000001", "e_000002"],
                    },
                ],
                "suggested_dimensions": [
                    {
                        "key": "system_design",
                        "label_zh": "系统设计",
                        "reason": "Interview heavily focused on system architecture",
                        "action": "add",
                        "replaces": None,
                    }
                ],
            },
            "per_person": [
                {
                    "person_key": "Alice",
                    "display_name": "Alice",
                    "dimensions": [
                        {
                            "dimension": "leadership",
                            "label_zh": "领导力",
                            "score": 7.5,
                            "score_rationale": "Alice proactively led the system design discussion with clear structure.",
                            "evidence_insufficient": False,
                            "not_applicable": False,
                            "strengths": [
                                {
                                    "claim_id": "c_Alice_leadership_01",
                                    "text": "Effectively led the system design discussion with clear structure.",
                                    "evidence_refs": ["e_000001", "e_000002"],
                                    "confidence": 0.88,
                                }
                            ],
                            "risks": [
                                {
                                    "claim_id": "c_Alice_leadership_02",
                                    "text": "Could delegate more to other participants.",
                                    "evidence_refs": ["e_000001"],
                                    "confidence": 0.72,
                                }
                            ],
                            "actions": [
                                {
                                    "claim_id": "c_Alice_leadership_03",
                                    "text": "Practice active listening before proposing solutions.",
                                    "evidence_refs": ["e_000002"],
                                    "confidence": 0.75,
                                }
                            ],
                        },
                        {
                            "dimension": "collaboration",
                            "label_zh": "协作能力",
                            "score": 6.0,
                            "score_rationale": "Responded to questions but limited interaction with peers.",
                            "evidence_insufficient": False,
                            "not_applicable": False,
                            "strengths": [
                                {"claim_id": "c_Alice_collab_01", "text": "Responded to interviewer questions.", "evidence_refs": ["e_000001"], "confidence": 0.7}
                            ],
                            "risks": [
                                {"claim_id": "c_Alice_collab_02", "text": "Limited interaction.", "evidence_refs": ["e_000002"], "confidence": 0.65}
                            ],
                            "actions": [
                                {"claim_id": "c_Alice_collab_03", "text": "Acknowledge others.", "evidence_refs": ["e_000001"], "confidence": 0.68}
                            ],
                        },
                        {
                            "dimension": "logic",
                            "label_zh": "逻辑思维",
                            "score": 8.0,
                            "score_rationale": "Clear reasoning throughout with well-connected arguments.",
                            "evidence_insufficient": False,
                            "not_applicable": False,
                            "strengths": [
                                {"claim_id": "c_Alice_logic_01", "text": "Clear reasoning.", "evidence_refs": ["e_000001"], "confidence": 0.8}
                            ],
                            "risks": [
                                {"claim_id": "c_Alice_logic_02", "text": "Missing edge cases.", "evidence_refs": ["e_000002"], "confidence": 0.7}
                            ],
                            "actions": [
                                {"claim_id": "c_Alice_logic_03", "text": "Consider edge cases.", "evidence_refs": ["e_000001"], "confidence": 0.72}
                            ],
                        },
                        {
                            "dimension": "structure",
                            "label_zh": "结构化表达",
                            "score": 7.0,
                            "score_rationale": "Well organized but could improve time management.",
                            "evidence_insufficient": False,
                            "not_applicable": False,
                            "strengths": [
                                {"claim_id": "c_Alice_struct_01", "text": "Well organized.", "evidence_refs": ["e_000001"], "confidence": 0.82}
                            ],
                            "risks": [
                                {"claim_id": "c_Alice_struct_02", "text": "Time management.", "evidence_refs": ["e_000002"], "confidence": 0.68}
                            ],
                            "actions": [
                                {"claim_id": "c_Alice_struct_03", "text": "Use timeboxing.", "evidence_refs": ["e_000001"], "confidence": 0.7}
                            ],
                        },
                        {
                            "dimension": "initiative",
                            "label_zh": "主动性",
                            "score": 6.5,
                            "score_rationale": "Proactive in proposing ideas but slow on follow-through.",
                            "evidence_insufficient": False,
                            "not_applicable": False,
                            "strengths": [
                                {"claim_id": "c_Alice_init_01", "text": "Proactive.", "evidence_refs": ["e_000001"], "confidence": 0.78}
                            ],
                            "risks": [
                                {"claim_id": "c_Alice_init_02", "text": "Late on action items.", "evidence_refs": ["e_000002"], "confidence": 0.65}
                            ],
                            "actions": [
                                {"claim_id": "c_Alice_init_03", "text": "Propose next steps earlier.", "evidence_refs": ["e_000001"], "confidence": 0.7}
                            ],
                        },
                    ],
                    "summary": {
                        "strengths": ["Strong system design skills"],
                        "risks": ["Time management needs improvement"],
                        "actions": ["Practice structured responses"],
                    },
                }
            ],
        }


class MockLLMLegacyFormat:
    """Returns a legacy LLM JSON response (summary_sections + team_dynamics, no narrative)."""

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
        return {
            "overall": {
                "summary_sections": [
                    {
                        "topic": "Interview Summary",
                        "bullets": [
                            "Alice demonstrated strong system design skills.",
                            "Communication was clear and structured.",
                        ],
                        "evidence_ids": ["e_000001", "e_000002"],
                    }
                ],
                "team_dynamics": {
                    "highlights": ["Strong leadership from Alice"],
                    "risks": ["Limited depth in behavioral questions"],
                },
            },
            "per_person": [
                {
                    "person_key": "Alice",
                    "display_name": "Alice",
                    "dimensions": [
                        {
                            "dimension": "leadership",
                            "strengths": [
                                {
                                    "claim_id": "c_Alice_leadership_01",
                                    "text": "Effectively led the system design discussion with clear structure.",
                                    "evidence_refs": ["e_000001", "e_000002"],
                                    "confidence": 0.88,
                                }
                            ],
                            "risks": [
                                {
                                    "claim_id": "c_Alice_leadership_02",
                                    "text": "Could delegate more to other participants.",
                                    "evidence_refs": ["e_000001"],
                                    "confidence": 0.72,
                                }
                            ],
                            "actions": [
                                {
                                    "claim_id": "c_Alice_leadership_03",
                                    "text": "Practice active listening before proposing solutions.",
                                    "evidence_refs": ["e_000002"],
                                    "confidence": 0.75,
                                }
                            ],
                        },
                        {
                            "dimension": "collaboration",
                            "strengths": [
                                {"claim_id": "c_Alice_collab_01", "text": "Responded well.", "evidence_refs": ["e_000001"], "confidence": 0.7}
                            ],
                            "risks": [],
                            "actions": [],
                        },
                        {
                            "dimension": "logic",
                            "strengths": [
                                {"claim_id": "c_Alice_logic_01", "text": "Clear reasoning.", "evidence_refs": ["e_000001"], "confidence": 0.8}
                            ],
                            "risks": [],
                            "actions": [],
                        },
                        {
                            "dimension": "structure",
                            "strengths": [],
                            "risks": [],
                            "actions": [],
                        },
                        {
                            "dimension": "initiative",
                            "strengths": [],
                            "risks": [],
                            "actions": [],
                        },
                    ],
                    "summary": {
                        "strengths": ["Good leader"],
                        "risks": [],
                        "actions": [],
                    },
                }
            ],
        }


def _build_test_request() -> SynthesizeReportRequest:
    return SynthesizeReportRequest(
        session_id="s-synth-test",
        transcript=[
            TranscriptUtterance(
                utterance_id="u1",
                stream_role="students",
                speaker_name="Alice",
                cluster_id="c1",
                text="Let me start by outlining the system architecture. We need a load balancer, application servers, and a database layer.",
                start_ms=0,
                end_ms=8000,
                duration_ms=8000,
                decision="auto",
            ),
            TranscriptUtterance(
                utterance_id="u2",
                stream_role="teacher",
                speaker_name="Interviewer",
                text="How would you handle scaling?",
                start_ms=8500,
                end_ms=10000,
                duration_ms=1500,
                decision="auto",
            ),
        ],
        memos=[
            Memo(
                memo_id="m1",
                created_at_ms=4000,
                type="observation",
                tags=["structure"],
                text="Alice\u7684\u67b6\u6784\u9610\u8ff0\u6e05\u6670\uff0c\u6709\u5206\u5c42\u601d\u7ef4",
                stage="Q1: System Design",
                stage_index=1,
            ),
        ],
        evidence=[
            EvidenceRef(
                evidence_id="e_000001",
                time_range_ms=[0, 8000],
                utterance_ids=["u1"],
                speaker_key="Alice",
                quote="Let me start by outlining the system architecture.",
                confidence=0.85,
            ),
            EvidenceRef(
                evidence_id="e_000002",
                time_range_ms=[8500, 10000],
                utterance_ids=["u2"],
                speaker_key="Interviewer",
                quote="How would you handle scaling?",
                confidence=0.80,
            ),
        ],
        stats=[
            SpeakerStat(speaker_key="Alice", speaker_name="Alice", talk_time_ms=8000, turns=1),
            SpeakerStat(speaker_key="Interviewer", speaker_name="Interviewer", talk_time_ms=1500, turns=1),
        ],
        events=[],
        stages=["Intro", "Q1: System Design"],
    )


def test_synthesize_returns_valid_report() -> None:
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)
    assert result.session_id == "s-synth-test"
    assert len(result.per_person) >= 1
    assert result.per_person[0].person_key == "Alice"
    assert len(result.per_person[0].dimensions) == 5
    assert result.quality is not None
    assert result.quality.report_source == "llm_synthesized"


def test_synthesize_validates_evidence_refs() -> None:
    """Evidence refs in LLM output must match evidence pack IDs."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)
    valid_ids = {e.evidence_id for e in req.evidence}
    for person in result.per_person:
        for dim in person.dimensions:
            for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                for ref in claim.evidence_refs:
                    assert ref in valid_ids, f"Invalid evidence ref {ref}"


def test_synthesize_quality_meta_has_synthesis_context() -> None:
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    req.rubric = RubricTemplate(
        template_name="Tech",
        dimensions=[RubricDimension(name="Design")],
    )
    req.free_form_notes = "Good overall."
    result = synthesizer.synthesize(req)
    assert result.quality is not None
    assert result.quality.synthesis_context is not None
    assert result.quality.synthesis_context.rubric_used is True
    assert result.quality.synthesis_context.free_notes_used is True
    assert result.quality.synthesis_context.stages_count == 2


def test_truncate_transcript_short_input() -> None:
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    transcript = [
        TranscriptUtterance(
            utterance_id="u1",
            stream_role="students",
            speaker_name="Alice",
            text="Short message",
            start_ms=0,
            end_ms=1000,
            duration_ms=1000,
        )
    ]
    truncated, was_truncated = synthesizer._truncate_transcript(transcript, max_tokens=6000)
    assert was_truncated is False
    assert len(truncated) == 1


def test_truncate_transcript_long_input() -> None:
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    # Create 200 utterances (way over token limit)
    transcript = [
        TranscriptUtterance(
            utterance_id=f"u{i}",
            stream_role="students",
            speaker_name="Alice",
            text=f"This is utterance number {i} with some content to pad the length a bit more. " * 5,
            start_ms=i * 3000,
            end_ms=(i + 1) * 3000,
            duration_ms=3000,
        )
        for i in range(200)
    ]
    truncated, was_truncated = synthesizer._truncate_transcript(transcript, max_tokens=6000)
    assert was_truncated is True
    assert len(truncated) < 200


class FailingLLM:
    def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
        raise Exception("LLM unavailable")


def test_synthesize_raises_on_llm_failure() -> None:
    """Synthesize endpoint should raise on LLM failure (no internal fallback).
    The worker handles the fallback chain: synthesize → report → memo_first."""
    synthesizer = ReportSynthesizer(llm=FailingLLM())
    req = _build_test_request()
    with pytest.raises(Exception):
        synthesizer.synthesize(req)


# ── New tests for P0/P1 fixes ──────────────────────────────────────────────


def test_multi_person_llm_failure_raises() -> None:
    """LLM failure in synthesize should raise — worker handles fallback."""

    class AlwaysFailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("boom")

    synthesizer = ReportSynthesizer(llm=AlwaysFailingLLM())
    req = _build_test_request()
    assert len(req.stats) == 2

    with pytest.raises(RuntimeError, match="boom"):
        synthesizer.synthesize(req)


def test_no_evidence_ref_is_none_in_success_output() -> None:
    """No claim in successful synthesis should contain evidence_refs=['none']."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    for person in result.per_person:
        for dim in person.dimensions:
            for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                assert "none" not in claim.evidence_refs, (
                    f"Found 'none' in evidence_refs for claim {claim.claim_id}"
                )


def test_no_pending_assessment_dummy_text() -> None:
    """No claim text should contain placeholder dummy text like
    'Pending assessment.' or 'Assessment pending.'"""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    for person in result.per_person:
        for dim in person.dimensions:
            for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                assert "Pending assessment" not in claim.text, (
                    f"Dummy text found in claim {claim.claim_id}: {claim.text}"
                )
                assert "Assessment pending" not in claim.text, (
                    f"Dummy text found in claim {claim.claim_id}: {claim.text}"
                )


def test_no_pending_assessment_in_success_output() -> None:
    """Successful synthesis should not contain 'Pending assessment.' dummy text."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    for person in result.per_person:
        for dim in person.dimensions:
            for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                assert "Pending assessment" not in claim.text
                assert "Assessment pending" not in claim.text


def test_chinese_token_counting() -> None:
    """CJK-aware token estimation: 100 Chinese chars should produce ~150
    tokens, not 1 (which is what text.split() would yield for a single
    unspaced Chinese string)."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    chinese_text = "这" * 100
    estimate = synthesizer._estimate_tokens(chinese_text)
    # 100 chars * 1.5 = 150
    assert estimate == 150, f"Expected 150, got {estimate}"

    # Verify English still works reasonably
    english_text = "hello world " * 50  # 100 words
    estimate_en = synthesizer._estimate_tokens(english_text)
    assert estimate_en >= 100, f"English estimate too low: {estimate_en}"

    # Empty text should return 0
    assert synthesizer._estimate_tokens("") == 0


def test_llm_failure_raises_zh() -> None:
    """LLM failure should raise for zh-CN locale — worker handles fallback."""

    class AlwaysFailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("boom")

    synthesizer = ReportSynthesizer(llm=AlwaysFailingLLM())
    req = _build_test_request()
    req.locale = "zh-CN"
    with pytest.raises(RuntimeError, match="boom"):
        synthesizer.synthesize(req)


def test_llm_failure_raises_en() -> None:
    """LLM failure should raise for en locale — worker handles fallback."""

    class AlwaysFailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("boom")

    synthesizer = ReportSynthesizer(llm=AlwaysFailingLLM())
    req = _build_test_request()
    req.locale = "en"
    with pytest.raises(RuntimeError, match="boom"):
        synthesizer.synthesize(req)


# ── Tests for interviewer filtering and empty dimensions ──────────────────


def test_interviewer_filtered_from_llm_output() -> None:
    """LLM output should not include the interviewer (teacher stream_role)."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    speaker_keys = {p.person_key for p in result.per_person}
    assert "Interviewer" not in speaker_keys, "Interviewer should be filtered out"
    assert "Alice" in speaker_keys, "Alice (interviewee) should be present"


def test_interviewer_filtered_via_session_context() -> None:
    """When session_context.interviewer_name is set, that person should be excluded."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    req.session_context = SessionContext(
        mode="1v1",
        interviewer_name="Interviewer",
    )
    result = synthesizer.synthesize(req)

    speaker_keys = {p.person_key for p in result.per_person}
    assert "Interviewer" not in speaker_keys


def test_zero_talk_time_speaker_filtered() -> None:
    """Speakers with talk_time_ms=0 should be excluded from per_person."""

    class MockLLMWithSilentSpeaker:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            return {
                "overall": {
                    "narrative": "Summary of the interview.",
                    "narrative_evidence_refs": [],
                    "key_findings": [
                        {"type": "observation", "text": "General observation", "evidence_refs": []}
                    ],
                    "suggested_dimensions": [],
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {"dimension": dim, "label_zh": "", "score": 5.0, "strengths": [], "risks": [], "actions": []}
                            for dim in ["leadership", "collaboration", "logic", "structure", "initiative"]
                        ],
                        "summary": {"strengths": [], "risks": [], "actions": []},
                    },
                    {
                        "person_key": "Silent",
                        "display_name": "Silent Person",
                        "dimensions": [
                            {"dimension": dim, "label_zh": "", "score": 5.0, "strengths": [], "risks": [], "actions": []}
                            for dim in ["leadership", "collaboration", "logic", "structure", "initiative"]
                        ],
                        "summary": {"strengths": [], "risks": [], "actions": []},
                    },
                ],
            }

    synthesizer = ReportSynthesizer(llm=MockLLMWithSilentSpeaker())
    req = _build_test_request()
    # Add a silent speaker with 0 talk time
    req.stats.append(SpeakerStat(speaker_key="Silent", speaker_name="Silent Person", talk_time_ms=0, turns=0))
    result = synthesizer.synthesize(req)

    speaker_keys = {p.person_key for p in result.per_person}
    assert "Silent" not in speaker_keys, "Zero talk-time speaker should be filtered out"
    assert "Alice" in speaker_keys


def test_empty_dimension_arrays_allowed() -> None:
    """DimensionFeedback should accept empty strengths/risks/actions arrays."""
    from app.schemas import DimensionFeedback

    dim = DimensionFeedback(dimension="leadership", strengths=[], risks=[], actions=[])
    assert dim.strengths == []
    assert dim.risks == []
    assert dim.actions == []


def test_dimensions_without_evidence_get_empty_arrays() -> None:
    """When LLM returns a dimension with no claims, it should have empty arrays (no placeholders)."""

    class MockLLMPartialDimensions:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            return {
                "overall": {
                    "narrative": "Alice showed leadership potential.",
                    "narrative_evidence_refs": ["e_000001"],
                    "key_findings": [
                        {"type": "strength", "text": "Good leadership", "evidence_refs": ["e_000001"]}
                    ],
                    "suggested_dimensions": [],
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {
                                "dimension": "leadership",
                                "label_zh": "领导力",
                                "score": 7.0,
                                "score_rationale": "Led discussion well.",
                                "strengths": [
                                    {"claim_id": "c_Alice_leadership_01", "text": "Led well.", "evidence_refs": ["e_000001"], "confidence": 0.85}
                                ],
                                "risks": [],
                                "actions": [],
                            },
                            # Other dimensions completely empty
                            {"dimension": "collaboration", "label_zh": "协作能力", "score": 5.0, "strengths": [], "risks": [], "actions": []},
                            {"dimension": "logic", "label_zh": "逻辑思维", "score": 5.0, "strengths": [], "risks": [], "actions": []},
                        ],
                        "summary": {"strengths": ["Good leader"], "risks": [], "actions": []},
                    }
                ],
            }

    synthesizer = ReportSynthesizer(llm=MockLLMPartialDimensions())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    alice = result.per_person[0]
    assert alice.person_key == "Alice"
    # All 5 dimensions should be present
    assert len(alice.dimensions) == 5

    # leadership should have a claim
    leadership = next(d for d in alice.dimensions if d.dimension == "leadership")
    assert len(leadership.strengths) == 1

    # collaboration should have empty arrays (no placeholders)
    collab = next(d for d in alice.dimensions if d.dimension == "collaboration")
    assert collab.strengths == []
    assert collab.risks == []
    assert collab.actions == []

    # structure and initiative (not returned by LLM) should also be empty
    structure = next(d for d in alice.dimensions if d.dimension == "structure")
    assert structure.strengths == []
    initiative = next(d for d in alice.dimensions if d.dimension == "initiative")
    assert initiative.strengths == []


def test_user_prompt_includes_stats_observations() -> None:
    """Stats observations should appear in the user prompt."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    req.stats_observations = ["Tina spoke most (42%)", "Rice spoke least (15%)"]
    truncated, _ = synthesizer._truncate_transcript(req.transcript)
    prompt = synthesizer._build_user_prompt(req, truncated)
    data = json.loads(prompt)
    assert "stats_observations" in data
    assert len(data["stats_observations"]) == 2


def test_system_prompt_includes_supporting_utterances_instruction() -> None:
    """System prompt should instruct LLM to output supporting_utterances."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)
    assert "supporting_utterances" in prompt


def test_system_prompt_requires_minimum_key_findings() -> None:
    """System prompt should require minimum key_findings."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)
    assert "key_findings" in prompt
    assert "narrative" in prompt


def test_transcript_truncation_increased() -> None:
    """Transcript should be truncated at 6000 tokens, not 4000."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    import inspect
    sig = inspect.signature(synthesizer._truncate_transcript)
    max_tokens_default = sig.parameters["max_tokens"].default
    assert max_tokens_default == 6000


def test_supporting_utterances_parsed_from_llm_output() -> None:
    """supporting_utterances from LLM claim output should be parsed into DimensionClaim."""

    class MockLLMWithSupportingUtterances:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            return {
                "overall": {
                    "narrative": "Good interview.",
                    "narrative_evidence_refs": ["e_000001"],
                    "key_findings": [
                        {"type": "strength", "text": "Strong team", "evidence_refs": ["e_000001"]}
                    ],
                    "suggested_dimensions": [],
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {
                                "dimension": "leadership",
                                "label_zh": "领导力",
                                "score": 7.5,
                                "score_rationale": "Led discussion well.",
                                "strengths": [
                                    {
                                        "claim_id": "c_Alice_leadership_01",
                                        "text": "Led the discussion well.",
                                        "evidence_refs": ["e_000001"],
                                        "confidence": 0.85,
                                        "supporting_utterances": ["u1", "u2"],
                                    }
                                ],
                                "risks": [],
                                "actions": [],
                            },
                            *[
                                {"dimension": dim, "label_zh": "", "score": 5.0, "strengths": [], "risks": [], "actions": []}
                                for dim in ["collaboration", "logic", "structure", "initiative"]
                            ],
                        ],
                        "summary": {"strengths": ["Good leader"], "risks": [], "actions": []},
                    }
                ],
            }

    synthesizer = ReportSynthesizer(llm=MockLLMWithSupportingUtterances())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    alice = result.per_person[0]
    leadership = next(d for d in alice.dimensions if d.dimension == "leadership")
    assert len(leadership.strengths) == 1
    claim = leadership.strengths[0]
    assert claim.supporting_utterances == ["u1", "u2"]


def test_claim_without_valid_refs_gets_empty_list() -> None:
    """A claim whose evidence_refs don't match any valid evidence IDs
    should have refs=[] — NOT auto-filled with arbitrary evidence."""

    class MockLLMInvalidRefs:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            return {
                "overall": {
                    "narrative": "Overview.",
                    "narrative_evidence_refs": [],
                    "key_findings": [{"type": "observation", "text": "General", "evidence_refs": []}],
                    "suggested_dimensions": [],
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {
                                "dimension": "leadership",
                                "label_zh": "领导力",
                                "score": 6.0,
                                "strengths": [
                                    {
                                        "claim_id": "c_no_refs_01",
                                        "text": "Good leadership skills.",
                                        "evidence_refs": ["e_NONEXISTENT"],
                                        "confidence": 0.80,
                                    },
                                    {
                                        "claim_id": "c_no_refs_02",
                                        "text": "Clear communication.",
                                        "evidence_refs": [],
                                        "confidence": 0.75,
                                    },
                                ],
                                "risks": [],
                                "actions": [],
                            },
                            *[
                                {"dimension": dim, "label_zh": "", "score": 5.0, "strengths": [], "risks": [], "actions": []}
                                for dim in ["collaboration", "logic", "structure", "initiative"]
                            ],
                        ],
                        "summary": {"strengths": [], "risks": [], "actions": []},
                    }
                ],
            }

    synthesizer = ReportSynthesizer(llm=MockLLMInvalidRefs())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    alice = result.per_person[0]
    leadership = next(d for d in alice.dimensions if d.dimension == "leadership")

    # Both claims should have empty evidence_refs (not auto-filled)
    for claim in leadership.strengths:
        assert claim.evidence_refs == [], (
            f"Claim {claim.claim_id} should have empty refs but got {claim.evidence_refs}"
        )


# ── New v2 tests: scores, narrative, key_findings, suggested_dimensions ───


def test_v2_scores_in_dimensions() -> None:
    """Each dimension should have a score between 0-10."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    alice = result.per_person[0]
    for dim in alice.dimensions:
        assert 0.0 <= dim.score <= 10.0, f"Score {dim.score} out of range for {dim.dimension}"
        assert isinstance(dim.score, float), f"Score should be float for {dim.dimension}"

    # Check specific scores from mock
    leadership = next(d for d in alice.dimensions if d.dimension == "leadership")
    assert leadership.score == 7.5
    assert leadership.score_rationale != ""


def test_v2_score_rationale_present() -> None:
    """Each dimension with score should have a score_rationale."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    alice = result.per_person[0]
    for dim in alice.dimensions:
        if dim.score != 5.0:  # Non-default score should have rationale
            assert dim.score_rationale, f"Missing score_rationale for {dim.dimension}"


def test_v2_overall_narrative() -> None:
    """Overall should have narrative and key_findings."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    assert result.overall.narrative != ""
    assert "Alice" in result.overall.narrative
    assert len(result.overall.narrative_evidence_refs) > 0


def test_v2_key_findings() -> None:
    """Key findings should have type, text, and evidence_refs."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    assert len(result.overall.key_findings) >= 3
    types_found = {kf.type for kf in result.overall.key_findings}
    assert "strength" in types_found
    assert "risk" in types_found

    for kf in result.overall.key_findings:
        assert kf.type in ("strength", "risk", "observation")
        assert kf.text != ""


def test_v2_suggested_dimensions() -> None:
    """Suggested dimensions should be parsed from LLM output."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    assert len(result.overall.suggested_dimensions) >= 1
    sd = result.overall.suggested_dimensions[0]
    assert sd.key == "system_design"
    assert sd.label_zh == "系统设计"
    assert sd.action in ("add", "replace", "mark_not_applicable")


def test_v2_claim_text_no_evidence_references() -> None:
    """Claim text should be pure natural language with no [e_XXXXX] references."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    pattern = re.compile(r"\[e_\w+\]")
    for person in result.per_person:
        for dim in person.dimensions:
            for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                assert not pattern.search(claim.text), (
                    f"Found [e_XXXXX] in claim text: {claim.text}"
                )


def test_v2_not_applicable_dimension() -> None:
    """A dimension marked not_applicable should have score=5 and not_applicable=True."""

    class MockLLMWithNA:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            return {
                "overall": {
                    "narrative": "Overview.",
                    "narrative_evidence_refs": [],
                    "key_findings": [{"type": "observation", "text": "General", "evidence_refs": []}],
                    "suggested_dimensions": [],
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {
                                "dimension": "leadership",
                                "label_zh": "领导力",
                                "score": 5.0,
                                "score_rationale": "Not enough evidence to assess leadership.",
                                "evidence_insufficient": True,
                                "not_applicable": True,
                                "strengths": [],
                                "risks": [],
                                "actions": [],
                            },
                            *[
                                {"dimension": dim, "label_zh": "", "score": 6.0, "strengths": [], "risks": [], "actions": []}
                                for dim in ["collaboration", "logic", "structure", "initiative"]
                            ],
                        ],
                        "summary": {"strengths": [], "risks": [], "actions": []},
                    }
                ],
            }

    synthesizer = ReportSynthesizer(llm=MockLLMWithNA())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    alice = result.per_person[0]
    leadership = next(d for d in alice.dimensions if d.dimension == "leadership")
    assert leadership.not_applicable is True
    assert leadership.evidence_insufficient is True
    assert leadership.score == 5.0


def test_v2_custom_dimension_presets() -> None:
    """When session_context has dimension_presets, use those instead of defaults."""

    custom_dims = [
        {"key": "technical", "label_zh": "技术能力", "description": "技术深度和广度"},
        {"key": "communication", "label_zh": "沟通能力", "description": "表达清晰度和沟通效果"},
        {"key": "teamwork", "label_zh": "团队协作", "description": "团队配合和协作精神"},
    ]

    class MockLLMCustomDims:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            return {
                "overall": {
                    "narrative": "Custom dims overview.",
                    "narrative_evidence_refs": [],
                    "key_findings": [{"type": "observation", "text": "General", "evidence_refs": []}],
                    "suggested_dimensions": [],
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {
                                "dimension": "technical",
                                "label_zh": "技术能力",
                                "score": 8.0,
                                "score_rationale": "Strong technical depth.",
                                "strengths": [
                                    {"claim_id": "c_Alice_technical_01", "text": "Good tech skills.", "evidence_refs": ["e_000001"], "confidence": 0.85}
                                ],
                                "risks": [],
                                "actions": [],
                            },
                            {
                                "dimension": "communication",
                                "label_zh": "沟通能力",
                                "score": 7.0,
                                "score_rationale": "Clear communication.",
                                "strengths": [],
                                "risks": [],
                                "actions": [],
                            },
                            {
                                "dimension": "teamwork",
                                "label_zh": "团队协作",
                                "score": 6.5,
                                "score_rationale": "Decent teamwork.",
                                "strengths": [],
                                "risks": [],
                                "actions": [],
                            },
                        ],
                        "summary": {"strengths": ["Tech expert"], "risks": [], "actions": []},
                    }
                ],
            }

    synthesizer = ReportSynthesizer(llm=MockLLMCustomDims())
    req = _build_test_request()
    req.session_context = SessionContext(
        mode="1v1",
        interviewer_name="Interviewer",
        dimension_presets=[
            DimensionPreset(key="technical", label_zh="技术能力", description="技术深度和广度"),
            DimensionPreset(key="communication", label_zh="沟通能力", description="表达清晰度和沟通效果"),
            DimensionPreset(key="teamwork", label_zh="团队协作", description="团队配合和协作精神"),
        ],
    )
    result = synthesizer.synthesize(req)

    alice = result.per_person[0]
    # Should have exactly 3 custom dimensions
    assert len(alice.dimensions) == 3
    dim_names = {d.dimension for d in alice.dimensions}
    assert dim_names == {"technical", "communication", "teamwork"}

    # Default 5 dimensions should NOT be present
    assert "leadership" not in dim_names
    assert "initiative" not in dim_names

    # Check label_zh
    tech = next(d for d in alice.dimensions if d.dimension == "technical")
    assert tech.label_zh == "技术能力"
    assert tech.score == 8.0


def test_v2_legacy_format_fallback() -> None:
    """Legacy LLM format (summary_sections, no narrative) should be auto-converted."""
    synthesizer = ReportSynthesizer(llm=MockLLMLegacyFormat())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    # Narrative should be populated from summary_sections fallback
    assert result.overall.narrative != ""
    # Legacy fields should still be present
    assert len(result.overall.summary_sections) >= 1
    # key_findings should be populated from team_dynamics fallback
    assert len(result.overall.key_findings) >= 1


def test_v2_evidence_pack_has_source_tier() -> None:
    """Evidence pack in user prompt should include source_tier."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    truncated, _ = synthesizer._truncate_transcript(req.transcript)
    prompt = synthesizer._build_user_prompt(req, truncated)
    data = json.loads(prompt)

    for ev in data["evidence_pack"]:
        assert "source_tier" in ev, f"Missing source_tier in evidence {ev['evidence_id']}"
        assert ev["source_tier"] in (1, 2, 3), f"Invalid source_tier: {ev['source_tier']}"


def test_v2_system_prompt_contains_scoring_rubric() -> None:
    """System prompt should contain the 0-10 scoring rubric."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)

    assert "0-2" in prompt
    assert "3-4" in prompt
    assert "5-6" in prompt
    assert "7-8" in prompt
    assert "9-10" in prompt
    assert "严重不足" in prompt
    assert "优秀" in prompt


def test_v2_system_prompt_contains_interview_context() -> None:
    """System prompt should contain interview context anchoring."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    req.session_context = SessionContext(
        mode="1v1",
        interviewer_name="Prof. Smith",
        position_title="Senior Engineer",
        company_name="TechCorp",
        interview_type="Technical",
    )
    prompt = synthesizer._build_system_prompt(req)

    assert "Senior Engineer" in prompt
    assert "TechCorp" in prompt
    assert "Technical" in prompt
    assert "Prof. Smith" in prompt
    assert "面试类型" in prompt


def test_v2_user_prompt_includes_evaluation_dimensions() -> None:
    """User prompt should include evaluation_dimensions."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    truncated, _ = synthesizer._truncate_transcript(req.transcript)
    prompt = synthesizer._build_user_prompt(req, truncated)
    data = json.loads(prompt)

    assert "evaluation_dimensions" in data
    dims = data["evaluation_dimensions"]
    assert len(dims) == 5  # Default 5 dimensions
    assert dims[0]["key"] == "leadership"
    assert dims[0]["label_zh"] == "领导力"


def test_v2_system_prompt_no_embed_references_rule() -> None:
    """System prompt should have rule about no [e_XXXXX] in claim text."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)

    assert "claim.text 必须是纯自然语言" in prompt
    assert "不要在文本中嵌入 [e_XXXXX]" in prompt


def test_v2_system_prompt_tier_priority_rule() -> None:
    """System prompt should have rule about tier_1 evidence priority."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)

    assert "tier_1" in prompt
    assert "tier_3" in prompt


def test_v2_system_prompt_narrative_rule() -> None:
    """System prompt should have rule about narrative being a cohesive paragraph."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)

    assert "overall.narrative" in prompt
    assert "连贯段落" in prompt


def test_v2_system_prompt_not_applicable_rule() -> None:
    """System prompt should have rule about not_applicable dimensions."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)

    assert "not_applicable" in prompt


def test_v2_system_prompt_suggested_dimensions_rule() -> None:
    """System prompt should have rule about suggested_dimensions."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)

    assert "suggested_dimensions" in prompt


def test_v2_missing_dimensions_get_default_score() -> None:
    """Dimensions not returned by LLM should get default score=5 and evidence_insufficient=True."""

    class MockLLMPartialDims:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            return {
                "overall": {
                    "narrative": "Overview.",
                    "narrative_evidence_refs": [],
                    "key_findings": [{"type": "observation", "text": "General", "evidence_refs": []}],
                    "suggested_dimensions": [],
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {
                                "dimension": "leadership",
                                "label_zh": "领导力",
                                "score": 8.0,
                                "score_rationale": "Strong leader.",
                                "strengths": [
                                    {"claim_id": "c_01", "text": "Good leader.", "evidence_refs": ["e_000001"], "confidence": 0.8}
                                ],
                                "risks": [],
                                "actions": [],
                            },
                            # Only 1 of 5 dimensions returned
                        ],
                        "summary": {"strengths": [], "risks": [], "actions": []},
                    }
                ],
            }

    synthesizer = ReportSynthesizer(llm=MockLLMPartialDims())
    req = _build_test_request()
    result = synthesizer.synthesize(req)

    alice = result.per_person[0]
    assert len(alice.dimensions) == 5

    # Leadership should have real score
    leadership = next(d for d in alice.dimensions if d.dimension == "leadership")
    assert leadership.score == 8.0
    assert leadership.evidence_insufficient is False

    # Missing dimensions should have default score=5 and evidence_insufficient=True
    collab = next(d for d in alice.dimensions if d.dimension == "collaboration")
    assert collab.score == 5.0
    assert collab.evidence_insufficient is True
