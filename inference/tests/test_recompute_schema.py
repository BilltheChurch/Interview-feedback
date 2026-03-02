"""Tests for RecomputeSegment schema and FinalizeRequestV1 integration."""
import pytest
from pydantic import ValidationError


def test_recompute_segment_valid():
    from app.schemas_v1 import RecomputeSegment
    seg = RecomputeSegment(
        utterance_id="utt_0",
        increment_index=2,
        start_ms=5000,
        end_ms=8000,
        original_confidence=0.35,
        stream_role="teacher",
        audio_b64="dGVzdA==",
        audio_format="wav",
    )
    assert seg.duration_ms == 3000
    assert seg.stream_role == "teacher"


def test_recompute_segment_defaults():
    from app.schemas_v1 import RecomputeSegment
    seg = RecomputeSegment(
        utterance_id="utt_1",
        increment_index=0,
        start_ms=0,
        end_ms=1000,
        original_confidence=0.5,
        audio_b64="dGVzdA==",
    )
    assert seg.stream_role == "mixed"
    assert seg.audio_format == "wav"


def test_recompute_segment_rejects_negative_start():
    from app.schemas_v1 import RecomputeSegment
    with pytest.raises(ValidationError):
        RecomputeSegment(
            utterance_id="utt_bad",
            increment_index=0,
            start_ms=-1,
            end_ms=1000,
            original_confidence=0.5,
            audio_b64="dGVzdA==",
        )


def test_finalize_request_v1_accepts_recompute_segments():
    from app.schemas_v1 import FinalizeRequestV1, RecomputeSegment
    req = FinalizeRequestV1(
        v=1,
        session_id="sess-1",
        total_audio_ms=60000,
        recompute_segments=[
            RecomputeSegment(
                utterance_id="utt_0",
                increment_index=0,
                start_ms=0,
                end_ms=3000,
                original_confidence=0.4,
                stream_role="students",
                audio_b64="dGVzdA==",
            ),
        ],
    )
    assert len(req.recompute_segments) == 1
    assert req.recompute_segments[0].stream_role == "students"


def test_finalize_request_v1_defaults_empty_recompute():
    from app.schemas_v1 import FinalizeRequestV1
    req = FinalizeRequestV1(v=1, session_id="sess-2", total_audio_ms=10000)
    assert req.recompute_segments == []
