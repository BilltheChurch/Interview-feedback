"""Integration tests for /batch/process endpoint response schema.

Verifies the response schema matches what Edge Worker Tier 2 expects.
Uses mocked ASR and diarization backends to avoid model loading.

The Edge Worker (index.ts runTier2Job) casts the response as:
  {
    transcript?: Array<{
      utterance_id?: string;
      speaker?: string;
      text?: string;
      start_ms?: number;
      end_ms?: number;
    }>;
    speaker_stats?: Record<string, unknown>;
    diarization?: Record<string, unknown>;
  }

This test suite confirms the inference endpoint returns data that satisfies
those expectations, including:
  - Each transcript utterance has a 'speaker' field
  - speaker_stats is a list with speaker_id, total_duration_ms, segment_count, talk_ratio
  - The merge assigns the correct speaker based on time overlap
  - Data URI audio_url (data:audio/wav;base64,...) is properly resolved
"""

from __future__ import annotations

import base64
import os
import struct
import tempfile
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp
from app.services.diarize_full import DiarizeResult, SpeakerSegment


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _mock_transcript_result() -> TranscriptResult:
    return TranscriptResult(
        utterances=[
            Utterance(
                id="utt_0001",
                text="Hello everyone",
                start_ms=0,
                end_ms=2000,
                words=[],
                language="en",
                confidence=0.95,
            ),
            Utterance(
                id="utt_0002",
                text="Nice to meet you",
                start_ms=2500,
                end_ms=4000,
                words=[],
                language="en",
                confidence=0.90,
            ),
        ],
        language="en",
        duration_ms=10000,
        processing_time_ms=500,
        backend="sensevoice",
        model_size="SenseVoiceSmall",
    )


def _mock_diarize_result() -> DiarizeResult:
    return DiarizeResult(
        segments=[
            SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=2500),
            SpeakerSegment(id="seg_0001", speaker_id="SPEAKER_01", start_ms=2500, end_ms=5000),
            SpeakerSegment(id="seg_0002", speaker_id="SPEAKER_00", start_ms=5000, end_ms=8000),
        ],
        embeddings={"SPEAKER_00": [0.1] * 256, "SPEAKER_01": [0.2] * 256},
        num_speakers=2,
        duration_ms=10000,
        processing_time_ms=300,
    )


@pytest.fixture()
def _tmp_audio(monkeypatch):
    """Create a temp audio file for testing inside the allowed directory."""
    tmp_dir = tempfile.mkdtemp()
    monkeypatch.setenv("AUDIO_UPLOAD_DIR", tmp_dir)
    audio_path = Path(tmp_dir) / "test_audio.wav"
    audio_path.write_bytes(b"\x00" * 1000)
    yield str(audio_path)
    audio_path.unlink(missing_ok=True)
    Path(tmp_dir).rmdir()


def _no_auth():
    """Context manager to disable auth and rate limiting for test requests."""
    return patch("app.main.settings", **{
        "inference_api_key": SecretStr(""),
        "max_request_body_bytes": 50 * 1024 * 1024,
        "rate_limit_enabled": False,
    })


def _make_tiny_wav_base64() -> str:
    """Create a minimal valid WAV file and return as base64-encoded data URI."""
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        # 0.1 seconds of silence (1600 samples * 2 bytes)
        wf.writeframes(b"\x00" * 3200)
    raw = buf.getvalue()
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:audio/wav;base64,{b64}"


# ---------------------------------------------------------------------------
# Response schema tests
# ---------------------------------------------------------------------------


