"""Tests for V1 incremental HTTP endpoints.

Tests feature flag gating, Redis availability, idempotency, and normal flow.
Uses FastAPI TestClient with mock runtime (no real models).
"""
from __future__ import annotations

import base64
import json
import struct
import wave
import io

import pytest
from unittest.mock import MagicMock, PropertyMock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_wav_b64(duration_s: float = 1.0, sr: int = 16000) -> str:
    """Generate a minimal valid WAV file as base64."""
    num_samples = int(sr * duration_s)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(b"\x00\x00" * num_samples)
    return base64.b64encode(buf.getvalue()).decode()


def _make_mock_runtime(v1_enabled: bool = True, redis_available: bool = True):
    """Build mock runtime with configurable feature flag and Redis state."""
    runtime = MagicMock()

    # Settings
    settings = MagicMock()
    settings.incremental_v1_enabled = v1_enabled
    runtime.settings = settings

    # Redis state
    if redis_available:
        redis_state = MagicMock()
        redis_state.is_already_processed.return_value = False
        redis_state.atomic_write_increment.return_value = True
        redis_state.get_meta.return_value = {
            "last_increment": "2",
            "last_audio_end_ms": "180000",
            "status": "recording",
        }
        redis_state.get_all_utterances.return_value = [
            {"speaker": "spk_00", "text": "hello", "start_ms": 0, "end_ms": 1500},
        ]
        redis_state.get_all_checkpoints.return_value = []
        redis_state.get_all_speaker_profiles.return_value = {}
        redis_state.cleanup_session.return_value = 5
        runtime.redis_state = redis_state
    else:
        runtime.redis_state = None

    # Mock incremental processor
    processor = MagicMock()
    mock_response = MagicMock()
    mock_response.session_id = "sess-1"
    mock_response.increment_index = 0
    mock_response.utterances = []
    mock_response.speaker_profiles = []
    mock_response.speaker_mapping = {}
    mock_response.checkpoint = None
    mock_response.diarization_time_ms = 100
    mock_response.transcription_time_ms = 200
    mock_response.total_processing_time_ms = 350
    mock_response.speakers_detected = 2
    mock_response.stable_speaker_map = False
    processor.process_increment.return_value = mock_response

    # Mock finalize response
    finalize_response = MagicMock()
    finalize_response.session_id = "sess-1"
    finalize_response.transcript = []
    finalize_response.speaker_stats = []
    finalize_response.report = None
    finalize_response.total_increments = 3
    finalize_response.total_audio_ms = 180000
    finalize_response.finalize_time_ms = 5000
    processor.finalize.return_value = finalize_response

    runtime.incremental_processor = processor
    return runtime


def _make_app(runtime) -> FastAPI:
    """Create a FastAPI test app with V1 router mounted."""
    from app.routes.incremental_v1 import v1_router
    app = FastAPI()
    app.state.runtime = runtime
    app.include_router(v1_router)
    return app


# --- Feature Flag Tests ---

class TestFeatureFlag:
    def test_process_chunk_returns_404_when_v1_disabled(self):
        runtime = _make_mock_runtime(v1_enabled=False)
        client = TestClient(_make_app(runtime))
        resp = client.post("/v1/incremental/process-chunk", json={
            "v": 1, "session_id": "sess-1", "increment_id": "inc-1",
            "increment_index": 0, "audio_b64": _make_wav_b64(),
            "audio_start_ms": 0, "audio_end_ms": 3000,
        })
        assert resp.status_code == 404
        data = resp.json()
        assert data["error"] == "V1 not enabled"
        assert data["v"] == 1

    def test_finalize_returns_404_when_v1_disabled(self):
        runtime = _make_mock_runtime(v1_enabled=False)
        client = TestClient(_make_app(runtime))
        resp = client.post("/v1/incremental/finalize", json={
            "v": 1, "session_id": "sess-1",
            "r2_audio_refs": [], "total_audio_ms": 180000,
        })
        assert resp.status_code == 404
        data = resp.json()
        assert data["error"] == "V1 not enabled"


# --- Redis Availability Tests ---

class TestRedisAvailability:
    def test_process_chunk_returns_503_without_redis(self):
        runtime = _make_mock_runtime(v1_enabled=True, redis_available=False)
        client = TestClient(_make_app(runtime))
        resp = client.post("/v1/incremental/process-chunk", json={
            "v": 1, "session_id": "sess-1", "increment_id": "inc-1",
            "increment_index": 0, "audio_b64": _make_wav_b64(),
            "audio_start_ms": 0, "audio_end_ms": 3000,
        })
        assert resp.status_code == 503
        assert "Redis" in resp.json()["error"]

    def test_finalize_returns_503_without_redis(self):
        runtime = _make_mock_runtime(v1_enabled=True, redis_available=False)
        client = TestClient(_make_app(runtime))
        resp = client.post("/v1/incremental/finalize", json={
            "v": 1, "session_id": "sess-1",
            "r2_audio_refs": [], "total_audio_ms": 180000,
        })
        assert resp.status_code == 503


