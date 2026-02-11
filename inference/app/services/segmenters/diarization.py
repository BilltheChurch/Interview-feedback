from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.exceptions import NotImplementedServiceError
from app.services.audio import NormalizedAudio
from app.services.segmenters.base import Segment


@dataclass(slots=True)
class SpeakerTrack:
    speaker_id: str
    start_ms: int
    end_ms: int


class Diarizer(Protocol):
    def diarize(self, audio: NormalizedAudio) -> list[SpeakerTrack]:
        ...


class UnimplementedDiarizer:
    def diarize(self, audio: NormalizedAudio) -> list[SpeakerTrack]:
        raise NotImplementedServiceError("diarization backend is not implemented in MVP-A")


class DiarizationSegmenter:
    def __init__(self, diarizer: Diarizer) -> None:
        self._diarizer = diarizer

    def segment(self, audio: NormalizedAudio) -> list[Segment]:
        tracks = self._diarizer.diarize(audio)
        segments: list[Segment] = []
        for track in tracks:
            start_idx = int((track.start_ms / 1000.0) * audio.sample_rate)
            end_idx = int((track.end_ms / 1000.0) * audio.sample_rate)
            end_idx = min(end_idx, audio.samples.size)
            if end_idx <= start_idx:
                continue
            segments.append(
                Segment(
                    start_ms=track.start_ms,
                    end_ms=track.end_ms,
                    samples=audio.samples[start_idx:end_idx],
                )
            )
        return segments
