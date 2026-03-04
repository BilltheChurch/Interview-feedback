"""Tests for V1 incremental schemas with versioning."""
import pytest
from pydantic import ValidationError

from app.schemas_v1 import (
    SCHEMA_VERSION,
    FinalizeRequestV1,
    FinalizeResponseV1,
    R2AudioRef,
)


def test_schema_version():
    assert SCHEMA_VERSION == 1


def test_r2_audio_ref():
    ref = R2AudioRef(key="chunks/sess-1/000.pcm", start_ms=0, end_ms=10000)
    assert ref.duration_ms == 10000


def test_finalize_request_valid():
    req = FinalizeRequestV1(
        v=1,
        session_id="sess-1",
        r2_audio_refs=[
            R2AudioRef(key="chunks/sess-1/000.pcm", start_ms=0, end_ms=10000),
        ],
        total_audio_ms=10000,
        locale="en-US",
    )
    assert req.session_id == "sess-1"


def test_finalize_request_rejects_wrong_version():
    with pytest.raises(ValidationError):
        FinalizeRequestV1(
            v=2,
            session_id="sess-1",
            r2_audio_refs=[],
            total_audio_ms=0,
            locale="en-US",
        )


def test_finalize_request_requires_session_id():
    with pytest.raises(ValidationError):
        FinalizeRequestV1(
            v=1,
            session_id="",
            r2_audio_refs=[],
            total_audio_ms=0,
            locale="en-US",
        )


def test_finalize_response_has_metrics():
    resp = FinalizeResponseV1(
        v=1,
        session_id="sess-1",
        transcript=[],
        speaker_stats=[],
        report=None,
        total_increments=3,
        total_audio_ms=180000,
        finalize_time_ms=25000,
        metrics={
            "segments_recomputed": 5,
            "segments_total": 50,
            "recompute_ratio": 0.10,
            "llm_latency_ms": 12000,
        },
    )
    assert resp.metrics["recompute_ratio"] == 0.10
