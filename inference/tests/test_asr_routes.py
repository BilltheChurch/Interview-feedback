"""Tests for ASR real-time transcription API endpoints.

Tests use FastAPI TestClient with mocked Whisper transcriber singleton.
"""

from __future__ import annotations

import base64
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _mock_transcript() -> TranscriptResult:
    """Return a realistic mock TranscriptResult for testing."""
    return TranscriptResult(
        utterances=[
            Utterance(
                id="u_0000",
                text="Hello everyone",
                start_ms=0,
                end_ms=3000,
                words=[
                    WordTimestamp(word="Hello", start_ms=100, end_ms=400, confidence=0.95),
                    WordTimestamp(word="everyone", start_ms=500, end_ms=3000, confidence=0.90),
                ],
                language="en",
                confidence=0.9,
            ),
            Utterance(
                id="u_0001",
                text="Nice to meet you",
                start_ms=3000,
                end_ms=6000,
                words=[
                    WordTimestamp(word="Nice", start_ms=3000, end_ms=3200, confidence=0.88),
                    WordTimestamp(word="to", start_ms=3200, end_ms=3400, confidence=0.92),
                    WordTimestamp(word="meet", start_ms=3400, end_ms=3700, confidence=0.91),
                    WordTimestamp(word="you", start_ms=3700, end_ms=6000, confidence=0.89),
                ],
                language="en",
                confidence=0.85,
            ),
        ],
        language="en",
        duration_ms=10000,
        processing_time_ms=2500,
        backend="openai-whisper",
        model_size="large-v3",
    )


def _mock_whisper_transcriber(transcript: TranscriptResult | None = None) -> MagicMock:
    """Create a mocked WhisperBatchTranscriber with preset return values."""
    mock = MagicMock()
    mock.transcribe_pcm.return_value = transcript or _mock_transcript()
    mock.device = "mps"
    mock.backend = "openai-whisper"
    mock.model_size = "large-v3"
    return mock


def _no_auth():
    """Context manager to disable auth and rate limiting for test requests."""
    return patch("app.main.settings", **{
        "inference_api_key": SecretStr(""),
        "max_request_body_bytes": 50 * 1024 * 1024,
        "rate_limit_enabled": False,
    })


def _sample_pcm() -> bytes:
    """Return dummy PCM data (16-bit, mono, 16kHz silence — 0.1s)."""
    # 16000 samples/sec * 2 bytes/sample * 0.1 sec = 3200 bytes
    return b"\x00" * 3200


# ---------------------------------------------------------------------------
# POST /asr/transcribe-window — JSON mode
# ---------------------------------------------------------------------------


def test_transcribe_window_json_mode():
    """Test POST /asr/transcribe-window with JSON body and base64 PCM."""
    mock_whisper = _mock_whisper_transcriber()

    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    pcm = _sample_pcm()
    pcm_b64 = base64.b64encode(pcm).decode()

    with _no_auth(), patch("app.routes.asr._get_whisper", return_value=mock_whisper):
        resp = client.post(
            "/asr/transcribe-window",
            json={
                "pcm_base64": pcm_b64,
                "sample_rate": 16000,
                "language": "en",
            },
        )

    assert resp.status_code == 200
    data = resp.json()

    # Verify response structure
    assert data["text"] == "Hello everyone Nice to meet you"
    assert data["language"] == "en"
    assert data["duration_ms"] == 10000
    assert data["processing_time_ms"] == 2500
    assert data["backend"] == "openai-whisper"
    assert data["device"] == "mps"

    # Verify utterances
    assert len(data["utterances"]) == 2
    assert data["utterances"][0]["id"] == "u_0000"
    assert data["utterances"][0]["text"] == "Hello everyone"
    assert data["utterances"][0]["start_ms"] == 0
    assert data["utterances"][0]["end_ms"] == 3000
    assert len(data["utterances"][0]["words"]) == 2
    assert data["utterances"][0]["words"][0]["word"] == "Hello"
    assert data["utterances"][0]["words"][0]["confidence"] == 0.95

    assert data["utterances"][1]["id"] == "u_0001"
    assert data["utterances"][1]["text"] == "Nice to meet you"
    assert len(data["utterances"][1]["words"]) == 4

    # Verify transcriber was called correctly
    mock_whisper.transcribe_pcm.assert_called_once_with(pcm, 16000, "en")


def test_transcribe_window_json_defaults():
    """Test JSON mode with default sample_rate and language."""
    mock_whisper = _mock_whisper_transcriber()

    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    pcm_b64 = base64.b64encode(_sample_pcm()).decode()

    with _no_auth(), patch("app.routes.asr._get_whisper", return_value=mock_whisper):
        resp = client.post(
            "/asr/transcribe-window",
            json={"pcm_base64": pcm_b64},
        )

    assert resp.status_code == 200
    # Should have used defaults: sample_rate=16000, language="auto"
    mock_whisper.transcribe_pcm.assert_called_once_with(
        base64.b64decode(pcm_b64), 16000, "auto"
    )


