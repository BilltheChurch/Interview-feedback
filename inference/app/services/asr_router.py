"""Language-aware ASR router — dispatches to the optimal model per language.

English → Moonshine ONNX (WER ~3.23% on LibriSpeech, English-specialized)
Chinese/Japanese/Korean/Cantonese → SenseVoice ONNX (CER ~5.17% on AISHELL-1)
Auto → SenseVoice detects language; if English, re-routes to Moonshine

This router is transparent: callers see the same TranscriptResult interface
regardless of which backend actually processed the audio.
"""

from __future__ import annotations

import logging
import os
import time

from app.services.whisper_batch import TranscriptResult

logger = logging.getLogger(__name__)

# Languages that Moonshine handles better
_MOONSHINE_LANGUAGES = {"en", "english"}

# Languages that SenseVoice handles (all its supported languages)
_SENSEVOICE_LANGUAGES = {"zh", "en", "ja", "ko", "yue", "auto"}


class LanguageAwareASRRouter:
    """Routes ASR requests to the optimal model based on detected language.

    When language="auto", uses SenseVoice for initial detection, then
    re-transcribes with Moonshine if English is detected (for higher accuracy).

    When language is explicitly specified:
        - "en" → Moonshine (English-specialized, lower WER)
        - "zh"/"ja"/"ko"/"yue" → SenseVoice (multilingual)
        - "auto" → detect-then-route

    Falls back to SenseVoice if Moonshine model is not available.
    """

    def __init__(
        self,
        sensevoice_model_dir: str = "~/.cache/sensevoice-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
        moonshine_model_dir: str = "~/.cache/moonshine-onnx/sherpa-onnx-moonshine-base-en-int8",
    ) -> None:
        from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber

        self._sensevoice = SenseVoiceOnnxTranscriber(model_dir=sensevoice_model_dir)
        self._moonshine = None
        self._moonshine_available = False

        # Try to load Moonshine (optional — graceful degradation if missing)
        moonshine_dir = os.path.expanduser(moonshine_model_dir)
        tokens_path = os.path.join(moonshine_dir, "tokens.txt")
        if os.path.exists(tokens_path):
            try:
                from app.services.moonshine_onnx import MoonshineOnnxTranscriber

                self._moonshine = MoonshineOnnxTranscriber(model_dir=moonshine_model_dir)
                self._moonshine_available = True
                logger.info(
                    "Language-aware ASR router: Moonshine available for English routing"
                )
            except Exception as exc:
                logger.warning("Moonshine ONNX failed to initialize: %s", exc)
        else:
            logger.info(
                "Moonshine model not found at %s — English will use SenseVoice fallback",
                moonshine_dir,
            )

    @property
    def device(self) -> str:
        return self._sensevoice.device

    @property
    def backend(self) -> str:
        if self._moonshine_available:
            return "language-aware(sensevoice+moonshine)"
        return "sensevoice-onnx"

    @property
    def model_size(self) -> str:
        if self._moonshine_available:
            return "SenseVoice+Moonshine"
        return self._sensevoice.model_size

    def _is_english_language(self, lang: str) -> bool:
        """Check if the language code indicates English."""
        return lang.lower().strip() in _MOONSHINE_LANGUAGES

    def _detect_language_from_result(self, result: TranscriptResult) -> str:
        """Extract detected language from SenseVoice result.

        SenseVoice includes language tags like <|en|>, <|zh|> in its output
        when language="auto". We also check the utterance language field.
        """
        if result.language and result.language != "auto":
            return result.language

        # Check first utterance's language field
        for u in result.utterances:
            if u.language and u.language != "auto":
                return u.language

        # Heuristic: check if text is predominantly ASCII (likely English)
        full_text = " ".join(u.text for u in result.utterances)
        if full_text:
            ascii_ratio = sum(1 for c in full_text if ord(c) < 128) / len(full_text)
            if ascii_ratio > 0.85:
                return "en"

        return "auto"

    def transcribe(self, audio_path: str, language: str = "auto") -> TranscriptResult:
        """Transcribe audio with language-optimal model selection.

        Args:
            audio_path: Path to WAV audio file.
            language: Language code ("en", "zh", "auto", etc.)

        Returns:
            TranscriptResult from the optimal backend.
        """
        # Explicit English → use Moonshine directly
        if self._is_english_language(language) and self._moonshine_available:
            logger.debug("ASR router: explicit English → Moonshine")
            return self._moonshine.transcribe(audio_path, language="en")

        # Explicit non-English → use SenseVoice directly
        if language != "auto" and not self._is_english_language(language):
            logger.debug("ASR router: explicit %s → SenseVoice", language)
            return self._sensevoice.transcribe(audio_path, language=language)

        # Auto-detect: use SenseVoice (best for multilingual/accented speech)
        # NOTE: We intentionally do NOT re-route to Moonshine on auto-detect.
        # SenseVoice outperforms Moonshine base on non-native English (accented
        # speakers, code-switching) which is the dominant interview scenario.
        # Moonshine is only used when the caller explicitly requests language="en".
        return self._sensevoice.transcribe(audio_path, language="auto")

    def transcribe_pcm(
        self, pcm_data: bytes, sample_rate: int = 16000, language: str = "auto"
    ) -> TranscriptResult:
        """Transcribe raw PCM16 data with language-optimal model selection."""
        # Explicit English → Moonshine directly
        if self._is_english_language(language) and self._moonshine_available:
            return self._moonshine.transcribe_pcm(pcm_data, sample_rate, language="en")

        # Explicit non-English → SenseVoice directly
        if language != "auto" and not self._is_english_language(language):
            return self._sensevoice.transcribe_pcm(pcm_data, sample_rate, language=language)

        # Auto-detect: use SenseVoice (see transcribe() comment for rationale)
        return self._sensevoice.transcribe_pcm(pcm_data, sample_rate, language="auto")
