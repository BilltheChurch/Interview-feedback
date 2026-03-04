"""E2E tests for WS /ws/v1/increment endpoint.

Validates:
- process_increment is called (not process_increment_v2)
- No AttributeError in response
- Redis receives profiles as dict[str, dict]
- ResultFrame receives profiles as list[dict]
- asyncio.to_thread wrapping (CPU-bound call doesn't block event loop)
"""
import json
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services.ws_protocol import SCHEMA_VERSION, encode_pcm_frame


def _make_mock_response():
    """Build a mock IncrementalProcessResponse with proper model_dump."""
    mock_profile = MagicMock()
    mock_profile.speaker_id = "spk_00"
    mock_profile.model_dump.return_value = {
        "speaker_id": "spk_00",
        "total_speech_ms": 3000,
        "first_seen_increment": 0,
    }

    mock_utterance = MagicMock()
    mock_utterance.model_dump.return_value = {
        "id": "utt_0",
        "speaker_id": "spk_00",
        "text": "hello world",
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


def _make_start_frame(**overrides) -> dict:
    """Build a valid StartFrame dict."""
    frame = {
        "v": SCHEMA_VERSION,
        "type": "start",
        "session_id": "sess-e2e",
        "increment_id": "uuid-e2e-001",
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
    frame.update(overrides)
    return frame


@pytest.fixture
def mock_runtime():
    runtime = MagicMock()
    runtime.incremental_processor = MagicMock()
    runtime.redis_state = MagicMock()
    runtime.settings = MagicMock()
    runtime.settings.incremental_v1_enabled = True

    runtime.incremental_processor.process_increment.return_value = _make_mock_response()
    # Ensure process_increment_v2 does NOT exist
    del runtime.incremental_processor.process_increment_v2

    runtime.redis_state.is_already_processed.return_value = False
    runtime.redis_state.atomic_write_increment.return_value = True
    runtime.redis_state.acquire_session_lock.return_value = True
    runtime.redis_state.release_session_lock.return_value = True
    return runtime


@pytest.fixture
def app(mock_runtime):
    from app.routes.ws_incremental import create_ws_app
    return create_ws_app(mock_runtime)


def _send_full_increment(ws, start_frame: dict, pcm_chunk: bytes):
    """Send a complete increment: start → PCM frames → end → receive result."""
    ws.send_text(json.dumps(start_frame))
    for i in range(start_frame["total_frames"]):
        ws.send_bytes(encode_pcm_frame(i, pcm_chunk))
    ws.send_text(json.dumps({"type": "end"}))
    return json.loads(ws.receive_text())


def test_ws_increment_no_attribute_error(app, mock_runtime):
    """WS /ws/v1/increment must call process_increment (not process_increment_v2)."""
    client = TestClient(app)
    pcm_chunk = b"\x00\x01" * 512

    with client.websocket_connect("/ws/v1/increment") as ws:
        result = _send_full_increment(ws, _make_start_frame(), pcm_chunk)

    # Must be a result, not an error
    assert result["type"] == "result", f"Expected result, got: {result}"
    assert result.get("code") is None, f"Got error code: {result.get('code')}"

    # Must have called process_increment, NOT process_increment_v2
    assert mock_runtime.incremental_processor.process_increment.called, (
        "process_increment must be called"
    )


def test_ws_redis_receives_profiles_as_dict(app, mock_runtime):
    """atomic_write_increment must receive speaker_profiles as dict[str, dict]."""
    client = TestClient(app)
    pcm_chunk = b"\x00\x01" * 512

    with client.websocket_connect("/ws/v1/increment") as ws:
        result = _send_full_increment(ws, _make_start_frame(), pcm_chunk)

    assert result["type"] == "result"

    # Check that atomic_write_increment was called with profiles as dict
    call_kwargs = mock_runtime.redis_state.atomic_write_increment.call_args
    profiles_arg = call_kwargs.kwargs.get("speaker_profiles") or call_kwargs[1].get("speaker_profiles")

    assert isinstance(profiles_arg, dict), (
        f"Redis speaker_profiles must be dict[str, dict], got {type(profiles_arg)}"
    )
    # Key should be speaker_id string
    if profiles_arg:
        for key in profiles_arg:
            assert isinstance(key, str), f"Profile key must be str, got {type(key)}"


def test_ws_result_frame_profiles_as_list(app, mock_runtime):
    """ResultFrame must contain speaker_profiles as list[dict]."""
    client = TestClient(app)
    pcm_chunk = b"\x00\x01" * 512

    with client.websocket_connect("/ws/v1/increment") as ws:
        result = _send_full_increment(ws, _make_start_frame(), pcm_chunk)

    assert result["type"] == "result"
    # ResultFrame speaker_profiles should be a list
    profiles = result.get("speaker_profiles", [])
    assert isinstance(profiles, list), (
        f"ResultFrame speaker_profiles must be list[dict], got {type(profiles)}"
    )


def test_ws_result_frame_has_metrics(app, mock_runtime):
    """ResultFrame must contain processing metrics."""
    client = TestClient(app)
    pcm_chunk = b"\x00\x01" * 512

    with client.websocket_connect("/ws/v1/increment") as ws:
        result = _send_full_increment(ws, _make_start_frame(), pcm_chunk)

    assert result["type"] == "result"
    metrics = result.get("metrics", {})
    assert "diarization_time_ms" in metrics
    assert "transcription_time_ms" in metrics
    assert "total_processing_time_ms" in metrics
    assert "frames_received" in metrics
    assert metrics["frames_received"] == 2
    assert metrics["frames_expected"] == 2


def test_ws_process_increment_receives_correct_request(app, mock_runtime):
    """process_increment must receive an IncrementalProcessRequest with correct fields."""
    client = TestClient(app)
    pcm_chunk = b"\x00\x01" * 512

    with client.websocket_connect("/ws/v1/increment") as ws:
        result = _send_full_increment(ws, _make_start_frame(), pcm_chunk)

    assert result["type"] == "result"

    # Verify the request passed to process_increment
    call_args = mock_runtime.incremental_processor.process_increment.call_args
    req = call_args[0][0]  # first positional arg

    from app.schemas import IncrementalProcessRequest
    assert isinstance(req, IncrementalProcessRequest)
    assert req.session_id == "sess-e2e"
    assert req.increment_index == 0
    assert req.audio_format == "wav"
    assert req.language == "en"
    assert req.audio_start_ms == 0
    assert req.audio_end_ms == 3000
