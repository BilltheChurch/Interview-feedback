"""Tests for /sd/diarize endpoint.

Tests verify:
1. Endpoint returns 501 when diarization is disabled
2. Response schema matches DiarizeResponse
3. Endpoint handles base64 audio correctly
"""

import base64
import struct
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from pydantic import SecretStr
from app.main import app
from app.services.diarize_full import DiarizeResult, SpeakerSegment


@pytest.fixture
def client():
    return TestClient(app, raise_server_exceptions=False)


def _no_auth():
    """Context manager to disable auth and rate limiting for test requests."""
    return patch("app.main.settings", **{
        "inference_api_key": SecretStr(""),
        "max_request_body_bytes": 50 * 1024 * 1024,
        "rate_limit_enabled": False,
    })


def _make_pcm_b64(duration_s: float = 1.0, sample_rate: int = 16000) -> str:
    """Generate a base64-encoded silent PCM16 payload."""
    n_samples = int(duration_s * sample_rate)
    pcm = struct.pack(f"<{n_samples}h", *([0] * n_samples))
    return base64.b64encode(pcm).decode()


class TestSdDiarizeDisabled:
    def test_returns_501_when_disabled(self, client):
        """When ENABLE_DIARIZATION=false, endpoint should return 501."""
        mock_settings = MagicMock()
        mock_settings.enable_diarization = False

        mock_runtime = MagicMock()
        mock_runtime.settings = mock_settings

        with _no_auth(), patch("app.main.runtime", mock_runtime):
            resp = client.post("/sd/diarize", json={
                "session_id": "test-session",
                "audio": {
                    "content_b64": _make_pcm_b64(0.5),
                    "format": "pcm_s16le",
                    "sample_rate": 16000,
                    "channels": 1,
                },
            })
            assert resp.status_code == 501


class TestSdDiarizeSchema:
    def test_response_has_required_fields(self, client):
        """Response should match DiarizeResponse schema."""
        mock_result = DiarizeResult(
            segments=[
                SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=3000),
                SpeakerSegment(id="seg_0001", speaker_id="SPEAKER_01", start_ms=3000, end_ms=5000),
            ],
            embeddings={},
            num_speakers=2,
            duration_ms=5000,
            processing_time_ms=200,
        )

        mock_diarizer = MagicMock()
        mock_diarizer.diarize.return_value = mock_result

        mock_settings = MagicMock()
        mock_settings.enable_diarization = True

        mock_runtime = MagicMock()
        mock_runtime.settings = mock_settings

        with _no_auth(), \
             patch("app.main.runtime", mock_runtime), \
             patch("app.routes.batch._get_diarizer", return_value=mock_diarizer):
            resp = client.post("/sd/diarize", json={
                "session_id": "test-session",
                "audio": {
                    "content_b64": _make_pcm_b64(1.0),
                    "format": "pcm_s16le",
                    "sample_rate": 16000,
                    "channels": 1,
                },
            })

        assert resp.status_code == 200
        data = resp.json()
        assert "session_id" in data
        assert "tracks" in data
        assert data["session_id"] == "test-session"
        assert len(data["tracks"]) == 2
        assert data["tracks"][0]["speaker_id"] == "SPEAKER_00"
        assert data["tracks"][0]["start_ms"] == 0
        assert data["tracks"][0]["end_ms"] == 3000
