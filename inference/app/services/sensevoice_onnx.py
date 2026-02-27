"""SenseVoice ONNX Runtime backend via sherpa-onnx.

No PyTorch dependency — uses sherpa-onnx for inference.
Target backend for Tauri/SwiftUI migration.
"""

from __future__ import annotations

import array
import logging
import os
import struct
import tempfile
import threading
import time
import wave
from typing import Any

from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp

logger = logging.getLogger(__name__)

_recognizers: dict[str, Any] = {}
_recognizer_lock = threading.Lock()


def _get_recognizer(model_dir: str, language: str = "auto") -> Any:
    """Lazy-load SenseVoice ONNX recognizer per language (thread-safe cache).

    sherpa-onnx sets the language at recognizer construction time (not per-stream),
    so we maintain a cache keyed by (model_dir, language) to support per-call switching.
    """
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

        logger.info("Loading SenseVoice ONNX model from %s (language=%s)", model_dir, language)
        start = time.perf_counter()

        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model_path,
            tokens=tokens_path,
            use_itn=True,
            num_threads=4,
            debug=False,
            language=language,
        )

        load_time = time.perf_counter() - start
        logger.info("SenseVoice ONNX model loaded in %.2fs (language=%s)", load_time, language)
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
        return "onnx-cpu"

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

    def transcribe(self, audio_path: str, language: str = "auto") -> TranscriptResult:
        """Transcribe an audio file. Returns TranscriptResult (same schema as PyTorch version)."""
        recognizer = _get_recognizer(self._model_dir, language=language)
        start = time.perf_counter()

        samples, sample_rate = self._read_wave(audio_path)
        duration_ms = int(len(samples) / sample_rate * 1000)

        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)
        recognizer.decode_stream(stream)

        text = stream.result.text.strip()
        elapsed_ms = int((time.perf_counter() - start) * 1000)

        utterances = []
        if text:
            utterances.append(Utterance(
                id="u_0000",
                text=text,
                start_ms=0,
                end_ms=duration_ms,
                words=[],
                language=language if language != "auto" else "auto",
                confidence=1.0,
            ))

        return TranscriptResult(
            utterances=utterances,
            language=language,
            duration_ms=duration_ms,
            processing_time_ms=elapsed_ms,
            backend="sensevoice-onnx",
            model_size="SenseVoiceSmall-onnx",
        )

    def transcribe_pcm(
        self, pcm_data: bytes, sample_rate: int = 16000, language: str = "auto"
    ) -> TranscriptResult:
        """Transcribe raw PCM16 data. Writes to temp WAV then calls transcribe()."""
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            with wave.open(tmp, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(pcm_data)
            tmp_path = tmp.name

        try:
            return self.transcribe(tmp_path, language=language)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
