import json

import pytest

from app.schemas import (
    AnalysisReportResponse,
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
    """Returns a valid LLM JSON response matching the output contract."""

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
        return {
            "overall": {
                "summary_sections": [
                    {
                        "topic": "Interview Summary",
                        "bullets": [
                            "Alice demonstrated strong system design skills [e_000001].",
                            "Communication was clear and structured [e_000002].",
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
                                    "text": "Effectively led the system design discussion with clear structure [e_000001].",
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
                    "summary_sections": [],
                    "team_dynamics": {"highlights": [], "risks": []},
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {"dimension": dim, "strengths": [], "risks": [], "actions": []}
                            for dim in ["leadership", "collaboration", "logic", "structure", "initiative"]
                        ],
                        "summary": {"strengths": [], "risks": [], "actions": []},
                    },
                    {
                        "person_key": "Silent",
                        "display_name": "Silent Person",
                        "dimensions": [
                            {"dimension": dim, "strengths": [], "risks": [], "actions": []}
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
                    "summary_sections": [
                        {"topic": "Summary", "bullets": ["Good [e_000001]"], "evidence_ids": ["e_000001"]}
                    ],
                    "team_dynamics": {"highlights": [], "risks": []},
                },
                "per_person": [
                    {
                        "person_key": "Alice",
                        "display_name": "Alice",
                        "dimensions": [
                            {
                                "dimension": "leadership",
                                "strengths": [
                                    {"claim_id": "c_Alice_leadership_01", "text": "Led well [e_000001].", "evidence_refs": ["e_000001"], "confidence": 0.85}
                                ],
                                "risks": [],
                                "actions": [],
                            },
                            # Other dimensions completely empty
                            {"dimension": "collaboration", "strengths": [], "risks": [], "actions": []},
                            {"dimension": "logic", "strengths": [], "risks": [], "actions": []},
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


def test_system_prompt_requires_minimum_summary_sections() -> None:
    """System prompt should require minimum 2 summary sections."""
    synthesizer = ReportSynthesizer(llm=MockLLMForSynthesis())
    req = _build_test_request()
    prompt = synthesizer._build_system_prompt(req)
    assert "2" in prompt  # Should mention "at least 2" or "minimum 2"


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
                    "summary_sections": [
                        {"topic": "Summary", "bullets": ["Good [e_000001]"], "evidence_ids": ["e_000001"]}
                    ],
                    "team_dynamics": {"highlights": ["Strong team"], "risks": ["Low energy"]},
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
                                        "text": "Led the discussion well [e_000001].",
                                        "evidence_refs": ["e_000001"],
                                        "confidence": 0.85,
                                        "supporting_utterances": ["u1", "u2"],
                                    }
                                ],
                                "risks": [],
                                "actions": [],
                            },
                            *[
                                {"dimension": dim, "strengths": [], "risks": [], "actions": []}
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
                    "summary_sections": [],
                    "team_dynamics": {"highlights": [], "risks": []},
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
                                {"dimension": dim, "strengths": [], "risks": [], "actions": []}
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
