"""Tests for WebSocket incremental endpoint.

Uses FastAPI TestClient + mock processor to test the WS handshake,
frame protocol, and error handling without real models.
"""
import json
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services.ws_protocol import SCHEMA_VERSION, encode_pcm_frame


def _make_mock_response():
    """Build a mock IncrementalProcessResponse."""
    mock_profile = MagicMock()
    mock_profile.speaker_id = "spk_00"
    mock_profile.model_dump.return_value = {
        "speaker_id": "spk_00",
        "total_speech_ms": 3000,
    }

    mock_utterance = MagicMock()
    mock_utterance.model_dump.return_value = {
        "speaker": "spk_00",
        "text": "hello",
        "start_ms": 0,
        "end_ms": 1500,
    }

    response = MagicMock()
    response.speaker_profiles = [mock_profile]
    response.utterances = [mock_utterance]
    response.checkpoint = None
    response.diarization_time_ms = 500
    response.transcription_time_ms = 300
    response.total_processing_time_ms = 1000
    response.speakers_detected = 1
    response.stable_speaker_map = False
    return response


@pytest.fixture
def mock_runtime():
    """Build a mock AppRuntime with mock IncrementalProcessor."""
    runtime = MagicMock()
    runtime.incremental_processor = MagicMock()
    runtime.redis_state = MagicMock()
    runtime.settings = MagicMock()
    runtime.settings.incremental_v1_enabled = True

    # Mock process_increment to return IncrementalProcessResponse
    runtime.incremental_processor.process_increment.return_value = _make_mock_response()

    # Mock idempotency check (read-only pre-check + atomic write)
    runtime.redis_state.is_already_processed.return_value = False
    runtime.redis_state.atomic_write_increment.return_value = True
    runtime.redis_state.acquire_session_lock.return_value = True
    runtime.redis_state.release_session_lock.return_value = True
    return runtime


@pytest.fixture
def app(mock_runtime):
    from app.routes.ws_incremental import create_ws_app
    return create_ws_app(mock_runtime)


def test_ws_happy_path(app, mock_runtime):
    """Full protocol: start -> PCM frames -> end -> result."""
    client = TestClient(app)

    start_frame = {
        "v": SCHEMA_VERSION,
        "type": "start",
        "session_id": "sess-1",
        "increment_id": "uuid-001",
        "increment_index": 0,
        "audio_start_ms": 0,
        "audio_end_ms": 3000,
        "language": "en",
        "run_analysis": False,
        "total_frames": 2,
        "sample_rate": 16000,
        "channels": 1,
        "bit_depth": 16,
    }

    pcm_chunk = b'\x00\x01' * 512  # 1KB per frame

    with client.websocket_connect("/ws/v1/increment") as ws:
        # Send start
        ws.send_text(json.dumps(start_frame))
        # Send 2 PCM frames
        ws.send_bytes(encode_pcm_frame(0, pcm_chunk))
        ws.send_bytes(encode_pcm_frame(1, pcm_chunk))
        # Send end
        ws.send_text(json.dumps({
            "type": "end",
            "total_frames_sent": 2,
            "total_bytes_sent": len(pcm_chunk) * 2,
        }))
        # Receive result
        result = json.loads(ws.receive_text())
        assert result["type"] == "result"
        assert result["v"] == SCHEMA_VERSION
        assert result["session_id"] == "sess-1"


def test_ws_rejects_bad_version(app):
    client = TestClient(app)
    with client.websocket_connect("/ws/v1/increment") as ws:
        ws.send_text(json.dumps({"v": 99, "type": "start", "session_id": "s"}))
        result = json.loads(ws.receive_text())
        assert result["type"] == "error"
        assert "version" in result["message"].lower()


def test_ws_rejects_duplicate_increment(app, mock_runtime):
    """Constraint 2: duplicate increment_id is rejected."""
    mock_runtime.redis_state.is_already_processed.return_value = True  # duplicate

    client = TestClient(app)
    start_frame = {
        "v": 1, "type": "start", "session_id": "sess-1",
        "increment_id": "uuid-dup", "increment_index": 0,
        "audio_start_ms": 0, "audio_end_ms": 3000,
        "language": "en", "run_analysis": False,
        "total_frames": 1,
    }
    with client.websocket_connect("/ws/v1/increment") as ws:
        ws.send_text(json.dumps(start_frame))
        result = json.loads(ws.receive_text())
        assert result["type"] == "error"
        assert "idempotent" in result["message"].lower() or "duplicate" in result["message"].lower()


def test_ws_rejects_frame_count_mismatch(app, mock_runtime):
    """Design doc hard constraint: frame count MUST match total_frames."""
    client = TestClient(app)
    start_frame = {
        "v": 1, "type": "start", "session_id": "sess-1",
        "increment_id": "uuid-mismatch", "increment_index": 0,
        "audio_start_ms": 0, "audio_end_ms": 3000,
        "language": "en", "run_analysis": False,
        "total_frames": 5,  # Expect 5 frames
    }
    pcm_chunk = encode_pcm_frame(0, b"\x00" * 320)

    with client.websocket_connect("/ws/v1/increment") as ws:
        ws.send_text(json.dumps(start_frame))
        # Send only 1 frame instead of 5
        ws.send_bytes(pcm_chunk)
        ws.send_text(json.dumps({"type": "end"}))
        result = json.loads(ws.receive_text())
        assert result["type"] == "error"
        assert result["code"] == "FRAME_COUNT_MISMATCH"
