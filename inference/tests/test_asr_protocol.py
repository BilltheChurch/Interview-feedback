"""Tests for ASR backend protocol compliance."""
import pytest
from app.services.backends.asr_protocol import ASRBackend, TranscriptSegment


def test_protocol_requires_name():
    """Any ASR backend must expose a name property."""
    class BadBackend:
        pass

    assert not isinstance(BadBackend(), ASRBackend)


def test_protocol_requires_transcribe():
    class MinimalBackend:
        @property
        def name(self) -> str:
            return "test"

        @property
        def supports_streaming(self) -> bool:
            return False

        @property
        def supports_word_timestamps(self) -> bool:
            return False

        def transcribe(self, wav_path, language="auto", *, word_timestamps=False):
            return []

        def transcribe_segment(self, wav_path, start_ms, end_ms, language="auto"):
            return []

    backend = MinimalBackend()
    assert isinstance(backend, ASRBackend)
    assert backend.name == "test"


def test_transcript_segment_dataclass():
    seg = TranscriptSegment(
        text="Hello world",
        start_ms=0,
        end_ms=1500,
        language="en",
        confidence=0.95,
    )
    assert seg.text == "Hello world"
    assert seg.duration_ms == 1500
