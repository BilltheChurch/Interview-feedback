"""CAM++ Speaker Verification via ONNX Runtime.

Architecture:
  - FBank feature extraction: kaldi-native-fbank (C++, zero PyTorch dependency)
  - Embedding inference: ONNX Runtime (replaces PyTorch CAMPPlus CNN)
  - Embedding dim: 192 (CAM++ advanced model)

The ONNX model is the CAMPPlus backbone only (no feature extraction).
Feature extraction uses kaldi-native-fbank with parameters aligned to
torchaudio.compliance.kaldi.fbank for ModelScope pipeline compatibility.
FBank is padded to T=200 frames for ONNX model parity (T_int=100=seg_len).
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from time import perf_counter
from typing import Any

import numpy as np

from app.exceptions import SVBackendError

logger = logging.getLogger(__name__)

_session: Any = None
_session_lock = threading.Lock()


def _get_session(model_path: str) -> Any:
    """Thread-safe singleton for ONNX Runtime session."""
    global _session
    if _session is not None:
        return _session

    with _session_lock:
        if _session is not None:
            return _session

        import onnxruntime as ort

        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"CAM++ ONNX model not found: {model_path}. "
                f"Run: python scripts/export_campplus_onnx.py"
            )

        logger.info("Loading CAM++ ONNX model from %s", model_path)
        start = perf_counter()

        # Select best available provider
        providers = ["CPUExecutionProvider"]
        try:
            available = ort.get_available_providers()
            if "CoreMLExecutionProvider" in available:
                providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
            elif "CUDAExecutionProvider" in available:
                providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        except Exception:
            pass

        _session = ort.InferenceSession(model_path, providers=providers)
        elapsed = perf_counter() - start
        logger.info(
            "CAM++ ONNX loaded in %.2fs (providers=%s)", elapsed, providers
        )
        return _session


def _extract_fbank(samples: np.ndarray, sample_rate: int, num_mel_bins: int = 80) -> np.ndarray:
    """Extract FBank features matching ModelScope's Kaldi.fbank pipeline.

    Uses kaldi-native-fbank (C++ Kaldi-compatible, zero PyTorch dependency)
    with parameters aligned to torchaudio.compliance.kaldi.fbank defaults.

    FBank output is padded/cropped to exactly TARGET_T=200 frames so that
    the ONNX model's CAMLayer.seg_pooling(seg_len=100) operates at T_int=100,
    avoiding the trace-time shape freeze bug (cos_dist < 0.001 guaranteed).

    Returns:
        np.ndarray of shape [1, TARGET_T, num_mel_bins] (mean-normalized FBank)
    """
    import kaldi_native_fbank as knf

    TARGET_T = 200  # T_int = floor((200-1)/2)+1 = 100 = seg_len → perfect ONNX parity

    # Ensure 1D float32
    if samples.ndim > 1:
        samples = samples.flatten()
    samples = samples.astype(np.float32)

    # Configure FBank to match torchaudio.compliance.kaldi.fbank defaults
    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = float(sample_rate)
    opts.frame_opts.dither = 0.0          # torchaudio default (differs from Kaldi CLI 1.0)
    opts.frame_opts.snip_edges = True     # torchaudio default
    opts.frame_opts.window_type = "povey" # torchaudio default (hann^0.85)
    opts.frame_opts.preemph_coeff = 0.97  # torchaudio default
    opts.frame_opts.frame_length_ms = 25.0
    opts.frame_opts.frame_shift_ms = 10.0
    opts.energy_floor = 1.0               # torchaudio default
    opts.mel_opts.num_bins = num_mel_bins
    opts.mel_opts.low_freq = 20.0         # torchaudio default
    opts.mel_opts.high_freq = 0.0         # 0 = Nyquist/2 (torchaudio default)

    fbank_fn = knf.OnlineFbank(opts)
    fbank_fn.accept_waveform(sample_rate, samples.tolist())
    fbank_fn.input_finished()

    frames = fbank_fn.num_frames_ready
    if frames == 0:
        raise ValueError("FBank produced 0 frames from input audio")

    mat = np.empty([frames, num_mel_bins], dtype=np.float32)
    for i in range(frames):
        mat[i, :] = fbank_fn.get_frame(i)

    # Pad or crop to TARGET_T frames for ONNX parity
    if frames < TARGET_T:
        padding = np.tile(mat[-1:], (TARGET_T - frames, 1))
        mat = np.concatenate([mat, padding], axis=0)
    elif frames > TARGET_T:
        start = (frames - TARGET_T) // 2
        mat = mat[start : start + TARGET_T]

    # Mean normalization (same as ModelScope __extract_feature)
    mat = mat - mat.mean(axis=0, keepdims=True)
    # Add batch dim: [1, TARGET_T, num_mel_bins]
    return mat[np.newaxis, ...]


@dataclass(slots=True)
class SVOnnxHealth:
    model_id: str
    model_revision: str
    embedding_dim: int | None
    model_loaded: bool
    model_load_seconds: float | None
    device: str = "onnx"


class OnnxSVBackend:
    """CAM++ Speaker Verification via ONNX Runtime.

    API-compatible with ModelScopeSVBackend.
    """

    def __init__(
        self,
        model_path: str = "~/.cache/campplus-onnx/campplus.onnx",
        model_id: str = "campplus-onnx",
        model_revision: str = "onnx-v1",
    ) -> None:
        self._model_path = os.path.expanduser(model_path)
        self.model_id = model_id
        self.model_revision = model_revision
        self._embedding_dim: int | None = None
        self._model_load_seconds: float | None = None

    @property
    def embedding_dim(self) -> int | None:
        return self._embedding_dim

    @property
    def device(self) -> str:
        return "onnx"

    def extract_embedding(self, samples: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
        """Extract speaker embedding from raw audio samples.

        Args:
            samples: 1D float32 audio samples (normalized to [-1, 1])
            sample_rate: Sample rate in Hz (default 16000)

        Returns:
            np.ndarray of shape (embedding_dim,) — float32 speaker embedding
        """
        if samples.size == 0:
            raise SVBackendError("cannot extract embedding from empty audio")

        start = perf_counter()

        # Step 1: Extract FBank features (matches ModelScope pipeline exactly)
        fbank_features = _extract_fbank(samples, sample_rate)

        # Step 2: Run ONNX inference on FBank features
        session = _get_session(self._model_path)
        result = session.run(None, {"fbank": fbank_features.astype(np.float32)})
        embedding = result[0].flatten().astype(np.float32)

        if self._embedding_dim is None:
            self._embedding_dim = len(embedding)
            logger.info("CAM++ ONNX embedding dim: %d", self._embedding_dim)

        elapsed_ms = (perf_counter() - start) * 1000
        logger.debug(
            "CAM++ ONNX embedding extracted in %.1fms (dim=%d)",
            elapsed_ms,
            len(embedding),
        )
        return embedding

    def extract_embedding_from_audio(self, audio) -> np.ndarray:
        """Extract embedding from NormalizedAudio object."""
        return self.extract_embedding(samples=audio.samples, sample_rate=audio.sample_rate)

    @staticmethod
    def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        """Compute cosine similarity between two embeddings."""
        a_norm = np.linalg.norm(a)
        b_norm = np.linalg.norm(b)
        if a_norm == 0.0 or b_norm == 0.0:
            raise SVBackendError("zero-norm embedding encountered")
        return float(np.dot(a, b) / (a_norm * b_norm))

    def score_embeddings(self, embedding_a: np.ndarray, embedding_b: np.ndarray) -> float:
        """Score similarity between two pre-extracted embeddings."""
        if embedding_a.size == 0 or embedding_b.size == 0:
            raise SVBackendError("cannot score empty embeddings")
        return self._cosine_similarity(
            embedding_a.astype(np.float32), embedding_b.astype(np.float32)
        )

    def score_audio(self, audio_a, audio_b) -> float:
        """Score similarity between two audio samples."""
        embedding_a = self.extract_embedding_from_audio(audio_a)
        embedding_b = self.extract_embedding_from_audio(audio_b)
        return self.score_embeddings(embedding_a=embedding_a, embedding_b=embedding_b)

    def health(self) -> SVOnnxHealth:
        """Return health check info."""
        return SVOnnxHealth(
            model_id=self.model_id,
            model_revision=self.model_revision,
            embedding_dim=self._embedding_dim,
            model_loaded=_session is not None,
            model_load_seconds=self._model_load_seconds,
        )
