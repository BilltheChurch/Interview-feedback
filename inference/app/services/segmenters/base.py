from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np

from app.services.audio import NormalizedAudio


@dataclass(slots=True)
class Segment:
    start_ms: int
    end_ms: int
    samples: np.ndarray


class Segmenter(Protocol):
    def segment(self, audio: NormalizedAudio) -> list[Segment]:
        ...
