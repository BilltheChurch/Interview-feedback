"""Tests for WebSocket binary frame protocol."""
import json
import struct
import zlib
import pytest

from app.services.ws_protocol import (
    StartFrame,
    EndFrame,
    PCMFrame,
    ResultFrame,
    ErrorFrame,
    encode_pcm_frame,
    decode_pcm_frame,
    validate_start_frame,
    SCHEMA_VERSION,
)


def test_schema_version():
    assert SCHEMA_VERSION == 1


def test_start_frame_validation():
    raw = {
        "v": 1,
        "type": "start",
        "session_id": "sess-1",
        "increment_id": "uuid-123",
        "increment_index": 0,
        "audio_start_ms": 0,
        "audio_end_ms": 180000,
        "language": "en",
        "run_analysis": True,
        "total_frames": 10,
        "sample_rate": 16000,
        "channels": 1,
        "bit_depth": 16,
    }
    frame = validate_start_frame(raw)
    assert frame.session_id == "sess-1"
    assert frame.total_frames == 10


def test_start_frame_rejects_wrong_version():
    raw = {"v": 2, "type": "start", "session_id": "s"}
    with pytest.raises(ValueError, match="version"):
        validate_start_frame(raw)


def test_start_frame_rejects_missing_fields():
    raw = {"v": 1, "type": "start"}
    with pytest.raises(ValueError):
        validate_start_frame(raw)


def test_start_frame_rejects_wrong_type():
    """P1 fix: validate_start_frame must check type=='start'."""
    raw = {
        "v": 1, "type": "end",  # wrong type!
        "session_id": "sess-1", "increment_id": "uuid-1",
        "increment_index": 0, "audio_start_ms": 0, "audio_end_ms": 3000,
        "language": "en", "run_analysis": False, "total_frames": 1,
    }
    with pytest.raises(ValueError, match="type"):
        validate_start_frame(raw)


def test_encode_decode_pcm_frame():
    pcm_data = b'\x00\x01' * 1024  # 2KB PCM
    encoded = encode_pcm_frame(frame_seq=0, pcm_data=pcm_data)

    # Header: 12 bytes (seq:4 + size:4 + crc:4)
    assert len(encoded) == 12 + len(pcm_data)

    decoded = decode_pcm_frame(encoded)
    assert decoded.frame_seq == 0
    assert decoded.payload == pcm_data
    assert decoded.payload_size == len(pcm_data)


def test_decode_pcm_frame_crc_check():
    pcm_data = b'\x00\x01' * 100
    encoded = encode_pcm_frame(frame_seq=0, pcm_data=pcm_data)
    # Corrupt one byte in payload
    corrupted = bytearray(encoded)
    corrupted[15] ^= 0xFF
    with pytest.raises(ValueError, match="CRC"):
        decode_pcm_frame(bytes(corrupted))


def test_encode_pcm_frame_max_size():
    """Frame payload must not exceed 64KB."""
    big_data = b'\x00' * (65536 + 1)
    with pytest.raises(ValueError, match="64KB"):
        encode_pcm_frame(frame_seq=0, pcm_data=big_data)


def test_end_frame_schema():
    frame = EndFrame(total_frames_sent=10, total_bytes_sent=20480)
    d = frame.to_dict()
    assert d["type"] == "end"
    assert d["total_frames_sent"] == 10


def test_result_frame_schema():
    frame = ResultFrame(
        session_id="sess-1",
        increment_index=0,
        utterances=[],
        speaker_profiles=[],
        checkpoint=None,
        metrics={"total_ms": 1500},
    )
    d = frame.to_dict()
    assert d["v"] == 1
    assert d["type"] == "result"


def test_error_frame_schema():
    frame = ErrorFrame(code="FRAME_CRC_MISMATCH", message="bad crc")
    d = frame.to_dict()
    assert d["type"] == "error"