# --- Idempotency Tests ---

class TestIdempotency:
    def test_duplicate_increment_id_returns_cached(self):
        runtime = _make_mock_runtime(v1_enabled=True)
        runtime.redis_state.is_already_processed.return_value = True
        client = TestClient(_make_app(runtime))

        resp = client.post("/v1/incremental/process-chunk", json={
            "v": 1, "session_id": "sess-1", "increment_id": "inc-dup",
            "increment_index": 0, "audio_b64": _make_wav_b64(),
            "audio_start_ms": 0, "audio_end_ms": 3000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["metrics"]["idempotent_reject"] is True
        # Processor should NOT have been called
        runtime.incremental_processor.process_increment.assert_not_called()


# --- Normal Flow Tests ---

class TestProcessChunkV1:
    def test_happy_path(self):
        runtime = _make_mock_runtime(v1_enabled=True)
        client = TestClient(_make_app(runtime))

        resp = client.post("/v1/incremental/process-chunk", json={
            "v": 1, "session_id": "sess-1", "increment_id": "inc-001",
            "increment_index": 0, "audio_b64": _make_wav_b64(),
            "audio_start_ms": 0, "audio_end_ms": 3000,
            "language": "auto", "run_analysis": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["v"] == 1
        assert data["session_id"] == "sess-1"
        assert data["increment_id"] == "inc-001"
        assert "processing_ms" in data["metrics"]
        assert data["metrics"]["was_written"] is True

        # Verify processor was called
        runtime.incremental_processor.process_increment.assert_called_once()

        # Verify Redis atomic write was called
        runtime.redis_state.atomic_write_increment.assert_called_once()


class TestFinalizeV1:
    def test_happy_path(self):
        runtime = _make_mock_runtime(v1_enabled=True)
        client = TestClient(_make_app(runtime))

        resp = client.post("/v1/incremental/finalize", json={
            "v": 1, "session_id": "sess-1",
            "r2_audio_refs": [
                {"key": "sessions/sess-1/chunks/0.pcm", "start_ms": 0, "end_ms": 60000},
                {"key": "sessions/sess-1/chunks/1.pcm", "start_ms": 60000, "end_ms": 120000},
            ],
            "total_audio_ms": 180000,
            "locale": "en-US",
            "memos": [], "stats": [], "evidence": [],
            "name_aliases": {},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["v"] == 1
        assert data["session_id"] == "sess-1"
        assert "finalize_ms" in data["metrics"]
        assert "merged_speaker_count" in data["metrics"]

        # Redis merge-only: processor.finalize is NOT called
        runtime.incremental_processor.finalize.assert_not_called()

        # Verify Redis cleanup was called
        runtime.redis_state.cleanup_session.assert_called_once_with("sess-1")

    def test_finalize_reads_redis_state(self):
        """Verify finalize reads pre-computed state from Redis."""
        runtime = _make_mock_runtime(v1_enabled=True)
        client = TestClient(_make_app(runtime))

        client.post("/v1/incremental/finalize", json={
            "v": 1, "session_id": "sess-1",
            "r2_audio_refs": [], "total_audio_ms": 180000,
        })

        # Verify Redis reads were made
        runtime.redis_state.get_meta.assert_called_once_with("sess-1")
        runtime.redis_state.get_all_utterances.assert_called_once_with("sess-1")
        runtime.redis_state.get_all_checkpoints.assert_called_once_with("sess-1")
        runtime.redis_state.get_all_speaker_profiles.assert_called_once_with("sess-1")


# --- Schema Validation Tests ---

class TestSchemaValidation:
    def test_process_chunk_rejects_wrong_version(self):
        runtime = _make_mock_runtime(v1_enabled=True)
        client = TestClient(_make_app(runtime))

        resp = client.post("/v1/incremental/process-chunk", json={
            "v": 2, "session_id": "sess-1", "increment_id": "inc-1",
            "increment_index": 0, "audio_b64": _make_wav_b64(),
            "audio_start_ms": 0, "audio_end_ms": 3000,
        })
        assert resp.status_code == 422  # Pydantic validation error

    def test_process_chunk_requires_session_id(self):
        runtime = _make_mock_runtime(v1_enabled=True)
        client = TestClient(_make_app(runtime))

        resp = client.post("/v1/incremental/process-chunk", json={
            "v": 1, "increment_id": "inc-1",
            "increment_index": 0, "audio_b64": _make_wav_b64(),
            "audio_start_ms": 0, "audio_end_ms": 3000,
        })
        assert resp.status_code == 422

    def test_finalize_rejects_wrong_version(self):
        runtime = _make_mock_runtime(v1_enabled=True)
        client = TestClient(_make_app(runtime))

        resp = client.post("/v1/incremental/finalize", json={
            "v": 2, "session_id": "sess-1",
            "r2_audio_refs": [], "total_audio_ms": 180000,
        })
        assert resp.status_code == 422
