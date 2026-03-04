"""Moonshine Base ONNX backend via sherpa-onnx.

No PyTorch dependency — uses sherpa-onnx for inference.
Optimized for English ASR (WER ~3.23% on LibriSpeech test-clean).
"""

from __future__ import annotations

import logging
import os
import struct
import threading
import time
import wave
from typing import Any

from app.services.whisper_batch import TranscriptResult, Utterance

logger = logging.getLogger(__name__)

_recognizer: Any | None = None
_recognizer_lock = threading.Lock()


def _detect_onnx_provider() -> str:
    """Auto-detect the best ONNX Runtime execution provider.

    Priority: CoreML (Apple Silicon) > CUDA (NVIDIA) > CPU.
    """
    try:
        import onnxruntime as ort

        available = ort.get_available_providers()
        if "CoreMLExecutionProvider" in available:
            return "coreml"
        if "CUDAExecutionProvider" in available:
            return "cuda"
    except ImportError:
        pass
    return "cpu"


_onnx_provider: str | None = None


def _get_recognizer(model_dir: str) -> Any:
    """Lazy-load Moonshine ONNX recognizer (thread-safe singleton).

    Unlike SenseVoice, Moonshine is English-only so no per-language cache needed.
    Auto-selects CoreML on Apple Silicon for hardware acceleration.
    """
    global _recognizer, _onnx_provider
    if _recognizer is not None:
        return _recognizer

    with _recognizer_lock:
        if _recognizer is not None:
            return _recognizer

        import sherpa_onnx

        preprocessor = os.path.join(model_dir, "preprocess.onnx")
        encoder_int8 = os.path.join(model_dir, "encode.int8.onnx")
        encoder_fp32 = os.path.join(model_dir, "encode.onnx")
        uncached_int8 = os.path.join(model_dir, "uncached_decode.int8.onnx")
        uncached_fp32 = os.path.join(model_dir, "uncached_decode.onnx")
        cached_int8 = os.path.join(model_dir, "cached_decode.int8.onnx")
        cached_fp32 = os.path.join(model_dir, "cached_decode.onnx")
        tokens_path = os.path.join(model_dir, "tokens.txt")

        # Prefer INT8 quantized models
        encoder = encoder_int8 if os.path.exists(encoder_int8) else encoder_fp32
        uncached = uncached_int8 if os.path.exists(uncached_int8) else uncached_fp32
        cached = cached_int8 if os.path.exists(cached_int8) else cached_fp32

        for path, name in [
            (preprocessor, "preprocessor"),
            (encoder, "encoder"),
            (uncached, "uncached_decoder"),
            (cached, "cached_decoder"),
            (tokens_path, "tokens"),
        ]:
            if not os.path.exists(path):
                raise FileNotFoundError(f"Moonshine ONNX {name} not found: {path}")

        _onnx_provider = _detect_onnx_provider()
        logger.info(
            "Loading Moonshine ONNX model from %s (provider=%s)",
            model_dir,
            _onnx_provider,
        )
        start = time.perf_counter()

        rec = sherpa_onnx.OfflineRecognizer.from_moonshine(
            preprocessor=preprocessor,
            encoder=encoder,
            uncached_decoder=uncached,
            cached_decoder=cached,
            tokens=tokens_path,
            num_threads=4,
            debug=False,
            provider=_onnx_provider,
        )

        load_time = time.perf_counter() - start
        logger.info("Moonshine ONNX model loaded in %.2fs (provider=%s)", load_time, _onnx_provider)
        _recognizer = rec
        return rec


