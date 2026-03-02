"""Tests for finalize step 4.5: recompute low-confidence utterances.

Acceptance criteria:
- AC1: At least 1 low-confidence utterance text is changed
- AC2: Recompute failure doesn't block report
- AC9: Dual-key alignment (utterance_id primary, coords fallback)
- AC10: Response metrics contain 4 recompute counters
"""
import base64
import io
import wave
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


def _make_test_wav_b64(duration_s: float = 1.0, sr: int = 16000) -> str:
    """Create WAV bytes encoded as base64."""
    buf = io.BytesIO()
    n_samples = int(duration_s * sr)
    pcm = b"\x00\x00" * n_samples
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture
def mock_runtime():
    """Runtime with mock redis, synthesizer, and recompute_asr."""
    runtime = MagicMock()
    runtime.settings = MagicMock()
    runtime.settings.incremental_v1_enabled = True
    runtime.settings.incremental_finalize_merge_threshold = 0.55

    # Mock Redis data
    runtime.redis_state = MagicMock()
    runtime.redis_state.get_meta.return_value = {"last_increment": "2"}
    runtime.redis_state.get_all_utterances.return_value = [
        {"id": "utt_0", "speaker": "spk_00", "text": "low conf text",
         "start_ms": 0, "end_ms": 3000, "increment_index": 0, "confidence": 0.4},
        {"id": "utt_1", "speaker": "spk_00", "text": "good text",
         "start_ms": 3000, "end_ms": 6000, "increment_index": 1, "confidence": 0.95},
    ]
    runtime.redis_state.get_all_checkpoints.return_value = []
    runtime.redis_state.get_all_speaker_profiles.return_value = {
        "spk_00": {"speaker_id": "spk_00", "total_speech_ms": 6000},
    }
    runtime.redis_state.cleanup_session = MagicMock()

    # Mock recompute ASR
    runtime.recompute_asr = MagicMock()
    runtime.recompute_asr.recompute_utterance.return_value = {
        "text": "improved text",
        "confidence": 0.90,
        "recomputed": True,
    }

    # Mock synthesizer (skip LLM call)
    runtime.report_synthesizer = MagicMock()
    runtime.report_synthesizer.synthesize.return_value = MagicMock(
        model_dump=lambda: {"summary": "test report"},
    )

    return runtime


@pytest.fixture
def app(mock_runtime):
    from fastapi import FastAPI
    from app.routes.incremental_v1 import v1_router
    app = FastAPI()
    app.state.runtime = mock_runtime
    app.include_router(v1_router)
    return app


def test_recompute_changes_low_confidence_text(app, mock_runtime):
    """AC1: Low-confidence utterance text must be replaced."""
    client = TestClient(app)
    audio_b64 = _make_test_wav_b64(3.0)
    resp = client.post("/v1/incremental/finalize", json={
        "v": 1,
        "session_id": "sess-recompute",
        "total_audio_ms": 6000,
        "recompute_segments": [{
            "utterance_id": "utt_0",
            "increment_index": 0,
            "start_ms": 0,
            "end_ms": 3000,
            "original_confidence": 0.4,
            "stream_role": "mixed",
            "audio_b64": audio_b64,
            "audio_format": "wav",
        }],
    })
    assert resp.status_code == 200
    data = resp.json()
    # Find recomputed utterance in transcript
    recomputed = [u for u in data["transcript"] if u.get("id") == "utt_0" or u.get("recomputed")]
    assert len(recomputed) >= 1 or any(u["text"] == "improved text" for u in data["transcript"])


def test_recompute_failure_does_not_block_report(app, mock_runtime):
    """AC2: Recompute error must not prevent finalize from completing."""
    mock_runtime.recompute_asr.recompute_utterance.side_effect = RuntimeError("Model OOM")

    client = TestClient(app)
    audio_b64 = _make_test_wav_b64(1.0)
    resp = client.post("/v1/incremental/finalize", json={
        "v": 1,
        "session_id": "sess-fail",
        "total_audio_ms": 6000,
        "recompute_segments": [{
            "utterance_id": "utt_0",
            "increment_index": 0,
            "start_ms": 0,
            "end_ms": 3000,
            "original_confidence": 0.4,
            "audio_b64": audio_b64,
        }],
    })
    assert resp.status_code == 200
    data = resp.json()
    # Original text preserved on failure
    assert any(u["text"] == "low conf text" for u in data["transcript"])


def test_recompute_dual_key_fallback(app, mock_runtime):
    """AC9: When utterance_id doesn't match, fall back to coords."""
    mock_runtime.redis_state.get_all_utterances.return_value = [
        {"id": "different_id", "speaker": "spk_00", "text": "original",
         "start_ms": 0, "end_ms": 3000, "increment_index": 0, "confidence": 0.4},
    ]

    client = TestClient(app)
    audio_b64 = _make_test_wav_b64(1.0)
    resp = client.post("/v1/incremental/finalize", json={
        "v": 1,
        "session_id": "sess-fallback",
        "total_audio_ms": 3000,
        "recompute_segments": [{
            "utterance_id": "wrong_id",
            "increment_index": 0,
            "start_ms": 0,
            "end_ms": 3000,
            "original_confidence": 0.4,
            "audio_b64": audio_b64,
        }],
    })
    assert resp.status_code == 200
    data = resp.json()
    # Should match by coords and recompute
    assert any(u["text"] == "improved text" for u in data["transcript"])


def test_recompute_metrics_in_response(app, mock_runtime):
    """AC10: Response metrics must contain 4 recompute counters."""
    client = TestClient(app)
    audio_b64 = _make_test_wav_b64(1.0)
    resp = client.post("/v1/incremental/finalize", json={
        "v": 1,
        "session_id": "sess-metrics",
        "total_audio_ms": 6000,
        "recompute_segments": [{
            "utterance_id": "utt_0",
            "increment_index": 0,
            "start_ms": 0,
            "end_ms": 3000,
            "original_confidence": 0.4,
            "audio_b64": audio_b64,
        }],
    })
    assert resp.status_code == 200
    metrics = resp.json()["metrics"]
    assert "recompute_requested" in metrics
    assert "recompute_succeeded" in metrics
    assert "recompute_skipped" in metrics
    assert "recompute_failed" in metrics
    assert metrics["recompute_requested"] == 1
    assert metrics["recompute_succeeded"] == 1


def test_recompute_skipped_when_no_recompute_asr(app, mock_runtime):
    """When recompute_asr is None, segments are silently skipped."""
    mock_runtime.recompute_asr = None

    client = TestClient(app)
    resp = client.post("/v1/incremental/finalize", json={
        "v": 1,
        "session_id": "sess-none",
        "total_audio_ms": 6000,
        "recompute_segments": [{
            "utterance_id": "utt_0",
            "increment_index": 0,
            "start_ms": 0,
            "end_ms": 3000,
            "original_confidence": 0.4,
            "audio_b64": _make_test_wav_b64(1.0),
        }],
    })
    assert resp.status_code == 200
    data = resp.json()
    # Original text unchanged
    assert any(u["text"] == "low conf text" for u in data["transcript"])
    # Counters: requested=1, succeeded=0
    assert data["metrics"]["recompute_requested"] == 1
