"""Whisper batch transcription service.

Supports multiple backends with automatic device detection:
  - CUDA  -> faster-whisper (CTranslate2)
  - MPS   -> whisper (openai) with torch MPS
  - CPU   -> faster-whisper (CPU) or whisper (openai) fallback

The service is lazy-initialized: the model is only loaded on first call.
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class WordTimestamp:
    word: str
    start_ms: int
    end_ms: int
    confidence: float = 1.0


@dataclass(slots=True)
class Utterance:
    id: str
    text: str
    start_ms: int
    end_ms: int
    words: list[WordTimestamp] = field(default_factory=list)
    language: str = ""
    confidence: float = 1.0


@dataclass(slots=True)
class TranscriptResult:
    utterances: list[Utterance]
    language: str
    duration_ms: int
    processing_time_ms: int
    backend: str
    model_size: str


# ---------------------------------------------------------------------------
# Device detection
# ---------------------------------------------------------------------------

DeviceType = Literal["cuda", "rocm", "mps", "cpu"]


def detect_device() -> DeviceType:
    """Return the best available compute device."""
    try:
        import torch  # noqa: F811

        if torch.cuda.is_available():
            # Check for ROCm (AMD) — torch.cuda works for ROCm too, but
            # the version string contains "rocm" or hip is available.
            if hasattr(torch.version, "hip") and torch.version.hip is not None:
                return "rocm"
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------

BackendType = Literal["faster-whisper", "openai-whisper", "whisper-cpp"]


def _check_faster_whisper() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except ImportError:
        return False


def _check_openai_whisper() -> bool:
    try:
        import whisper  # noqa: F401

        return True
    except ImportError:
        return False


def select_backend(device: DeviceType) -> BackendType:
    """Choose the best available Whisper backend for the given device.

    faster-whisper (CTranslate2) is preferred: it supports CUDA natively
    and falls back to CPU mode for MPS/ROCm (still fast with int8).
    openai-whisper is a fallback if faster-whisper is not installed.
    """
    if _check_faster_whisper():
        return "faster-whisper"
    if _check_openai_whisper():
        return "openai-whisper"
    # Last resort: assume whisper.cpp is on PATH
    return "whisper-cpp"


# ---------------------------------------------------------------------------
# Transcription backends
# ---------------------------------------------------------------------------

# Module-level cache for faster-whisper model (avoids reloading ~1.5GB model per call)
_fw_model_cache: dict[str, object] = {}  # key: "model_size:device:compute_type"
_fw_model_lock = threading.Lock()


def _get_fw_model(model_size: str, fw_device: str, compute_type: str) -> object:
    """Return a cached WhisperModel instance, loading it only on first call.

    Thread-safe: uses a lock so only one thread loads the model even when
    multiple requests arrive concurrently.
    """
    cache_key = f"{model_size}:{fw_device}:{compute_type}"
    if cache_key in _fw_model_cache:
        return _fw_model_cache[cache_key]

    with _fw_model_lock:
        # Double-check after acquiring lock
        if cache_key in _fw_model_cache:
            return _fw_model_cache[cache_key]

        from faster_whisper import WhisperModel

        logger.info("Loading faster-whisper model: %s (device=%s, compute=%s)", model_size, fw_device, compute_type)
        _fw_model_cache[cache_key] = WhisperModel(model_size, device=fw_device, compute_type=compute_type)
        logger.info("Model loaded successfully: %s", cache_key)
    return _fw_model_cache[cache_key]


def _transcribe_faster_whisper(
    audio_path: str,
    model_size: str,
    language: str | None,
    device: DeviceType,
) -> TranscriptResult:
    # CTranslate2 only supports "cuda" and "cpu".
    # ROCm uses HIP (torch.cuda compatible) but CTranslate2 doesn't support it.
    # MPS is also unsupported by CTranslate2.
    if device == "cuda":
        fw_device = "cuda"
        compute_type = "float16"
    elif device == "rocm":
        # ROCm: CTranslate2 can use CUDA API via HIP — try cuda, fallback to cpu
        try:
            fw_device = "cuda"
            compute_type = "float16"
        except Exception:
            logger.warning("ROCm: CTranslate2 CUDA mode failed, falling back to CPU")
            fw_device = "cpu"
            compute_type = "int8"
    else:
        fw_device = "cpu"
        compute_type = "int8"

    t0 = time.monotonic()
    model = _get_fw_model(model_size, fw_device, compute_type)

    lang_arg = language if language and language != "auto" else None
    segments_iter, info = model.transcribe(
        audio_path,
        language=lang_arg,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
    )

    utterances: list[Utterance] = []
    for idx, seg in enumerate(segments_iter):
        words = []
        if seg.words:
            for w in seg.words:
                words.append(
                    WordTimestamp(
                        word=w.word.strip(),
                        start_ms=int(w.start * 1000),
                        end_ms=int(w.end * 1000),
                        confidence=round(w.probability, 4) if w.probability else 1.0,
                    )
                )
        utterances.append(
            Utterance(
                id=f"u_{idx:04d}",
                text=seg.text.strip(),
                start_ms=int(seg.start * 1000),
                end_ms=int(seg.end * 1000),
                words=words,
                language=info.language or "",
                confidence=round(seg.avg_logprob, 4) if seg.avg_logprob else 1.0,
            )
        )

    duration_ms = int(info.duration * 1000) if info.duration else 0
    elapsed = int((time.monotonic() - t0) * 1000)

    return TranscriptResult(
        utterances=utterances,
        language=info.language or "",
        duration_ms=duration_ms,
        processing_time_ms=elapsed,
        backend="faster-whisper",
        model_size=model_size,
    )


def _transcribe_openai_whisper(
    audio_path: str,
    model_size: str,
    language: str | None,
    device: DeviceType,
) -> TranscriptResult:
    import whisper

    t0 = time.monotonic()
    # ROCm uses torch.cuda API via HIP, so "cuda" works for both CUDA and ROCm
    if device in ("cuda", "rocm"):
        torch_device = "cuda"
    elif device == "mps":
        torch_device = "mps"
    else:
        torch_device = "cpu"

    model = whisper.load_model(model_size, device=torch_device)

    kwargs: dict = {"word_timestamps": True}
    if language and language != "auto":
        kwargs["language"] = language

    result = model.transcribe(audio_path, **kwargs)

    utterances: list[Utterance] = []
    for idx, seg in enumerate(result.get("segments", [])):
        words = []
        for w in seg.get("words", []):
            words.append(
                WordTimestamp(
                    word=w["word"].strip(),
                    start_ms=int(w["start"] * 1000),
                    end_ms=int(w["end"] * 1000),
                    confidence=round(w.get("probability", 1.0), 4),
                )
            )
        utterances.append(
            Utterance(
                id=f"u_{idx:04d}",
                text=seg["text"].strip(),
                start_ms=int(seg["start"] * 1000),
                end_ms=int(seg["end"] * 1000),
                words=words,
                language=result.get("language", ""),
                confidence=1.0,
            )
        )

    # Estimate duration from last segment end
    duration_ms = 0
    if utterances:
        duration_ms = utterances[-1].end_ms
    elapsed = int((time.monotonic() - t0) * 1000)

    return TranscriptResult(
        utterances=utterances,
        language=result.get("language", ""),
        duration_ms=duration_ms,
        processing_time_ms=elapsed,
        backend="openai-whisper",
        model_size=model_size,
    )


def _transcribe_whisper_cpp(
    audio_path: str,
    model_size: str,
    language: str | None,
) -> TranscriptResult:
    import json
    import subprocess

    whisper_cpp_bin = os.environ.get("WHISPER_CPP_BIN", "whisper-cpp")
    model_path = os.environ.get(
        "WHISPER_CPP_MODEL",
        str(Path.home() / ".cache" / "whisper-cpp" / f"ggml-{model_size}.bin"),
    )

    cmd = [
        whisper_cpp_bin,
        "-m", model_path,
        "-f", audio_path,
        "--output-json",
        "--print-timestamps",
    ]
    if language and language != "auto":
        cmd.extend(["-l", language])

    t0 = time.monotonic()
    proc = subprocess.run(
        cmd, capture_output=True, text=True, timeout=300
    )
    if proc.returncode != 0:
        raise RuntimeError(f"whisper.cpp failed (exit {proc.returncode}): {proc.stderr[:500]}")

    # whisper-cpp writes JSON next to the input file
    json_path = audio_path + ".json"
    if not Path(json_path).exists():
        raise RuntimeError(f"whisper.cpp did not produce output JSON at {json_path}")

    data = json.loads(Path(json_path).read_text())
    utterances: list[Utterance] = []
    for idx, seg in enumerate(data.get("transcription", [])):
        # whisper.cpp JSON format uses "timestamps" with "from"/"to" in "HH:MM:SS.mmm"
        from_ms = _parse_ts(seg.get("offsets", {}).get("from", 0))
        to_ms = _parse_ts(seg.get("offsets", {}).get("to", 0))
        utterances.append(
            Utterance(
                id=f"u_{idx:04d}",
                text=seg.get("text", "").strip(),
                start_ms=from_ms,
                end_ms=to_ms,
                language="",
                confidence=1.0,
            )
        )

    duration_ms = utterances[-1].end_ms if utterances else 0
    elapsed = int((time.monotonic() - t0) * 1000)

    # Cleanup temp JSON
    try:
        Path(json_path).unlink(missing_ok=True)
    except OSError:
        pass

    return TranscriptResult(
        utterances=utterances,
        language="",
        duration_ms=duration_ms,
        processing_time_ms=elapsed,
        backend="whisper-cpp",
        model_size=model_size,
    )


def _parse_ts(val: int | str) -> int:
    """Parse whisper.cpp timestamp offset (milliseconds as int)."""
    if isinstance(val, int):
        return val
    # Handle "HH:MM:SS.mmm" format if needed
    try:
        return int(val)
    except (ValueError, TypeError):
        return 0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class WhisperBatchTranscriber:
    """Batch audio transcription using Whisper.

    Auto-detects the best available backend and compute device.

    Usage::

        transcriber = WhisperBatchTranscriber(model_size="large-v3")
        result = transcriber.transcribe("/path/to/audio.wav")
    """

    def __init__(
        self,
        model_size: str = "large-v3",
        device: str = "auto",
    ) -> None:
        self._model_size = model_size
        self._device: DeviceType = detect_device() if device == "auto" else device  # type: ignore[assignment]
        self._backend: BackendType = select_backend(self._device)
        logger.info(
            "WhisperBatchTranscriber: device=%s, backend=%s, model=%s",
            self._device,
            self._backend,
            self._model_size,
        )

    @property
    def device(self) -> DeviceType:
        return self._device

    @property
    def backend(self) -> BackendType:
        return self._backend

    @property
    def model_size(self) -> str:
        return self._model_size

    def transcribe(
        self,
        audio_path: str,
        language: str = "auto",
    ) -> TranscriptResult:
        """Transcribe an audio file and return utterances with word-level timestamps.

        Args:
            audio_path: Path to audio file (WAV, FLAC, MP3, etc.)
            language: Language code ('en', 'zh', 'auto' for detection)

        Returns:
            TranscriptResult with utterances, detected language, and timing info.

        Raises:
            FileNotFoundError: If audio_path does not exist.
            RuntimeError: If transcription fails.
        """
        path = Path(audio_path)
        if not path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        lang = language if language != "auto" else None

        if self._backend == "faster-whisper":
            return _transcribe_faster_whisper(audio_path, self._model_size, lang, self._device)
        elif self._backend == "openai-whisper":
            return _transcribe_openai_whisper(audio_path, self._model_size, lang, self._device)
        else:
            return _transcribe_whisper_cpp(audio_path, self._model_size, lang)

    def transcribe_pcm(
        self,
        pcm_data: bytes,
        sample_rate: int = 16000,
        language: str = "auto",
    ) -> TranscriptResult:
        """Transcribe raw PCM16 audio data.

        Writes PCM to a temporary WAV file and transcribes it.

        Args:
            pcm_data: Raw PCM signed 16-bit little-endian audio bytes.
            sample_rate: Sample rate of the PCM data.
            language: Language code or 'auto'.

        Returns:
            TranscriptResult with utterances.
        """
        import struct
        import wave

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with wave.open(tmp_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(sample_rate)
                wf.writeframes(pcm_data)
            return self.transcribe(tmp_path, language=language)
        finally:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass
