"""Tests for batch processing API endpoints.

Tests use FastAPI TestClient with mocked Whisper and pyannote services.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch, AsyncMock

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp
from app.services.diarize_full import DiarizeResult, SpeakerSegment
from app.routes.batch import (
    _find_best_speaker,
    _compute_speaker_stats,
    _merge_transcript_diarization,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _mock_transcript() -> TranscriptResult:
    return TranscriptResult(
        utterances=[
            Utterance(
                id="u_0000",
                text="Hello everyone",
                start_ms=0,
                end_ms=3000,
                words=[
                    WordTimestamp(word="Hello", start_ms=0, end_ms=500, confidence=0.95),
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
                language="en",
                confidence=0.85,
            ),
            Utterance(
                id="u_0002",
                text="Thank you",
                start_ms=8000,
                end_ms=10000,
                language="en",
            ),
        ],
        language="en",
        duration_ms=10000,
        processing_time_ms=500,
        backend="faster-whisper",
        model_size="large-v3",
    )


def _mock_diarize() -> DiarizeResult:
    return DiarizeResult(
        segments=[
            SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=4000),
            SpeakerSegment(id="seg_0001", speaker_id="SPEAKER_01", start_ms=4000, end_ms=7000),
            SpeakerSegment(id="seg_0002", speaker_id="SPEAKER_00", start_ms=7500, end_ms=10000),
        ],
        embeddings={
            "SPEAKER_00": [0.1, 0.2, 0.3],
            "SPEAKER_01": [0.4, 0.5, 0.6],
        },
        num_speakers=2,
        duration_ms=10000,
        processing_time_ms=800,
    )


# ---------------------------------------------------------------------------
# Unit tests: merge logic
# ---------------------------------------------------------------------------


def test_find_best_speaker_full_overlap():
    utt = Utterance(id="u", text="hi", start_ms=0, end_ms=3000)
    segments = [
        SpeakerSegment(id="s0", speaker_id="A", start_ms=0, end_ms=5000),
    ]
    assert _find_best_speaker(utt, segments) == "A"


def test_find_best_speaker_partial_overlap():
    utt = Utterance(id="u", text="hi", start_ms=2000, end_ms=6000)
    segments = [
        SpeakerSegment(id="s0", speaker_id="A", start_ms=0, end_ms=3000),  # 1000ms overlap
        SpeakerSegment(id="s1", speaker_id="B", start_ms=3000, end_ms=8000),  # 3000ms overlap
    ]
    assert _find_best_speaker(utt, segments) == "B"


def test_find_best_speaker_no_overlap():
    utt = Utterance(id="u", text="hi", start_ms=10000, end_ms=12000)
    segments = [
        SpeakerSegment(id="s0", speaker_id="A", start_ms=0, end_ms=5000),
    ]
    assert _find_best_speaker(utt, segments) == "_unknown"


def test_find_best_speaker_empty_segments():
    utt = Utterance(id="u", text="hi", start_ms=0, end_ms=1000)
    assert _find_best_speaker(utt, []) == "_unknown"


def test_compute_speaker_stats():
    diarize = _mock_diarize()
    stats = _compute_speaker_stats(diarize)

    assert len(stats) == 2
    # SPEAKER_00: 4000ms + 2500ms = 6500ms
    s0 = next(s for s in stats if s.speaker_id == "SPEAKER_00")
    assert s0.total_duration_ms == 6500
    assert s0.segment_count == 2

    # SPEAKER_01: 3000ms
    s1 = next(s for s in stats if s.speaker_id == "SPEAKER_01")
    assert s1.total_duration_ms == 3000
    assert s1.segment_count == 1

    # Talk ratios should sum to ~1.0
    total_ratio = sum(s.talk_ratio for s in stats)
    assert abs(total_ratio - 1.0) < 0.01


def test_compute_speaker_stats_empty():
    diarize = DiarizeResult(
        segments=[], embeddings={}, num_speakers=0, duration_ms=0, processing_time_ms=0
    )
    stats = _compute_speaker_stats(diarize)
    assert stats == []


def test_merge_transcript_diarization():
    transcript = _mock_transcript()
    diarize = _mock_diarize()
    merged = _merge_transcript_diarization(transcript, diarize)

    assert len(merged) == 3

    # "Hello everyone" (0-3000ms) overlaps SPEAKER_00 (0-4000ms) fully
    assert merged[0].speaker == "SPEAKER_00"
    assert merged[0].text == "Hello everyone"
    assert len(merged[0].words) == 2

    # "Nice to meet you" (3000-6000ms) overlaps SPEAKER_00 (0-4000, 1000ms) and SPEAKER_01 (4000-7000, 2000ms)
    assert merged[1].speaker == "SPEAKER_01"

    # "Thank you" (8000-10000ms) overlaps SPEAKER_00 (7500-10000, 2000ms)
    assert merged[2].speaker == "SPEAKER_00"


# ---------------------------------------------------------------------------
# API endpoint tests (mocked services)
# ---------------------------------------------------------------------------


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


def test_batch_transcribe_endpoint(_tmp_audio: str):
    """Test POST /batch/transcribe with mocked Whisper."""
    mock_result = _mock_transcript()

    mock_transcriber = MagicMock()
    mock_transcriber.transcribe.return_value = mock_result

    from app.main import app

    client = TestClient(app, raise_server_exceptions=False)
    with _no_auth(), patch("app.routes.batch._get_whisper", return_value=mock_transcriber):
        resp = client.post(
            "/batch/transcribe",
            json={"audio_url": _tmp_audio, "language": "en", "model": "large-v3"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["language"] == "en"
    assert data["backend"] == "faster-whisper"
    assert len(data["utterances"]) == 3
    assert data["utterances"][0]["text"] == "Hello everyone"
    assert len(data["utterances"][0]["words"]) == 2


def test_batch_diarize_endpoint(_tmp_audio: str):
    """Test POST /batch/diarize with mocked pyannote."""
    mock_result = _mock_diarize()

    mock_diarizer = MagicMock()
    mock_diarizer.diarize.return_value = mock_result

    from app.main import app

    client = TestClient(app, raise_server_exceptions=False)
    with _no_auth(), patch("app.routes.batch._get_diarizer", return_value=mock_diarizer):
        resp = client.post(
            "/batch/diarize",
            json={"audio_url": _tmp_audio, "num_speakers": 2},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["num_speakers"] == 2
    assert len(data["segments"]) == 3
    assert data["segments"][0]["speaker_id"] == "SPEAKER_00"
    assert "SPEAKER_00" in data["embeddings"]
    assert data["global_clustering_done"] is True


def test_batch_process_endpoint(_tmp_audio: str):
    """Test POST /batch/process — combined transcribe + diarize."""
    mock_transcript_r = _mock_transcript()
    mock_diarize_result = _mock_diarize()

    mock_transcriber = MagicMock()
    mock_transcriber.transcribe.return_value = mock_transcript_r

    mock_diarizer = MagicMock()
    mock_diarizer.diarize.return_value = mock_diarize_result

    from app.main import app

    client = TestClient(app, raise_server_exceptions=False)
    with (
        _no_auth(),
        patch("app.routes.batch._get_whisper", return_value=mock_transcriber),
        patch("app.routes.batch._get_diarizer", return_value=mock_diarizer),
    ):
        resp = client.post(
            "/batch/process",
            json={"audio_url": _tmp_audio, "num_speakers": 2, "language": "en"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert len(data["transcript"]) == 3
    assert data["transcript"][0]["speaker"] == "SPEAKER_00"
    assert data["transcript"][0]["text"] == "Hello everyone"
    assert len(data["speaker_stats"]) == 2
    assert data["language"] == "en"
    assert data["transcription_time_ms"] >= 0
    assert data["diarization_time_ms"] >= 0


def test_batch_transcribe_file_not_found(monkeypatch, tmp_path):
    """Test that a missing local file returns 400."""
    monkeypatch.setenv("AUDIO_UPLOAD_DIR", str(tmp_path))
    from app.main import app

    client = TestClient(app, raise_server_exceptions=False)
    with _no_auth():
        resp = client.post(
            "/batch/transcribe",
            json={"audio_url": str(tmp_path / "nonexistent.wav")},
        )
    assert resp.status_code == 400
    assert "not found" in resp.json()["detail"]


def test_batch_transcribe_path_traversal_blocked(monkeypatch, tmp_path):
    """Test that path traversal outside allowed directory is blocked."""
    monkeypatch.setenv("AUDIO_UPLOAD_DIR", str(tmp_path / "allowed"))
    from app.main import app

    client = TestClient(app, raise_server_exceptions=False)
    with _no_auth():
        resp = client.post(
            "/batch/transcribe",
            json={"audio_url": "/etc/passwd"},
        )
    assert resp.status_code == 400
    assert "not in allowed directory" in resp.json()["detail"]


def test_batch_transcribe_422_for_empty_body():
    """Test that missing required fields return 422."""
    from app.main import app

    client = TestClient(app, raise_server_exceptions=False)
    with _no_auth():
        resp = client.post("/batch/transcribe", json={})
    assert resp.status_code == 422
