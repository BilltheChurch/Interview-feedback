"""Cross-service contract tests: Worker <-> Inference schema compatibility.

These tests validate that the field names, types, and structures used by
the Worker (TypeScript) match what Inference (Python) expects.

Run in CI to prevent field drift (the P0 bug that caused this redesign).
"""
import pytest

from app.schemas_v1 import SCHEMA_VERSION, FinalizeRequestV1
from app.services.ws_protocol import validate_start_frame


class TestIncrementContract:
    """Validate Worker -> Inference increment request contract."""

    def test_start_frame_accepts_worker_format(self):
        """Simulate the exact JSON that Worker sends as StartFrame."""
        worker_payload = {
            "v": 1,
            "type": "start",
            "session_id": "sess-abc-123",
            "increment_id": "inc-uuid-456",
            "increment_index": 0,
            "audio_start_ms": 0,
            "audio_end_ms": 180000,
            "language": "en",
            "run_analysis": True,
            "total_frames": 100,
            "sample_rate": 16000,
            "channels": 1,
            "bit_depth": 16,
        }
        frame = validate_start_frame(worker_payload)
        assert frame.session_id == "sess-abc-123"
        assert frame.audio_end_ms == 180000

    def test_start_frame_field_names_match_design_doc(self):
        """Ensure field names match design doc exactly (prevents drift)."""
        required_fields = {
            "v", "type", "session_id", "increment_id", "increment_index",
            "audio_start_ms", "audio_end_ms", "language", "run_analysis",
            "total_frames",
        }
        # These are the fields validate_start_frame requires
        from app.services.ws_protocol import _REQUIRED_START_FIELDS
        assert _REQUIRED_START_FIELDS == required_fields - {"v", "type"}


class TestFinalizeContract:
    """Validate Worker -> Inference finalize request contract."""

    def test_finalize_accepts_worker_format(self):
        worker_payload = {
            "v": 1,
            "session_id": "sess-abc-123",
            "r2_audio_refs": [
                {"key": "chunks/sess-abc-123/000.pcm", "start_ms": 0, "end_ms": 10000},
                {"key": "chunks/sess-abc-123/001.pcm", "start_ms": 10000, "end_ms": 20000},
            ],
            "total_audio_ms": 20000,
            "locale": "en-US",
            "memos": [],
            "stats": [],
            "evidence": [],
            "name_aliases": {},
        }
        req = FinalizeRequestV1(**worker_payload)
        assert len(req.r2_audio_refs) == 2
        assert req.r2_audio_refs[0].duration_ms == 10000

    def test_schema_version_constant(self):
        assert SCHEMA_VERSION == 1


class TestPCMFrameRoundtrip:
    """Real binary encode->decode roundtrip test (P2 fix: not just static assertions)."""

    def test_encode_decode_pcm_frame_roundtrip(self):
        """Encode a PCM frame, decode it, verify all fields survive the trip."""
        from app.services.ws_protocol import decode_pcm_frame, encode_pcm_frame

        # 10ms of 16kHz mono PCM16 = 160 samples x 2 bytes = 320 bytes
        pcm_data = bytes(range(256)) + bytes(range(64))
        frame_seq = 42

        encoded = encode_pcm_frame(frame_seq, pcm_data)
        decoded = decode_pcm_frame(encoded)

        assert decoded.frame_seq == frame_seq
        assert decoded.payload_size == len(pcm_data)
        assert decoded.payload == pcm_data
        # CRC32 should match
        import zlib
        assert decoded.crc32 == zlib.crc32(pcm_data) & 0xFFFFFFFF

    def test_encode_decode_empty_payload(self):
        """Edge case: empty PCM frame (e.g. silence placeholder)."""
        from app.services.ws_protocol import decode_pcm_frame, encode_pcm_frame

        encoded = encode_pcm_frame(0, b"")
        decoded = decode_pcm_frame(encoded)
        assert decoded.frame_seq == 0
        assert decoded.payload_size == 0
        assert decoded.payload == b""

    def test_decode_rejects_corrupted_crc(self):
        """Corrupted CRC should raise ValueError."""
        import struct

        from app.services.ws_protocol import decode_pcm_frame, encode_pcm_frame

        pcm_data = b"\x00" * 64
        encoded = bytearray(encode_pcm_frame(0, pcm_data))
        # Corrupt the CRC field (bytes 8-11)
        struct.pack_into("<I", encoded, 8, 0xDEADBEEF)

        with pytest.raises(ValueError, match="CRC"):
            decode_pcm_frame(bytes(encoded))