class MoonshineOnnxTranscriber:
    """Moonshine Base ONNX backend via sherpa-onnx.

    English-only ASR optimized for edge deployment.
    Returns the same TranscriptResult dataclass as other backends.
    """

    def __init__(
        self,
        model_dir: str = "~/.cache/moonshine-onnx/sherpa-onnx-moonshine-base-en-int8",
    ) -> None:
        self._model_dir = os.path.expanduser(model_dir)

    @property
    def device(self) -> str:
        return f"onnx-{_onnx_provider or 'cpu'}"

    @property
    def backend(self) -> str:
        return "moonshine-onnx"

    @property
    def model_size(self) -> str:
        return "MoonshineBase-onnx"

    @staticmethod
    def _read_wave(audio_path: str) -> tuple[list[float], int]:
        """Read a WAV file and return (float32_samples, sample_rate)."""
        with wave.open(audio_path, "rb") as wf:
            sample_rate = wf.getframerate()
            n_frames = wf.getnframes()
            raw_data = wf.readframes(n_frames)

        n_samples = len(raw_data) // 2
        pcm16 = struct.unpack(f"<{n_samples}h", raw_data)
        samples = [s / 32768.0 for s in pcm16]
        return samples, sample_rate

    @staticmethod
    def _pcm_to_samples(pcm_data: bytes) -> list[float]:
        """Convert raw PCM16 bytes to float32 samples in-memory (no disk I/O)."""
        n_samples = len(pcm_data) // 2
        pcm16 = struct.unpack(f"<{n_samples}h", pcm_data)
        return [s / 32768.0 for s in pcm16]

    @staticmethod
    def _extract_confidence(stream_result) -> float:
        """Extract calibrated confidence from a sherpa-onnx stream result.

        Moonshine is an encoder-decoder model; sherpa-onnx exposes token strings
        via result.tokens. We use token density as a confidence proxy:
        empty transcript → 0.0, non-empty with tokens → scaled [0.8, 1.0].
        Falls back to 1.0 if token list is unavailable.
        """
        text = stream_result.text.strip()
        if not text:
            return 0.0

        tokens = getattr(stream_result, "tokens", None)
        if not tokens:
            return 1.0

        # Filter out whitespace-only tokens (common in BPE tokenizers).
        meaningful = sum(1 for t in tokens if t.strip())
        ratio = meaningful / len(tokens)
        # Scale to [0.8, 1.0]: Moonshine is English-only so token noise is lower.
        confidence = 0.8 + 0.2 * ratio
        return max(0.0, min(1.0, confidence))

    def _transcribe_samples(
        self,
        samples: list[float],
        sample_rate: int,
        start_timer: float,
    ) -> TranscriptResult:
        """Shared transcription logic given pre-decoded float32 samples."""
        recognizer = _get_recognizer(self._model_dir)
        duration_ms = int(len(samples) / sample_rate * 1000)

        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)
        recognizer.decode_stream(stream)

        text = stream.result.text.strip()
        elapsed_ms = int((time.perf_counter() - start_timer) * 1000)
        confidence = self._extract_confidence(stream.result)

        utterances = []
        if text:
            utterances.append(Utterance(
                id="u_0000",
                text=text,
                start_ms=0,
                end_ms=duration_ms,
                words=[],
                language="en",
                confidence=confidence,
            ))

        return TranscriptResult(
            utterances=utterances,
            language="en",
            duration_ms=duration_ms,
            processing_time_ms=elapsed_ms,
            backend="moonshine-onnx",
            model_size="MoonshineBase-onnx",
        )

    def transcribe(self, audio_path: str, language: str = "en") -> TranscriptResult:
        """Transcribe an audio file. Returns TranscriptResult."""
        start = time.perf_counter()
        samples, sample_rate = self._read_wave(audio_path)
        return self._transcribe_samples(samples, sample_rate, start)

    def transcribe_pcm(
        self, pcm_data: bytes, sample_rate: int = 16000, language: str = "en"
    ) -> TranscriptResult:
        """Transcribe raw PCM16 data in-memory (no temp file, no disk I/O)."""
        start = time.perf_counter()
        samples = self._pcm_to_samples(pcm_data)
        return self._transcribe_samples(samples, sample_rate, start)
