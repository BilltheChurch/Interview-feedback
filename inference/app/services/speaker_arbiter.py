"""CAM++ speaker arbitration layer.

Only invoked for low-confidence pyannote speaker mappings.
Protects 60s SLA by skipping high-confidence matches entirely.
"""
from __future__ import annotations

import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


class SpeakerArbiter:
    """Arbitrate speaker identity using CAM++ only when pyannote is uncertain."""

    def __init__(self, sv_backend: Any, confidence_threshold: float = 0.50) -> None:
        self.sv = sv_backend
        self.confidence_threshold = confidence_threshold

    def arbitrate(
        self,
        pyannote_mapping: dict[str, str],
        pyannote_confidences: dict[str, float],
        audio_segments: dict[str, str],  # local_id → wav_path
        global_profiles: dict[str, Any],  # global_id → profile with .centroid
    ) -> dict[str, str]:
        """Return corrected mapping. High-confidence entries pass through unchanged."""
        if not global_profiles:
            return dict(pyannote_mapping)

        corrections: dict[str, str] = {}

        for local_id, confidence in pyannote_confidences.items():
            if confidence >= self.confidence_threshold:
                continue  # trust pyannote

            wav_path = audio_segments.get(local_id)
            if not wav_path:
                continue

            try:
                emb_result = self.sv.extract_embedding(wav_path)
                emb = emb_result.embedding
                best_global, best_sim = self._cosine_match(emb, global_profiles)
                if best_global and best_sim > 0.55:
                    corrections[local_id] = best_global
                    logger.debug(
                        "Arbiter correction: %s → %s (sim=%.3f, was %s conf=%.2f)",
                        local_id, best_global, best_sim,
                        pyannote_mapping.get(local_id), confidence,
                    )
            except Exception:
                logger.warning(
                    "Arbiter failed for %s, keeping pyannote mapping",
                    local_id, exc_info=True,
                )

        return {**pyannote_mapping, **corrections}

    def _cosine_match(
        self, emb: np.ndarray, profiles: dict[str, Any]
    ) -> tuple[str | None, float]:
        """Find best matching global profile by cosine similarity."""
        best_id = None
        best_sim = -1.0
        emb_norm = emb / (np.linalg.norm(emb) + 1e-8)

        for gid, profile in profiles.items():
            centroid = getattr(profile, "centroid", None)
            if centroid is None:
                continue
            centroid = np.asarray(centroid, dtype=np.float32)
            if centroid.size == 0:
                continue
            c_norm = centroid / (np.linalg.norm(centroid) + 1e-8)
            sim = float(np.dot(emb_norm, c_norm))
            if sim > best_sim:
                best_sim = sim
                best_id = gid

        return best_id, best_sim
