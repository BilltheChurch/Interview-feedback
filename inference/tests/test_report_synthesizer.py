import json

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


def test_synthesize_fallback_on_llm_failure() -> None:
    synthesizer = ReportSynthesizer(llm=FailingLLM())
    req = _build_test_request()
    result = synthesizer.synthesize(req)
    assert result.quality is not None
    assert result.quality.report_source == "memo_first_fallback"
    assert len(result.per_person) >= 1


# ── New tests for P0/P1 fixes ──────────────────────────────────────────────


def test_multi_person_fallback_retains_all_speakers() -> None:
    """Double-fallback (both LLM and ReportGenerator fail) must include ALL
    speakers from req.stats, not just the first one."""

    class AlwaysFailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("boom")

    synthesizer = ReportSynthesizer(llm=AlwaysFailingLLM())
    req = _build_test_request()
    # Ensure we have 2 speakers in stats
    assert len(req.stats) == 2

    result = synthesizer.synthesize(req)
    speaker_keys = {p.person_key for p in result.per_person}
    # Must include both speakers, not just the first
    assert "Alice" in speaker_keys
    assert "Interviewer" in speaker_keys
    assert len(result.per_person) >= 2


def test_no_evidence_ref_is_none_in_any_output() -> None:
    """No claim in any code path should contain evidence_refs=['none']."""

    class AlwaysFailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("boom")

    synthesizer = ReportSynthesizer(llm=AlwaysFailingLLM())
    req = _build_test_request()
    # Clear all evidence to trigger the edge case
    req.evidence = []
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


def test_no_pending_assessment_in_fallback() -> None:
    """Even in the double-fallback path, no 'Pending assessment.' or
    'Assessment pending.' should appear."""

    class AlwaysFailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("boom")

    synthesizer = ReportSynthesizer(llm=AlwaysFailingLLM())
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


def test_fallback_locale_aware_zh() -> None:
    """When LLM fails and the request has no evidence (forcing double-fallback),
    fallback text should be in Chinese when locale is zh-CN."""
    from unittest.mock import patch

    class AlwaysFailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("boom")

    synthesizer = ReportSynthesizer(llm=AlwaysFailingLLM())
    req = _build_test_request()
    req.locale = "zh-CN"
    # Force double-fallback by making ReportGenerator also fail
    with patch("app.services.report_generator.ReportGenerator.generate", side_effect=RuntimeError("double boom")):
        result = synthesizer.synthesize(req)

    for person in result.per_person:
        for dim in person.dimensions:
            for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                assert "暂无法评估" in claim.text or "维度数据不足" in claim.text, (
                    f"Expected Chinese fallback text, got: {claim.text}"
                )


def test_fallback_locale_aware_en() -> None:
    """When LLM fails and the request has no evidence (forcing double-fallback),
    fallback text should be in English when locale is en."""
    from unittest.mock import patch

    class AlwaysFailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("boom")

    synthesizer = ReportSynthesizer(llm=AlwaysFailingLLM())
    req = _build_test_request()
    req.locale = "en"
    # Force double-fallback by making ReportGenerator also fail
    with patch("app.services.report_generator.ReportGenerator.generate", side_effect=RuntimeError("double boom")):
        result = synthesizer.synthesize(req)

    for person in result.per_person:
        for dim in person.dimensions:
            for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                assert "Insufficient data" in claim.text, (
                    f"Expected English fallback text, got: {claim.text}"
                )