class TestBatchProcessResponseSchema:
    """Verify /batch/process response matches Edge Worker Tier 2 expectations."""

    def test_response_has_all_required_fields(self, _tmp_audio: str):
        """Response must have transcript, speaker_stats, language, duration_ms,
        transcription_time_ms, diarization_time_ms, total_processing_time_ms."""
        mock_asr = MagicMock()
        mock_asr.transcribe.return_value = _mock_transcript_result()

        mock_diarizer = MagicMock()
        mock_diarizer.diarize.return_value = _mock_diarize_result()

        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with (
            _no_auth(),
            patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)),
            patch("app.routes.batch._get_diarizer", return_value=mock_diarizer),
        ):
            resp = client.post("/batch/process", json={
                "audio_url": _tmp_audio,
                "language": "auto",
            })

        assert resp.status_code == 200
        data = resp.json()

        # Required top-level fields the Edge Worker accesses
        assert "transcript" in data
        assert "speaker_stats" in data
        assert "language" in data
        assert "duration_ms" in data
        assert "transcription_time_ms" in data
        assert "diarization_time_ms" in data
        assert "total_processing_time_ms" in data

    def test_transcript_utterances_have_speaker(self, _tmp_audio: str):
        """Each utterance in transcript MUST have a 'speaker' field.

        The Edge Worker reads `item.speaker` for every transcript item
        (index.ts line ~6322: `speaker_name: item.speaker ?? null`).
        """
        mock_asr = MagicMock()
        mock_asr.transcribe.return_value = _mock_transcript_result()

        mock_diarizer = MagicMock()
        mock_diarizer.diarize.return_value = _mock_diarize_result()

        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with (
            _no_auth(),
            patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)),
            patch("app.routes.batch._get_diarizer", return_value=mock_diarizer),
        ):
            resp = client.post("/batch/process", json={
                "audio_url": _tmp_audio,
                "language": "en",
            })

        data = resp.json()
        assert len(data["transcript"]) > 0, "Must return at least one utterance"

        for idx, utt in enumerate(data["transcript"]):
            assert "speaker" in utt, f"Utterance {idx} missing 'speaker' field"
            assert "text" in utt, f"Utterance {idx} missing 'text' field"
            assert "start_ms" in utt, f"Utterance {idx} missing 'start_ms' field"
            assert "end_ms" in utt, f"Utterance {idx} missing 'end_ms' field"
            assert "id" in utt, f"Utterance {idx} missing 'id' field"

    def test_speaker_stats_schema(self, _tmp_audio: str):
        """speaker_stats must be a list of objects with speaker_id, total_duration_ms,
        segment_count, and talk_ratio.

        The Edge Worker reads speaker_stats for re-reconciliation (index.ts ~6341).
        """
        mock_asr = MagicMock()
        mock_asr.transcribe.return_value = _mock_transcript_result()

        mock_diarizer = MagicMock()
        mock_diarizer.diarize.return_value = _mock_diarize_result()

        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with (
            _no_auth(),
            patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)),
            patch("app.routes.batch._get_diarizer", return_value=mock_diarizer),
        ):
            resp = client.post("/batch/process", json={
                "audio_url": _tmp_audio,
                "language": "auto",
            })

        data = resp.json()
        assert len(data["speaker_stats"]) == 2, "Expected 2 speakers: SPEAKER_00 and SPEAKER_01"

        for stat in data["speaker_stats"]:
            assert "speaker_id" in stat
            assert "total_duration_ms" in stat
            assert "segment_count" in stat
            assert "talk_ratio" in stat
            assert isinstance(stat["total_duration_ms"], int)
            assert isinstance(stat["segment_count"], int)
            assert isinstance(stat["talk_ratio"], float)

        # Talk ratios should sum to 1.0
        total_ratio = sum(s["talk_ratio"] for s in data["speaker_stats"])
        assert abs(total_ratio - 1.0) < 0.01

    def test_merge_assigns_correct_speakers(self, _tmp_audio: str):
        """Verify the merge logic assigns the right speaker based on time overlap.

        utt_0001 (0-2000ms) overlaps seg_0000 (0-2500ms SPEAKER_00) -> SPEAKER_00
        utt_0002 (2500-4000ms) overlaps seg_0001 (2500-5000ms SPEAKER_01) -> SPEAKER_01
        """
        mock_asr = MagicMock()
        mock_asr.transcribe.return_value = _mock_transcript_result()

        mock_diarizer = MagicMock()
        mock_diarizer.diarize.return_value = _mock_diarize_result()

        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with (
            _no_auth(),
            patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)),
            patch("app.routes.batch._get_diarizer", return_value=mock_diarizer),
        ):
            resp = client.post("/batch/process", json={
                "audio_url": _tmp_audio,
                "language": "auto",
            })

        data = resp.json()
        # utt_0001 (0-2000ms) fully inside seg_0000 (0-2500ms) -> SPEAKER_00
        assert data["transcript"][0]["speaker"] == "SPEAKER_00"
        assert data["transcript"][0]["id"] == "utt_0001"
        # utt_0002 (2500-4000ms) fully inside seg_0001 (2500-5000ms) -> SPEAKER_01
        assert data["transcript"][1]["speaker"] == "SPEAKER_01"
        assert data["transcript"][1]["id"] == "utt_0002"

    def test_edge_worker_casts_transcript_fields(self, _tmp_audio: str):
        """The Edge Worker casts each transcript item as:
            utterance_id?: string  (maps from 'id')
            speaker?: string
            text?: string
            start_ms?: number
            end_ms?: number

        Verify all these fields are present and have correct types.
        """
        mock_asr = MagicMock()
        mock_asr.transcribe.return_value = _mock_transcript_result()

        mock_diarizer = MagicMock()
        mock_diarizer.diarize.return_value = _mock_diarize_result()

        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with (
            _no_auth(),
            patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)),
            patch("app.routes.batch._get_diarizer", return_value=mock_diarizer),
        ):
            resp = client.post("/batch/process", json={
                "audio_url": _tmp_audio,
                "language": "en",
            })

        data = resp.json()
        for utt in data["transcript"]:
            # The Edge Worker reads item.utterance_id ?? `tier2_utt_${idx}`
            # but the inference returns 'id' — the Worker falls back to idx-based ID.
            # Still, 'id' must be present as a string.
            assert isinstance(utt["id"], str)
            assert isinstance(utt["speaker"], str)
            assert isinstance(utt["text"], str)
            assert isinstance(utt["start_ms"], int)
            assert isinstance(utt["end_ms"], int)


