"""Speaker Verification Backend protocol — CAM++ as arbitration layer."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass
class EmbeddingResult:
    embedding: np.ndarray
    confidence: float = 1.0

    @property
    def dim(self) -> int:
        return self.embedding.shape[0]


@runtime_checkable
class SVBackend(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def embedding_dim(self) -> int: ...

    def extract_embedding(self, wav_path: str) -> EmbeddingResult: ...

    def score(self, emb_a: np.ndarray, emb_b: np.ndarray) -> float: ...
