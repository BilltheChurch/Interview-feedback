"""Diarization Backend protocol."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass
class SpeakerSegment:
    speaker_id: str
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass
class DiarizationResult:
    segments: list[SpeakerSegment]
    embeddings: dict[str, np.ndarray]  # speaker_id → embedding vector
    processing_time_ms: int
    confidences: dict[str, float] = field(default_factory=dict)

    @property
    def speaker_count(self) -> int:
        return len(set(s.speaker_id for s in self.segments))


@runtime_checkable
class DiarizationBackend(Protocol):
    @property
    def name(self) -> str: ...

    def diarize(
        self,
        wav_path: str,
        num_speakers: int | None = None,
    ) -> DiarizationResult: ...