class TestBatchProcessDataUri:
    """Verify /batch/process handles data: URIs sent by Edge Worker Tier 2."""

    def test_data_uri_audio_is_accepted(self):
        """Edge Worker sends audio as data:audio/wav;base64,... — this must work."""
        mock_asr = MagicMock()
        mock_asr.transcribe.return_value = _mock_transcript_result()

        mock_diarizer = MagicMock()
        mock_diarizer.diarize.return_value = _mock_diarize_result()

        audio_data_uri = _make_tiny_wav_base64()

        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with (
            _no_auth(),
            patch.object(app.state, "runtime", MagicMock(asr_backend=mock_asr)),
            patch("app.routes.batch._get_diarizer", return_value=mock_diarizer),
        ):
            resp = client.post("/batch/process", json={
                "audio_url": audio_data_uri,
                "language": "en",
            })

        assert resp.status_code == 200
        data = resp.json()
        assert "transcript" in data
        assert "speaker_stats" in data
        # The mocked ASR was called (proves data URI was resolved to a temp file)
        mock_asr.transcribe.assert_called_once()

    def test_malformed_data_uri_returns_400(self):
        """A data URI without comma separator should fail gracefully."""
        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with _no_auth():
            resp = client.post("/batch/process", json={
                "audio_url": "data:audio/wav;base64NOCOMMA",
                "language": "en",
            })

        assert resp.status_code == 400
        assert "Malformed data URI" in resp.json()["detail"]

    def test_non_base64_data_uri_returns_400(self):
        """A data URI without ;base64 encoding marker should fail."""
        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with _no_auth():
            resp = client.post("/batch/process", json={
                "audio_url": "data:audio/wav,not-base64-content",
                "language": "en",
            })

        assert resp.status_code == 400
        assert "base64" in resp.json()["detail"].lower()

    def test_invalid_base64_payload_returns_400(self):
        """Invalid base64 content should fail with a clear error."""
        from app.main import app

        client = TestClient(app, raise_server_exceptions=False)
        with _no_auth():
            resp = client.post("/batch/process", json={
                "audio_url": "data:audio/wav;base64,!!!not-valid-base64!!!",
                "language": "en",
            })

        assert resp.status_code == 400
        assert "decode" in resp.json()["detail"].lower()
