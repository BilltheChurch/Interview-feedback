"""SenseVoice ONNX Runtime backend via sherpa-onnx.

No PyTorch dependency — uses sherpa-onnx for inference.
Target backend for Tauri/SwiftUI migration.
"""

from __future__ import annotations

import logging
import os
import struct
import threading
import time
import wave
from typing import Any

from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp

logger = logging.getLogger(__name__)

_recognizers: dict[str, Any] = {}
_recognizer_lock = threading.Lock()
_onnx_provider: str | None = None


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


def _get_recognizer(model_dir: str, language: str = "auto") -> Any:
    """Lazy-load SenseVoice ONNX recognizer per language (thread-safe cache).

    sherpa-onnx sets the language at recognizer construction time (not per-stream),
    so we maintain a cache keyed by (model_dir, language) to support per-call switching.
    Auto-selects CoreML on Apple Silicon for hardware acceleration.
    """
    global _onnx_provider
    cache_key = f"{model_dir}:{language}"
    if cache_key in _recognizers:
        return _recognizers[cache_key]

    with _recognizer_lock:
        if cache_key in _recognizers:
            return _recognizers[cache_key]

        import sherpa_onnx

        # Prefer INT8 quantized model (2x faster, same output quality)
        model_int8 = os.path.join(model_dir, "model.int8.onnx")
        model_fp32 = os.path.join(model_dir, "model.onnx")
        model_path = model_int8 if os.path.exists(model_int8) else model_fp32
        tokens_path = os.path.join(model_dir, "tokens.txt")

        if not os.path.exists(model_path):
            raise FileNotFoundError(f"ONNX model not found: {model_fp32}")
        if not os.path.exists(tokens_path):
            raise FileNotFoundError(f"Tokens file not found: {tokens_path}")

        if _onnx_provider is None:
            _onnx_provider = _detect_onnx_provider()

        logger.info(
            "Loading SenseVoice ONNX model from %s (language=%s, provider=%s)",
            model_dir, language, _onnx_provider,
        )
        start = time.perf_counter()

        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model_path,
            tokens=tokens_path,
            use_itn=True,
            num_threads=4,
            debug=False,
            language=language,
            provider=_onnx_provider,
        )

        load_time = time.perf_counter() - start
        logger.info(
            "SenseVoice ONNX model loaded in %.2fs (language=%s, provider=%s)",
            load_time, language, _onnx_provider,
        )
        _recognizers[cache_key] = recognizer
        return recognizer


class SenseVoiceOnnxTranscriber:
    """SenseVoice ONNX backend via sherpa-onnx.

    Drop-in replacement for SenseVoiceTranscriber (PyTorch/FunASR version).
    Returns the same TranscriptResult dataclass.
    """

    def __init__(
        self,
        model_dir: str = "~/.cache/sensevoice-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    ) -> None:
        self._model_dir = os.path.expanduser(model_dir)

    @property
    def device(self) -> str:
        return f"onnx-{_onnx_provider or 'cpu'}"

    @property
    def backend(self) -> str:
        return "sensevoice-onnx"

    @property
    def model_size(self) -> str:
        return "SenseVoiceSmall-onnx"

    @staticmethod
    def _read_wave(audio_path: str) -> tuple[list[float], int]:
        """Read a WAV file and return (float32_samples, sample_rate).

        Converts PCM16 samples to float32 in [-1.0, 1.0] range,
        which is the format sherpa-onnx expects.
        """
        with wave.open(audio_path, "rb") as wf:
            sample_rate = wf.getframerate()
            n_frames = wf.getnframes()
            raw_data = wf.readframes(n_frames)

        # Convert PCM16 (signed 16-bit little-endian) to float32
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

        sherpa-onnx SenseVoice exposes token strings via result.tokens.
        We use the fraction of non-empty, non-noise tokens as a confidence
        proxy: silent/noise segments produce few meaningful tokens → low
        confidence; clear speech produces many → high confidence.

        Falls back to 1.0 if tokens are unavailable (text is non-empty).
        Returns 0.0 for empty transcripts (silence).
        """
        text = stream_result.text.strip()
        if not text:
            return 0.0

        tokens = getattr(stream_result, "tokens", None)
        if not tokens:
            # No token-level info available; assume confident if text present.
            return 1.0

        # SenseVoice tokens include noise/event tags like <|NOISE|>, <|BGM|>, etc.
        noise_tags = {"<|noise|>", "<|bgm|>", "<|speech|>", "<|withitn|>", "<|woitn|>"}
        meaningful = sum(
            1 for t in tokens
            if t.strip() and t.strip().lower() not in noise_tags
        )
        ratio = meaningful / len(tokens)
        # Scale to [0.7, 1.0] for non-empty transcripts — empty→0.0 already handled.
        confidence = 0.7 + 0.3 * ratio
        return max(0.0, min(1.0, confidence))

    def _transcribe_samples(
        self,
        samples: list[float],
        sample_rate: int,
        language: str,
        start_timer: float,
    ) -> TranscriptResult:
        """Shared transcription logic given pre-decoded float32 samples."""
        recognizer = _get_recognizer(self._model_dir, language=language)
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
                language=language if language != "auto" else "auto",
                confidence=confidence,
            ))

        return TranscriptResult(
            utterances=utterances,
            language=language,
            duration_ms=duration_ms,
            processing_time_ms=elapsed_ms,
            backend="sensevoice-onnx",
            model_size="SenseVoiceSmall-onnx",
        )

    def transcribe(self, audio_path: str, language: str = "auto") -> TranscriptResult:
        """Transcribe an audio file. Returns TranscriptResult (same schema as PyTorch version)."""
        start = time.perf_counter()
        samples, sample_rate = self._read_wave(audio_path)
        return self._transcribe_samples(samples, sample_rate, language, start)

    def transcribe_pcm(
        self, pcm_data: bytes, sample_rate: int = 16000, language: str = "auto"
    ) -> TranscriptResult:
        """Transcribe raw PCM16 data in-memory (no temp file, no disk I/O)."""
        start = time.perf_counter()
        samples = self._pcm_to_samples(pcm_data)
        return self._transcribe_samples(samples, sample_rate, language, start)
