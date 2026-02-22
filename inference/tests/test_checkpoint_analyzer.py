import pytest

from app.schemas import (
    AnalysisReportResponse,
    CheckpointDimensionSignal,
    CheckpointRequest,
    CheckpointResponse,
    CheckpointSpeakerNote,
    EvidenceRef,
    Memo,
    MergeCheckpointsRequest,
    SpeakerStat,
    TranscriptUtterance,
)
from app.services.checkpoint_analyzer import CheckpointAnalyzer


class MockCheckpointLLM:
    """Returns valid checkpoint analysis JSON."""

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
        if "analyze_checkpoint" in user_prompt:
            return {
                "summary": "Alice discussed system architecture with clear structure.",
                "per_speaker_notes": [
                    {
                        "speaker_key": "Alice",
                        "observations": [
                            "Outlined a three-layer architecture clearly.",
                            "Responded to scaling questions with concrete examples.",
                        ],
                    }
                ],
                "dimension_signals": [
                    {
                        "dimension": "structure",
                        "speaker_key": "Alice",
                        "signal": "positive",
                        "note": "Well-organized layered approach.",
                    },
                    {
                        "dimension": "logic",
                        "speaker_key": "Alice",
                        "signal": "positive",
                        "note": "Clear reasoning about scaling tradeoffs.",
                    },
                ],
            }
        # merge_checkpoints
        return {
            "overall": {
                "summary_sections": [
                    {
                        "topic": "Interview Summary",
                        "bullets": [
                            "Alice demonstrated strong architecture skills [e_000001].",
                        ],
                        "evidence_ids": ["e_000001"],
                    }
                ],
                "team_dynamics": {
                    "highlights": ["Strong structural thinking"],
                    "risks": ["Could elaborate more on edge cases"],
                },
            },
            "per_person": [
                {
                    "person_key": "Alice",
                    "display_name": "Alice",
                    "dimensions": [
                        {
                            "dimension": dim,
                            "strengths": [
                                {
                                    "claim_id": f"c_Alice_{dim}_01",
                                    "text": f"Good {dim} skills [e_000001].",
                                    "evidence_refs": ["e_000001"],
                                    "confidence": 0.8,
                                }
                            ],
                            "risks": [
                                {
                                    "claim_id": f"c_Alice_{dim}_02",
                                    "text": f"Room for improvement in {dim}.",
                                    "evidence_refs": ["e_000001"],
                                    "confidence": 0.65,
                                }
                            ],
                            "actions": [
                                {
                                    "claim_id": f"c_Alice_{dim}_03",
                                    "text": f"Practice {dim} techniques.",
                                    "evidence_refs": ["e_000001"],
                                    "confidence": 0.7,
                                }
                            ],
                        }
                        for dim in [
                            "leadership",
                            "collaboration",
                            "logic",
                            "structure",
                            "initiative",
                        ]
                    ],
                    "summary": {
                        "strengths": ["Good architecture skills"],
                        "risks": ["Needs more depth"],
                        "actions": ["Practice edge cases"],
                    },
                }
            ],
        }


def _build_checkpoint_request() -> CheckpointRequest:
    return CheckpointRequest(
        session_id="s-cp-test",
        checkpoint_index=0,
        utterances=[
            TranscriptUtterance(
                utterance_id="u1",
                stream_role="students",
                speaker_name="Alice",
                cluster_id="c1",
                text="Let me outline the system architecture.",
                start_ms=0,
                end_ms=5000,
                duration_ms=5000,
                decision="auto",
            ),
            TranscriptUtterance(
                utterance_id="u2",
                stream_role="teacher",
                speaker_name="Interviewer",
                text="How would you handle scaling?",
                start_ms=5500,
                end_ms=7000,
                duration_ms=1500,
                decision="auto",
            ),
        ],
        memos=[
            Memo(
                memo_id="m1",
                created_at_ms=3000,
                type="observation",
                tags=["structure"],
                text="Good layered architecture approach",
            ),
        ],
        stats=[
            SpeakerStat(
                speaker_key="Alice",
                speaker_name="Alice",
                talk_time_ms=5000,
                turns=1,
            ),
        ],
    )


def _build_merge_request() -> MergeCheckpointsRequest:
    return MergeCheckpointsRequest(
        session_id="s-merge-test",
        checkpoints=[
            CheckpointResponse(
                session_id="s-merge-test",
                checkpoint_index=0,
                timestamp_ms=300000,
                summary="Alice discussed system architecture with clear structure.",
                per_speaker_notes=[
                    CheckpointSpeakerNote(
                        speaker_key="Alice",
                        observations=["Good layered approach."],
                    )
                ],
                dimension_signals=[
                    CheckpointDimensionSignal(
                        dimension="structure",
                        speaker_key="Alice",
                        signal="positive",
                        note="Well-organized.",
                    )
                ],
            ),
            CheckpointResponse(
                session_id="s-merge-test",
                checkpoint_index=1,
                timestamp_ms=600000,
                summary="Alice explored scaling strategies in depth.",
                per_speaker_notes=[
                    CheckpointSpeakerNote(
                        speaker_key="Alice",
                        observations=["Concrete scaling examples."],
                    )
                ],
                dimension_signals=[
                    CheckpointDimensionSignal(
                        dimension="logic",
                        speaker_key="Alice",
                        signal="positive",
                        note="Clear tradeoff analysis.",
                    )
                ],
            ),
        ],
        final_stats=[
            SpeakerStat(
                speaker_key="Alice",
                speaker_name="Alice",
                talk_time_ms=15000,
                turns=6,
            ),
            SpeakerStat(
                speaker_key="Interviewer",
                speaker_name="Interviewer",
                talk_time_ms=5000,
                turns=4,
            ),
        ],
        final_memos=[
            Memo(
                memo_id="m1",
                created_at_ms=3000,
                type="observation",
                tags=["structure"],
                text="Good architecture discussion",
            ),
        ],
        evidence=[
            EvidenceRef(
                evidence_id="e_000001",
                time_range_ms=[0, 5000],
                utterance_ids=["u1"],
                speaker_key="Alice",
                quote="Let me outline the system architecture.",
                confidence=0.85,
            ),
        ],
    )


