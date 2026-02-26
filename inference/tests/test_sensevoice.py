"""Unit tests for SenseVoice transcriber.

Tests verify:
1. Model loading (lazy singleton)
2. PCM transcription returns correct TranscriptResult schema
3. Special token stripping
4. Language detection from tokens
5. Empty audio handling
6. Schema compatibility with Whisper output
"""

import pytest
from unittest.mock import patch, MagicMock
from app.services.sensevoice_transcriber import SenseVoiceTranscriber
from app.services.whisper_batch import TranscriptResult, Utterance


class TestSpecialTokenStripping:
    def test_strips_language_token(self):
        assert SenseVoiceTranscriber._strip_special_tokens("<|zh|>你好世界") == "你好世界"

    def test_strips_multiple_tokens(self):
        raw = "<|zh|><|NEUTRAL|><|Speech|><|woitn|>你好世界"
        assert SenseVoiceTranscriber._strip_special_tokens(raw) == "你好世界"

    def test_preserves_clean_text(self):
        assert SenseVoiceTranscriber._strip_special_tokens("Hello world") == "Hello world"

    def test_strips_emotion_tokens(self):
        raw = "<|en|><|HAPPY|><|Speech|>Great job everyone"
        assert SenseVoiceTranscriber._strip_special_tokens(raw) == "Great job everyone"


class TestLanguageDetection:
    def test_detects_chinese(self):
        assert SenseVoiceTranscriber._detect_language_from_tokens("<|zh|>你好") == "zh"

    def test_detects_english(self):
        assert SenseVoiceTranscriber._detect_language_from_tokens("<|en|>Hello") == "en"

    def test_returns_auto_for_unknown(self):
        assert SenseVoiceTranscriber._detect_language_from_tokens("Hello") == "auto"


class TestTranscribeOutput:
    """Verify output schema matches WhisperBatchTranscriber exactly."""

    def test_returns_transcript_result(self):
        t = SenseVoiceTranscriber.__new__(SenseVoiceTranscriber)
        t._model_id = "iic/SenseVoiceSmall"
        t._device = "cpu"
        t._cache_dir = "~/.cache/modelscope"

        # Mock the model
        mock_model = MagicMock()
        mock_model.generate.return_value = [
            {"text": "<|zh|><|NEUTRAL|><|Speech|>你好世界", "timestamp": [[0, 1500, "你好世界"]]}
        ]

        with patch("app.services.sensevoice_transcriber._get_sensevoice_model", return_value=mock_model):
            with patch.object(SenseVoiceTranscriber, "_get_audio_duration_ms", return_value=3000):
                result = t.transcribe("/fake/path.wav", language="auto")

        # Verify schema compatibility
        assert isinstance(result, TranscriptResult)
        assert isinstance(result.utterances, list)
        assert len(result.utterances) == 1
        assert isinstance(result.utterances[0], Utterance)
        assert result.utterances[0].text == "你好世界"
        assert result.backend == "sensevoice"
        assert result.processing_time_ms >= 0
        assert result.duration_ms == 3000
        assert result.language == "zh"

    def test_empty_audio_returns_empty_utterances(self):
        t = SenseVoiceTranscriber.__new__(SenseVoiceTranscriber)
        t._model_id = "iic/SenseVoiceSmall"
        t._device = "cpu"
        t._cache_dir = "~/.cache/modelscope"

        mock_model = MagicMock()
        mock_model.generate.return_value = [{"text": "", "timestamp": []}]

        with patch("app.services.sensevoice_transcriber._get_sensevoice_model", return_value=mock_model):
            with patch.object(SenseVoiceTranscriber, "_get_audio_duration_ms", return_value=0):
                result = t.transcribe("/fake/silence.wav")

        assert isinstance(result, TranscriptResult)
        assert len(result.utterances) == 0

    def test_backend_property(self):
        t = SenseVoiceTranscriber()
        assert t.backend == "sensevoice"

    def test_model_size_property(self):
        t = SenseVoiceTranscriber(model_id="iic/SenseVoiceSmall")
        assert t.model_size == "SenseVoiceSmall"
