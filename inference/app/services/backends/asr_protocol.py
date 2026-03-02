"""ASR Backend protocol — all ASR implementations must conform to this."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass
class TranscriptSegment:
    """A single transcribed segment with timing and confidence."""
    text: str
    start_ms: int
    end_ms: int
    language: str = "auto"
    confidence: float = 1.0
    words: list[dict] | None = None  # word-level timestamps if available

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@runtime_checkable
class ASRBackend(Protocol):
    """Pluggable ASR backend interface.

    Implementations: SenseVoiceONNX, FasterWhisper, DistilWhisper,
    ParakeetTDT, MoonshineONNX.
    """

    @property
    def name(self) -> str: ...

    @property
    def supports_streaming(self) -> bool: ...

    @property
    def supports_word_timestamps(self) -> bool: ...

    def transcribe(
        self,
        wav_path: str,
        language: str = "auto",
        *,
        word_timestamps: bool = False,
    ) -> list[TranscriptSegment]: ...

    def transcribe_segment(
        self,
        wav_path: str,
        start_ms: int,
        end_ms: int,
        language: str = "auto",
    ) -> list[TranscriptSegment]: ...
