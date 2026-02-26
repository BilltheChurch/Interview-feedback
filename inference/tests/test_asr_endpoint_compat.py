"""Integration test: verify /asr/transcribe-window response schema
matches what Edge Worker's LocalWhisperASRProvider expects.

Edge Worker expects:
{
    "text": str,
    "utterances": [{"id": str, "text": str, "start_ms": int, "end_ms": int, ...}],
    "language": str,
    "duration_ms": int,
    "processing_time_ms": int,
    "backend": str,
    "device": str
}
"""

import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.main import app
from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp


def _mock_asr_backend():
    """Create a mock ASR backend that returns a realistic TranscriptResult."""
    mock = MagicMock()
    mock.device = "cpu"
    mock.backend = "sensevoice"
    mock.model_size = "SenseVoiceSmall"
    mock.transcribe_pcm.return_value = TranscriptResult(
        utterances=[
            Utterance(
                id="u_0000",
                text="Hello",
                start_ms=0,
                end_ms=1000,
                words=[WordTimestamp(word="Hello", start_ms=0, end_ms=1000, confidence=1.0)],
                language="en",
                confidence=1.0,
            )
        ],
        language="en",
        duration_ms=3000,
        processing_time_ms=50,
        backend="sensevoice",
        model_size="SenseVoiceSmall",
    )
    return mock


def _no_auth():
    return patch("app.main.settings", **{
        "inference_api_key": SecretStr(""),
        "max_request_body_bytes": 50 * 1024 * 1024,
        "rate_limit_enabled": False,
    })


@pytest.fixture
def client():
    return TestClient(app, raise_server_exceptions=False)


class TestTranscribeWindowCompat:
    """Verify response schema matches Edge Worker expectations."""

    def test_response_has_required_fields(self, client):
        """Edge Worker checks: text, utterances, language, processing_time_ms, backend."""
        mock_asr = _mock_asr_backend()
        # 3 seconds of silence (16kHz mono PCM16 = 96000 bytes)
        pcm = b"\x00\x00" * 48000
        with _no_auth(), patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)):
            resp = client.post(
                "/asr/transcribe-window?sample_rate=16000&language=auto",
                content=pcm,
                headers={"Content-Type": "application/octet-stream"},
            )
        assert resp.status_code == 200
        data = resp.json()

        # Required fields (Edge Worker reads these)
        assert "text" in data
        assert isinstance(data["text"], str)
        assert "utterances" in data
        assert isinstance(data["utterances"], list)
        assert "language" in data
        assert isinstance(data["language"], str)
        assert "processing_time_ms" in data
        assert isinstance(data["processing_time_ms"], int)
        assert "backend" in data
        assert isinstance(data["backend"], str)
        assert "device" in data
        assert isinstance(data["device"], str)

    def test_utterance_schema(self, client):
        """Each utterance must have: id, text, start_ms, end_ms."""
        mock_asr = _mock_asr_backend()
        pcm = b"\x00\x00" * 48000  # 3s silence
        with _no_auth(), patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)):
            resp = client.post(
                "/asr/transcribe-window?sample_rate=16000",
                content=pcm,
                headers={"Content-Type": "application/octet-stream"},
            )
        data = resp.json()
        for utt in data["utterances"]:
            assert "id" in utt
            assert "text" in utt
            assert "start_ms" in utt
            assert "end_ms" in utt

    def test_status_endpoint(self, client):
        """Edge Worker calls /asr/status to check availability."""
        mock_asr = _mock_asr_backend()
        with _no_auth(), patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)):
            resp = client.get("/asr/status")
        assert resp.status_code == 200
        data = resp.json()
        assert "available" in data
        assert "device" in data
        assert "backend" in data
        assert "model" in data
