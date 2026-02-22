from __future__ import annotations

import io
import logging
import os
import tempfile
import threading
import wave
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Literal

import numpy as np

from app.exceptions import SVBackendError
from app.services.audio import NormalizedAudio

logger = logging.getLogger(__name__)

SVDeviceType = Literal["cuda", "rocm", "mps", "cpu"]


def detect_sv_device() -> SVDeviceType:
    """Return the best available compute device for speaker verification."""
    try:
        import torch

        if torch.cuda.is_available():
            if hasattr(torch.version, "hip") and torch.version.hip is not None:
                return "rocm"
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


@dataclass(slots=True)
class SVHealth:
    model_id: str
    model_revision: str
    embedding_dim: int | None
    model_loaded: bool
    model_load_seconds: float | None
    device: str = "cpu"


class ModelScopeSVBackend:
    def __init__(self, model_id: str, model_revision: str, cache_dir: str, device: str = "auto") -> None:
        self.model_id = model_id
        self.model_revision = model_revision
        self.cache_dir = os.path.expanduser(cache_dir)
        self._device: SVDeviceType = detect_sv_device() if device == "auto" else device  # type: ignore[assignment]

        self._pipeline: Any | None = None
        self._embedding_dim: int | None = None
        self._model_load_seconds: float | None = None
        self._lock = threading.RLock()
        logger.info("ModelScopeSVBackend: device=%s, model=%s", self._device, self.model_id)

    @property
    def embedding_dim(self) -> int | None:
        return self._embedding_dim

    @property
    def device(self) -> SVDeviceType:
        return self._device

    def _ensure_pipeline(self) -> Any:
        with self._lock:
            if self._pipeline is not None:
                return self._pipeline

            start = perf_counter()
            try:
                os.environ.setdefault("MODELSCOPE_CACHE", self.cache_dir)
                from modelscope.pipelines import pipeline
                from modelscope.utils.constant import Tasks

                self._pipeline = pipeline(
                    task=Tasks.speaker_verification,
                    model=self.model_id,
                    model_revision=self.model_revision,
                )

                # Transfer model to GPU if available
                if self._device in ("cuda", "rocm"):
                    try:
                        import torch
                        if torch.cuda.is_available() and hasattr(self._pipeline, "model"):
                            self._pipeline.model = self._pipeline.model.to(torch.device("cuda"))
                            logger.info("SV model transferred to CUDA/ROCm GPU")
                    except Exception:
                        logger.warning("Failed to transfer SV model to CUDA, running on CPU", exc_info=True)
                elif self._device == "mps":
                    # ModelScope pipelines don't auto-convert inputs to MPS
                    # (unlike CUDA). Keep model on CPU for reliable inference.
                    logger.info("SV model stays on CPU (MPS pipeline input conversion not supported by ModelScope)")
            except Exception as exc:  # noqa: BLE001
                raise SVBackendError(f"failed to initialize ModelScope speaker verification pipeline: {exc}") from exc
            finally:
                self._model_load_seconds = perf_counter() - start

            return self._pipeline

    @staticmethod
    def _pack_wav(samples: np.ndarray, sample_rate: int) -> bytes:
        normalized = np.clip(samples, -1.0, 1.0)
        pcm = (normalized * 32767.0).astype(np.int16)

        stream = io.BytesIO()
        with wave.open(stream, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm.tobytes())
        return stream.getvalue()

    @staticmethod
    def _find_embedding(payload: Any) -> np.ndarray | None:
        if payload is None:
            return None

        if isinstance(payload, np.ndarray):
            return payload.astype(np.float32)

        if isinstance(payload, (list, tuple)):
            if payload and all(isinstance(v, (int, float)) for v in payload):
                return np.asarray(payload, dtype=np.float32)
            for item in payload:
                embedding = ModelScopeSVBackend._find_embedding(item)
                if embedding is not None:
                    return embedding
            return None

        if isinstance(payload, dict):
            preferred_keys = (
                "embedding",
                "embeddings",
                "embs",
                "spk_embedding",
                "speaker_embedding",
                "xvector",
                "output_embedding",
                "feat",
                "features",
            )
            for key in preferred_keys:
                if key in payload:
                    embedding = ModelScopeSVBackend._find_embedding(payload[key])
                    if embedding is not None:
                        return embedding

            for value in payload.values():
                embedding = ModelScopeSVBackend._find_embedding(value)
                if embedding is not None:
                    return embedding

        return None

    @staticmethod
    def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        a_norm = np.linalg.norm(a)
        b_norm = np.linalg.norm(b)
        if a_norm == 0.0 or b_norm == 0.0:
            raise SVBackendError("zero-norm embedding encountered")
        return float(np.dot(a, b) / (a_norm * b_norm))

    def extract_embedding(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        if samples.size == 0:
            raise SVBackendError("cannot extract embedding from empty audio")

        pipeline = self._ensure_pipeline()
        wav_bytes = self._pack_wav(samples=samples, sample_rate=sample_rate)
        audio_array = np.ascontiguousarray(samples.astype(np.float32))

        temp_wav_path: str | None = None
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
            tmp_file.write(wav_bytes)
            temp_wav_path = tmp_file.name

        request_variants = [
            [audio_array],
            [temp_wav_path],
        ]

        last_error: Exception | None = None
        try:
            for request in request_variants:
                try:
                    output = pipeline(request, output_emb=True)
                    embedding = self._find_embedding(output)
                    if embedding is None:
                        continue
                    if embedding.ndim != 1:
                        embedding = embedding.reshape(-1)
                    if embedding.size == 0:
                        continue
                    vector = embedding.astype(np.float32)
                    self._embedding_dim = int(vector.size)
                    return vector
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    continue
        finally:
            if temp_wav_path and os.path.exists(temp_wav_path):
                os.unlink(temp_wav_path)

        if last_error is not None:
            raise SVBackendError(f"speaker embedding extraction failed: {last_error}") from last_error

        raise SVBackendError(
            "speaker embedding extraction failed: ModelScope pipeline did not return a parseable embedding"
        )

    def extract_embedding_from_audio(self, audio: NormalizedAudio) -> np.ndarray:
        return self.extract_embedding(samples=audio.samples, sample_rate=audio.sample_rate)

    def score_embeddings(self, embedding_a: np.ndarray, embedding_b: np.ndarray) -> float:
        if embedding_a.size == 0 or embedding_b.size == 0:
            raise SVBackendError("cannot score empty embeddings")
        return self._cosine_similarity(embedding_a.astype(np.float32), embedding_b.astype(np.float32))

    def score_audio(self, audio_a: NormalizedAudio, audio_b: NormalizedAudio) -> float:
        embedding_a = self.extract_embedding_from_audio(audio_a)
        embedding_b = self.extract_embedding_from_audio(audio_b)
        return self.score_embeddings(embedding_a=embedding_a, embedding_b=embedding_b)

    def health(self) -> SVHealth:
        return SVHealth(
            model_id=self.model_id,
            model_revision=self.model_revision,
            embedding_dim=self._embedding_dim,
            model_loaded=self._pipeline is not None,
            model_load_seconds=self._model_load_seconds,
            device=self._device,
        )
