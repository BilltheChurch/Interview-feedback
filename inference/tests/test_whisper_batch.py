"""Tests for WhisperBatchTranscriber service.

These tests mock the heavy ML backends so they run fast without GPU
or model downloads.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from app.services.whisper_batch import (
    WhisperBatchTranscriber,
    TranscriptResult,
    Utterance,
    WordTimestamp,
    detect_device,
    select_backend,
)


# ---------------------------------------------------------------------------
# Device detection
# ---------------------------------------------------------------------------


def test_detect_device_cuda():
    mock_torch = MagicMock()
    mock_torch.cuda.is_available.return_value = True
    mock_torch.version.hip = None
    with patch.dict("sys.modules", {"torch": mock_torch}):
        # Re-import to pick up mocked torch
        from app.services.whisper_batch import detect_device as dd

        assert dd() == "cuda"


def test_detect_device_mps():
    mock_torch = MagicMock()
    mock_torch.cuda.is_available.return_value = False
    mock_torch.backends.mps.is_available.return_value = True
    with patch.dict("sys.modules", {"torch": mock_torch}):
        from app.services.whisper_batch import detect_device as dd

        assert dd() == "mps"


def test_detect_device_cpu_fallback():
    mock_torch = MagicMock()
    mock_torch.cuda.is_available.return_value = False
    mock_torch.backends.mps.is_available.return_value = False
    with patch.dict("sys.modules", {"torch": mock_torch}):
        from app.services.whisper_batch import detect_device as dd

        assert dd() == "cpu"


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------


def test_select_backend_faster_whisper_on_cuda():
    with patch("app.services.whisper_batch._check_faster_whisper", return_value=True):
        assert select_backend("cuda") == "faster-whisper"


def test_select_backend_faster_whisper_on_cpu():
    with patch("app.services.whisper_batch._check_faster_whisper", return_value=True):
        assert select_backend("cpu") == "faster-whisper"


def test_select_backend_openai_whisper_fallback():
    with (
        patch("app.services.whisper_batch._check_faster_whisper", return_value=False),
        patch("app.services.whisper_batch._check_openai_whisper", return_value=True),
    ):
        assert select_backend("mps") == "openai-whisper"


def test_select_backend_rocm_prefers_faster_whisper():
    """ROCm still prefers faster-whisper (CTranslate2 CPU int8 is fast enough)."""
    with (
        patch("app.services.whisper_batch._check_faster_whisper", return_value=True),
        patch("app.services.whisper_batch._check_openai_whisper", return_value=True),
    ):
        assert select_backend("rocm") == "faster-whisper"


def test_select_backend_mps_prefers_faster_whisper():
    """MPS still prefers faster-whisper (CTranslate2 CPU int8 is fast enough)."""
    with (
        patch("app.services.whisper_batch._check_faster_whisper", return_value=True),
        patch("app.services.whisper_batch._check_openai_whisper", return_value=True),
    ):
        assert select_backend("mps") == "faster-whisper"


def test_select_backend_rocm_falls_back_to_faster_whisper():
    """ROCm with no openai-whisper should fall back to faster-whisper (CPU mode)."""
    with (
        patch("app.services.whisper_batch._check_faster_whisper", return_value=True),
        patch("app.services.whisper_batch._check_openai_whisper", return_value=False),
    ):
        assert select_backend("rocm") == "faster-whisper"


def test_select_backend_whisper_cpp_fallback():
    with (
        patch("app.services.whisper_batch._check_faster_whisper", return_value=False),
        patch("app.services.whisper_batch._check_openai_whisper", return_value=False),
    ):
        assert select_backend("cpu") == "whisper-cpp"


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


def test_constructor_auto_device():
    with (
        patch("app.services.whisper_batch.detect_device", return_value="cpu"),
        patch("app.services.whisper_batch.select_backend", return_value="faster-whisper"),
    ):
        t = WhisperBatchTranscriber(model_size="tiny")
        assert t.device == "cpu"
        assert t.backend == "faster-whisper"
        assert t.model_size == "tiny"


def test_constructor_explicit_device():
    with patch("app.services.whisper_batch.select_backend", return_value="openai-whisper"):
        t = WhisperBatchTranscriber(model_size="base", device="mps")
        assert t.device == "mps"
        assert t.backend == "openai-whisper"


# ---------------------------------------------------------------------------
# Transcription — faster-whisper backend (mocked)
# ---------------------------------------------------------------------------


def _make_mock_fw_segment(start, end, text, words=None, avg_logprob=-0.3):
    seg = MagicMock()
    seg.start = start
    seg.end = end
    seg.text = text
    seg.avg_logprob = avg_logprob
    seg.words = words or []
    return seg


def _make_mock_fw_word(word, start, end, prob=0.95):
    w = MagicMock()
    w.word = word
    w.start = start
    w.end = end
    w.probability = prob
    return w


def test_transcribe_faster_whisper_backend():
    """Test full transcription flow with mocked faster-whisper."""
    mock_word = _make_mock_fw_word("hello", 0.0, 0.5, 0.98)
    mock_seg = _make_mock_fw_segment(0.0, 1.0, " hello world ", words=[mock_word])
    mock_info = MagicMock()
    mock_info.language = "en"
    mock_info.duration = 5.0

    mock_model = MagicMock()
    mock_model.transcribe.return_value = (iter([mock_seg]), mock_info)

    # Create a temporary audio file
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(b"\x00" * 100)
        tmp_path = f.name

    try:
        with (
            patch("app.services.whisper_batch.detect_device", return_value="cpu"),
            patch("app.services.whisper_batch.select_backend", return_value="faster-whisper"),
            patch("app.services.whisper_batch.WhisperModel", mock_model.__class__, create=True),
            patch(
                "app.services.whisper_batch._transcribe_faster_whisper",
                return_value=TranscriptResult(
                    utterances=[
                        Utterance(
                            id="u_0000",
                            text="hello world",
                            start_ms=0,
                            end_ms=1000,
                            words=[WordTimestamp(word="hello", start_ms=0, end_ms=500, confidence=0.98)],
                            language="en",
                            confidence=-0.3,
                        )
                    ],
                    language="en",
                    duration_ms=5000,
                    processing_time_ms=100,
                    backend="faster-whisper",
                    model_size="tiny",
                ),
            ),
        ):
            t = WhisperBatchTranscriber(model_size="tiny")
            result = t.transcribe(tmp_path, language="en")

            assert isinstance(result, TranscriptResult)
            assert result.backend == "faster-whisper"
            assert result.language == "en"
            assert len(result.utterances) == 1
            assert result.utterances[0].text == "hello world"
            assert len(result.utterances[0].words) == 1
            assert result.utterances[0].words[0].word == "hello"
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Transcription — file not found
# ---------------------------------------------------------------------------


def test_transcribe_file_not_found():
    with (
        patch("app.services.whisper_batch.detect_device", return_value="cpu"),
        patch("app.services.whisper_batch.select_backend", return_value="faster-whisper"),
    ):
        t = WhisperBatchTranscriber(model_size="tiny")
        with pytest.raises(FileNotFoundError):
            t.transcribe("/nonexistent/audio.wav")


# ---------------------------------------------------------------------------
# PCM transcription
# ---------------------------------------------------------------------------


def test_transcribe_pcm():
    """Test PCM → WAV → transcription path."""
    mock_result = TranscriptResult(
        utterances=[
            Utterance(id="u_0000", text="test", start_ms=0, end_ms=500, language="en")
        ],
        language="en",
        duration_ms=500,
        processing_time_ms=50,
        backend="faster-whisper",
        model_size="tiny",
    )

    with (
        patch("app.services.whisper_batch.detect_device", return_value="cpu"),
        patch("app.services.whisper_batch.select_backend", return_value="faster-whisper"),
    ):
        t = WhisperBatchTranscriber(model_size="tiny")

    with patch.object(t, "transcribe", return_value=mock_result) as mock_transcribe:
        pcm_data = np.zeros(16000, dtype=np.int16).tobytes()
        result = t.transcribe_pcm(pcm_data, sample_rate=16000, language="en")

        assert result.utterances[0].text == "test"
        mock_transcribe.assert_called_once()
        # Check that a .wav temp file was passed
        call_path = mock_transcribe.call_args[0][0]
        assert call_path.endswith(".wav")


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


def test_transcript_result_dataclass():
    r = TranscriptResult(
        utterances=[],
        language="zh",
        duration_ms=10000,
        processing_time_ms=2000,
        backend="openai-whisper",
        model_size="large-v3",
    )
    assert r.language == "zh"
    assert r.duration_ms == 10000
    assert r.backend == "openai-whisper"


def test_utterance_defaults():
    u = Utterance(id="u_0000", text="hi", start_ms=0, end_ms=100)
    assert u.words == []
    assert u.language == ""
    assert u.confidence == 1.0


def test_word_timestamp():
    w = WordTimestamp(word="test", start_ms=100, end_ms=200, confidence=0.9)
    assert w.word == "test"
    assert w.start_ms == 100
    assert w.end_ms == 200
    assert w.confidence == 0.9
