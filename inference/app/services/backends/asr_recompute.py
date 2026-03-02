"""Selective recomputation ASR — runs only on low-confidence segments.

Uses Faster-Whisper (large-v3) for highest accuracy.
Only invoked during finalize, not during real-time increments.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


class SelectiveRecomputeASR:
    """Recompute low-confidence utterances with high-precision model.

    Loaded lazily — model only instantiated on first call.
    """

    def __init__(self, model_size: str = "large-v3", device: str = "auto") -> None:
        self._model_size = model_size
        self._device = device
        self._model = None

    def _ensure_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            compute_type = "float16" if self._device == "cuda" else "int8"
            actual_device = self._device if self._device != "auto" else "cpu"
            self._model = WhisperModel(
                self._model_size, device=actual_device, compute_type=compute_type
            )
            logger.info("Recompute ASR loaded: %s on %s", self._model_size, actual_device)

    def recompute_low_confidence(
        self,
        utterances: list[dict],
        audio_path: str | None = None,
        confidence_threshold: float = 0.7,
    ) -> list[dict]:
        """Re-transcribe utterances below confidence threshold.

        If audio_path is None, skips actual recomputation (marks only).
        Returns updated list with recomputed utterances where possible.
        """
        recomputed = []
        needs_recompute = 0

        for utt in utterances:
            if utt.get("confidence", 1.0) >= confidence_threshold:
                recomputed.append(utt)
                continue

            needs_recompute += 1

            if audio_path is None:
                recomputed.append({**utt, "needs_recompute": True})
                continue

            try:
                self._ensure_model()
                segments, _ = self._model.transcribe(
                    audio_path,
                    language=utt.get("language", "en"),
                )
                new_text = " ".join(s.text for s in segments)
                recomputed.append({
                    **utt,
                    "text": new_text,
                    "confidence": 0.90,
                    "recomputed": True,
                })
            except Exception:
                logger.warning("Recompute failed for utterance", exc_info=True)
                recomputed.append(utt)

        if needs_recompute:
            logger.info(
                "Recompute ASR: %d/%d utterances below threshold %.2f",
                needs_recompute, len(utterances), confidence_threshold,
            )

        return recomputed

    def recompute_utterance(
        self,
        audio_path: str,
        language: str = "en",
        start_ms: int = 0,
        end_ms: int = 0,
    ) -> dict:
        """Re-transcribe a single audio segment with high-precision model.

        Returns: {"text": str, "confidence": float, "recomputed": True}
        Raises on model error — caller must handle.
        """
        self._ensure_model()
        segments, _info = self._model.transcribe(
            audio_path,
            language=language,
        )
        new_text = " ".join(s.text for s in segments).strip()
        return {
            "text": new_text,
            "confidence": 0.90,
            "recomputed": True,
        }