# ── Checkpoint tests ──────────────────────────────────────────────────────


def test_checkpoint_returns_valid_response() -> None:
    analyzer = CheckpointAnalyzer(llm=MockCheckpointLLM())
    req = _build_checkpoint_request()
    result = analyzer.analyze_checkpoint(req)

    assert result.session_id == "s-cp-test"
    assert result.checkpoint_index == 0
    assert result.timestamp_ms > 0
    assert len(result.summary) > 0
    assert len(result.per_speaker_notes) >= 1
    assert result.per_speaker_notes[0].speaker_key == "Alice"
    assert len(result.per_speaker_notes[0].observations) >= 1


def test_checkpoint_dimension_signals() -> None:
    analyzer = CheckpointAnalyzer(llm=MockCheckpointLLM())
    req = _build_checkpoint_request()
    result = analyzer.analyze_checkpoint(req)

    assert len(result.dimension_signals) >= 1
    dims = {s.dimension for s in result.dimension_signals}
    assert "structure" in dims
    for signal in result.dimension_signals:
        assert signal.signal in ("positive", "negative", "neutral")


def test_checkpoint_empty_utterances() -> None:
    analyzer = CheckpointAnalyzer(llm=MockCheckpointLLM())
    req = CheckpointRequest(
        session_id="s-empty",
        checkpoint_index=0,
        utterances=[],
    )
    result = analyzer.analyze_checkpoint(req)

    assert result.session_id == "s-empty"
    assert result.timestamp_ms == 0
    assert result.per_speaker_notes == []
    assert result.dimension_signals == []


def test_checkpoint_llm_failure_raises() -> None:
    class FailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("LLM unavailable")

    analyzer = CheckpointAnalyzer(llm=FailingLLM())
    req = _build_checkpoint_request()
    with pytest.raises(RuntimeError, match="LLM unavailable"):
        analyzer.analyze_checkpoint(req)


# ── Merge tests ───────────────────────────────────────────────────────────


def test_merge_returns_valid_report() -> None:
    analyzer = CheckpointAnalyzer(llm=MockCheckpointLLM())
    req = _build_merge_request()
    result = analyzer.merge_checkpoints(req)

    assert isinstance(result, AnalysisReportResponse)
    assert result.session_id == "s-merge-test"
    assert len(result.per_person) >= 1
    assert result.per_person[0].person_key == "Alice"
    assert len(result.per_person[0].dimensions) == 5
    assert result.quality is not None
    assert result.quality.report_source == "llm_synthesized"


def test_merge_validates_evidence_refs() -> None:
    analyzer = CheckpointAnalyzer(llm=MockCheckpointLLM())
    req = _build_merge_request()
    result = analyzer.merge_checkpoints(req)

    valid_ids = {e.evidence_id for e in req.evidence}
    for person in result.per_person:
        for dim in person.dimensions:
            for claim in [*dim.strengths, *dim.risks, *dim.actions]:
                for ref in claim.evidence_refs:
                    assert ref in valid_ids, f"Invalid evidence ref {ref}"


def test_merge_filters_interviewer() -> None:
    analyzer = CheckpointAnalyzer(llm=MockCheckpointLLM())
    req = _build_merge_request()
    result = analyzer.merge_checkpoints(req)

    speaker_keys = {p.person_key for p in result.per_person}
    assert "Interviewer" not in speaker_keys
    assert "Alice" in speaker_keys


def test_merge_llm_failure_raises() -> None:
    class FailingLLM:
        def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
            raise RuntimeError("merge failed")

    analyzer = CheckpointAnalyzer(llm=FailingLLM())
    req = _build_merge_request()
    with pytest.raises(RuntimeError, match="merge failed"):
        analyzer.merge_checkpoints(req)


def test_merge_quality_meta() -> None:
    analyzer = CheckpointAnalyzer(llm=MockCheckpointLLM())
    req = _build_merge_request()
    result = analyzer.merge_checkpoints(req)

    assert result.quality is not None
    assert result.quality.build_ms >= 0
    assert result.quality.claim_count > 0


def test_checkpoint_response_serializable() -> None:
    """CheckpointResponse must be JSON-serializable for DO state storage."""
    resp = CheckpointResponse(
        session_id="s-test",
        checkpoint_index=0,
        timestamp_ms=300000,
        summary="Test summary",
        per_speaker_notes=[
            CheckpointSpeakerNote(speaker_key="Alice", observations=["Good"]),
        ],
        dimension_signals=[
            CheckpointDimensionSignal(
                dimension="logic",
                speaker_key="Alice",
                signal="positive",
                note="Clear reasoning",
            ),
        ],
    )
    # Must not raise
    data = resp.model_dump()
    assert isinstance(data, dict)
    assert data["checkpoint_index"] == 0

    # Round-trip
    restored = CheckpointResponse(**data)
    assert restored.session_id == "s-test"
    assert restored.per_speaker_notes[0].speaker_key == "Alice"
