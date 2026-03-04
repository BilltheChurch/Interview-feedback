"""WebSocket binary frame protocol for incremental audio processing.

Frame Types:
  StartFrame   (JSON text)  -- session info + expected frame count
  PCMFrame     (binary)     -- header(12B) + raw PCM s16le
  EndFrame     (JSON text)  -- completion summary
  ResultFrame  (JSON text)  -- processing result from Inference
  ErrorFrame   (JSON text)  -- error from Inference

PCMFrame binary layout:
  [frame_seq: uint32] [payload_size: uint32] [crc32: uint32] [pcm_data: bytes]
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

SCHEMA_VERSION = 1
MAX_FRAME_PAYLOAD = 65536  # 64KB


# -- Start Frame ---------------------------------------------------------------

_REQUIRED_START_FIELDS = {
    "session_id", "increment_id", "increment_index",
    "audio_start_ms", "audio_end_ms", "language",
    "run_analysis", "total_frames",
}


@dataclass
class StartFrame:
    session_id: str
    increment_id: str
    increment_index: int
    audio_start_ms: int
    audio_end_ms: int
    language: str
    run_analysis: bool
    total_frames: int
    sample_rate: int = 16000
    channels: int = 1
    bit_depth: int = 16


def validate_start_frame(raw: dict) -> StartFrame:
    """Parse and validate a StartFrame from JSON dict."""
    if raw.get("v") != SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported schema version: {raw.get('v')} (expected {SCHEMA_VERSION})"
        )
    if raw.get("type") != "start":
        raise ValueError(
            f"Expected type='start', got '{raw.get('type')}'"
        )
    missing = _REQUIRED_START_FIELDS - set(raw.keys())
    if missing:
        raise ValueError(f"StartFrame missing required fields: {missing}")
    return StartFrame(
        session_id=raw["session_id"],
        increment_id=raw["increment_id"],
        increment_index=raw["increment_index"],
        audio_start_ms=raw["audio_start_ms"],
        audio_end_ms=raw["audio_end_ms"],
        language=raw["language"],
        run_analysis=raw["run_analysis"],
        total_frames=raw["total_frames"],
        sample_rate=raw.get("sample_rate", 16000),
        channels=raw.get("channels", 1),
        bit_depth=raw.get("bit_depth", 16),
    )


# -- PCM Frame (binary) --------------------------------------------------------

HEADER_FORMAT = "<III"  # little-endian: seq(u32), size(u32), crc(u32)
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)  # 12 bytes


@dataclass
class PCMFrame:
    frame_seq: int
    payload_size: int
    crc32: int
    payload: bytes


def encode_pcm_frame(frame_seq: int, pcm_data: bytes) -> bytes:
    """Encode a PCM frame with header (seq + size + CRC32)."""
    if len(pcm_data) > MAX_FRAME_PAYLOAD:
        raise ValueError(
            f"PCM frame payload {len(pcm_data)} bytes exceeds 64KB limit"
        )
    crc = zlib.crc32(pcm_data) & 0xFFFFFFFF
    header = struct.pack(HEADER_FORMAT, frame_seq, len(pcm_data), crc)
    return header + pcm_data


def decode_pcm_frame(data: bytes) -> PCMFrame:
    """Decode a PCM frame, verifying CRC32."""
    if len(data) < HEADER_SIZE:
        raise ValueError(f"Frame too short: {len(data)} < {HEADER_SIZE}")
    seq, size, expected_crc = struct.unpack(HEADER_FORMAT, data[:HEADER_SIZE])
    payload = data[HEADER_SIZE:HEADER_SIZE + size]
    if len(payload) != size:
        raise ValueError(f"Payload truncated: got {len(payload)}, expected {size}")
    actual_crc = zlib.crc32(payload) & 0xFFFFFFFF
    if actual_crc != expected_crc:
        raise ValueError(
            f"CRC mismatch: expected {expected_crc:#010x}, got {actual_crc:#010x}"
        )
    return PCMFrame(frame_seq=seq, payload_size=size, crc32=expected_crc, payload=payload)


# -- End Frame ------------------------------------------------------------------

@dataclass
class EndFrame:
    total_frames_sent: int
    total_bytes_sent: int

    def to_dict(self) -> dict:
        return {
            "type": "end",
            "total_frames_sent": self.total_frames_sent,
            "total_bytes_sent": self.total_bytes_sent,
        }


# -- Result Frame ---------------------------------------------------------------

@dataclass
class ResultFrame:
    session_id: str
    increment_index: int
    utterances: list[dict]
    speaker_profiles: list[dict]
    checkpoint: dict | None
    metrics: dict

    def to_dict(self) -> dict:
        return {
            "v": SCHEMA_VERSION,
            "type": "result",
            "session_id": self.session_id,
            "increment_index": self.increment_index,
            "utterances": self.utterances,
            "speaker_profiles": self.speaker_profiles,
            "checkpoint": self.checkpoint,
            "metrics": self.metrics,
        }


# -- Error Frame ----------------------------------------------------------------

@dataclass
class ErrorFrame:
    code: str
    message: str

    def to_dict(self) -> dict:
        return {
            "type": "error",
            "code": self.code,
            "message": self.message,
        }