# ---------------------------------------------------------------------------
# POST /asr/transcribe-window — Binary mode
# ---------------------------------------------------------------------------


def test_transcribe_window_binary_mode():
    """Test POST /asr/transcribe-window with raw PCM bytes in body."""
    mock_whisper = _mock_whisper_transcriber()

    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    pcm = _sample_pcm()

    with _no_auth(), patch("app.routes.asr._get_whisper", return_value=mock_whisper):
        resp = client.post(
            "/asr/transcribe-window?sample_rate=16000&language=zh",
            content=pcm,
            headers={"Content-Type": "application/octet-stream"},
        )

    assert resp.status_code == 200
    data = resp.json()

    assert data["text"] == "Hello everyone Nice to meet you"
    assert len(data["utterances"]) == 2
    assert data["device"] == "mps"

    mock_whisper.transcribe_pcm.assert_called_once_with(pcm, 16000, "zh")


def test_transcribe_window_binary_default_params():
    """Test binary mode uses default query params when not specified."""
    mock_whisper = _mock_whisper_transcriber()

    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    pcm = _sample_pcm()

    with _no_auth(), patch("app.routes.asr._get_whisper", return_value=mock_whisper):
        resp = client.post(
            "/asr/transcribe-window",
            content=pcm,
            headers={"Content-Type": "application/octet-stream"},
        )

    assert resp.status_code == 200
    mock_whisper.transcribe_pcm.assert_called_once_with(pcm, 16000, "auto")


# ---------------------------------------------------------------------------
# GET /asr/status
# ---------------------------------------------------------------------------


def test_asr_status():
    """Test GET /asr/status returns Whisper status info."""
    mock_whisper = _mock_whisper_transcriber()

    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    with _no_auth(), patch("app.routes.asr._get_whisper", return_value=mock_whisper):
        resp = client.get("/asr/status")

    assert resp.status_code == 200
    data = resp.json()
    assert data["available"] is True
    assert data["device"] == "mps"
    assert data["backend"] == "openai-whisper"
    assert data["model"] == "large-v3"


def test_asr_status_when_unavailable():
    """Test GET /asr/status gracefully handles initialization failure."""
    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    with _no_auth(), patch("app.routes.asr._get_whisper", side_effect=RuntimeError("model load failed")):
        resp = client.get("/asr/status")

    assert resp.status_code == 200
    data = resp.json()
    assert data["available"] is False
    assert data["device"] == "unknown"
    assert data["backend"] == "unknown"
    assert data["model"] == "unknown"


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


def test_transcribe_window_empty_pcm_json():
    """Test that empty PCM data in JSON mode returns 400."""
    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    # Empty base64 decodes to empty bytes
    with _no_auth():
        resp = client.post(
            "/asr/transcribe-window",
            json={"pcm_base64": ""},
        )

    assert resp.status_code == 400
    assert "Empty PCM data" in resp.json()["detail"]


def test_transcribe_window_empty_pcm_binary():
    """Test that empty body in binary mode returns 400."""
    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    with _no_auth():
        resp = client.post(
            "/asr/transcribe-window",
            content=b"",
            headers={"Content-Type": "application/octet-stream"},
        )

    assert resp.status_code == 400
    assert "Empty PCM data" in resp.json()["detail"]


def test_transcribe_window_invalid_base64():
    """Test that invalid base64 returns 400."""
    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    with _no_auth():
        resp = client.post(
            "/asr/transcribe-window",
            json={"pcm_base64": "!!!not-valid-base64!!!"},
        )

    assert resp.status_code == 400
    assert "Invalid base64" in resp.json()["detail"]


def test_transcribe_window_empty_utterances():
    """Test response when Whisper returns no utterances (silence)."""
    silent_result = TranscriptResult(
        utterances=[],
        language="en",
        duration_ms=10000,
        processing_time_ms=500,
        backend="openai-whisper",
        model_size="large-v3",
    )
    mock_whisper = _mock_whisper_transcriber(transcript=silent_result)

    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    pcm_b64 = base64.b64encode(_sample_pcm()).decode()

    with _no_auth(), patch("app.routes.asr._get_whisper", return_value=mock_whisper):
        resp = client.post(
            "/asr/transcribe-window",
            json={"pcm_base64": pcm_b64},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["text"] == ""
    assert data["utterances"] == []
    assert data["duration_ms"] == 10000


def test_transcribe_window_whisper_error():
    """Test that a Whisper transcription error returns 500."""
    mock_whisper = _mock_whisper_transcriber()
    mock_whisper.transcribe_pcm.side_effect = RuntimeError("model crashed")

    from app.main import app
    client = TestClient(app, raise_server_exceptions=False)

    pcm_b64 = base64.b64encode(_sample_pcm()).decode()

    with _no_auth(), patch("app.routes.asr._get_whisper", return_value=mock_whisper):
        resp = client.post(
            "/asr/transcribe-window",
            json={"pcm_base64": pcm_b64},
        )

    # FastAPI's default exception handler returns 500 for unhandled errors
    assert resp.status_code == 500
