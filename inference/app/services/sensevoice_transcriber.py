"""SenseVoice-Small ASR backend via FunASR.

Replaces faster-whisper for Tier 1 windowed transcription.
SenseVoice-Small: 234M params, non-autoregressive, EN+ZH bilingual.
- EN WER: 1.82% (LibriSpeech test-clean)
- ZH WER: 5.14% (AISHELL-1 test)
- Speed: 70ms for 10s audio (15x faster than Whisper Large-v3)
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
import wave
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from app.services.device import DeviceType, detect_device
from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp

logger = logging.getLogger(__name__)

# Module-level singleton cache
_sv_model: Any | None = None
_sv_model_lock = threading.Lock()


def _get_sensevoice_model(
    model_id: str,
    device: DeviceType,
    cache_dir: str,
) -> Any:
    """Lazy-load SenseVoice model (thread-safe singleton)."""
    global _sv_model
    if _sv_model is not None:
        return _sv_model

    with _sv_model_lock:
        if _sv_model is not None:
            return _sv_model

        os.environ.setdefault("MODELSCOPE_CACHE", os.path.expanduser(cache_dir))

        from funasr import AutoModel

        # Device mapping for FunASR
        device_str = "cpu"
        if device == "cuda":
            device_str = "cuda:0"
        elif device == "mps":
            # FunASR + SenseVoice supports MPS via PyTorch backend
            device_str = "mps"

        logger.info("Loading SenseVoice model=%s device=%s", model_id, device_str)
        start = time.perf_counter()

        _sv_model = AutoModel(
            model=model_id,
            trust_remote_code=True,
            device=device_str,
        )

        load_time = time.perf_counter() - start
        logger.info("SenseVoice model loaded in %.2fs", load_time)
        return _sv_model


class SenseVoiceTranscriber:
    """SenseVoice-Small ASR backend.

    Drop-in replacement for WhisperBatchTranscriber.
    Returns the same TranscriptResult dataclass.
    """

    def __init__(
        self,
        model_id: str = "iic/SenseVoiceSmall",
        device: str = "auto",
        cache_dir: str = "~/.cache/modelscope",
    ) -> None:
        self._model_id = model_id
        self._device: DeviceType = detect_device() if device == "auto" else device  # type: ignore[assignment]
        self._cache_dir = cache_dir

    @property
    def device(self) -> DeviceType:
        return self._device

    @property
    def backend(self) -> str:
        return "sensevoice"

    @property
    def model_size(self) -> str:
        return self._model_id.split("/")[-1]

    def transcribe(self, audio_path: str, language: str = "auto") -> TranscriptResult:
        """Transcribe an audio file. Returns TranscriptResult (same schema as Whisper)."""
        model = _get_sensevoice_model(self._model_id, self._device, self._cache_dir)

        start = time.perf_counter()

        # SenseVoice language mapping
        lang_map = {"zh": "zh", "en": "en", "ja": "ja", "ko": "ko", "yue": "yue"}
        sv_lang = lang_map.get(language, "auto")

        results = model.generate(
            input=audio_path,
            cache={},
            language=sv_lang,
            use_itn=True,
            batch_size_s=60,  # Process up to 60s per batch
        )

        elapsed_ms = int((time.perf_counter() - start) * 1000)

        # Parse SenseVoice output
        utterances: list[Utterance] = []
        detected_lang = language

        for i, res in enumerate(results):
            raw_text = res.get("text", "")
            # Strip SenseVoice special tokens: <|zh|><|NEUTRAL|><|Speech|><|woitn|>
            text = self._strip_special_tokens(raw_text)

            if not text.strip():
                continue

            # Extract language from special tokens if auto
            if language == "auto":
                detected_lang = self._detect_language_from_tokens(raw_text)

            # SenseVoice returns timestamps if available
            timestamp = res.get("timestamp", [])
            words: list[WordTimestamp] = []
            if timestamp:
                for ts_item in timestamp:
                    if isinstance(ts_item, (list, tuple)) and len(ts_item) >= 3:
                        words.append(WordTimestamp(
                            word=str(ts_item[2]) if len(ts_item) > 2 else "",
                            start_ms=int(ts_item[0]),
                            end_ms=int(ts_item[1]),
                            confidence=1.0,
                        ))

            utterances.append(Utterance(
                id=f"u_{i:04d}",
                text=text,
                start_ms=words[0].start_ms if words else 0,
                end_ms=words[-1].end_ms if words else 0,
                words=words,
                language=detected_lang,
                confidence=1.0,
            ))

        # Calculate audio duration from file
        duration_ms = self._get_audio_duration_ms(audio_path)

        return TranscriptResult(
            utterances=utterances,
            language=detected_lang,
            duration_ms=duration_ms,
            processing_time_ms=elapsed_ms,
            backend="sensevoice",
            model_size=self.model_size,
        )

    def transcribe_pcm(
        self,
        pcm_data: bytes,
        sample_rate: int = 16000,
        language: str = "auto",
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

    @staticmethod
    def _strip_special_tokens(text: str) -> str:
        """Remove SenseVoice special tokens from output."""
        import re
        # Tokens: <|zh|>, <|en|>, <|NEUTRAL|>, <|HAPPY|>, <|Speech|>, <|woitn|>, etc.
        return re.sub(r"<\|[^|]+\|>", "", text).strip()

    @staticmethod
    def _detect_language_from_tokens(text: str) -> str:
        """Extract detected language from SenseVoice special tokens."""
        import re
        match = re.search(r"<\|(zh|en|ja|ko|yue)\|>", text)
        return match.group(1) if match else "auto"

    @staticmethod
    def _get_audio_duration_ms(audio_path: str) -> int:
        """Get audio duration in milliseconds."""
        try:
            with wave.open(audio_path, "rb") as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                return int(frames / rate * 1000)
        except Exception:
            return 0
