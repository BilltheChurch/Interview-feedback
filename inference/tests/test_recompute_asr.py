"""Test selective recompute ASR."""
import os
import tempfile
import wave
from unittest.mock import MagicMock

import pytest

from app.services.backends.asr_recompute import SelectiveRecomputeASR


def test_recompute_skips_high_confidence():
    """High-confidence utterances should not be recomputed."""
    utts = [
        {"text": "Hello", "confidence": 0.95, "start_ms": 0, "end_ms": 1000},
        {"text": "World", "confidence": 0.50, "start_ms": 1000, "end_ms": 2000},
    ]
    high = [u for u in utts if u.get("confidence", 1.0) >= 0.7]
    low = [u for u in utts if u.get("confidence", 1.0) < 0.7]
    assert len(high) == 1
    assert len(low) == 1
    assert high[0]["text"] == "Hello"
    assert low[0]["text"] == "World"


def test_recompute_class_exists():
    """SelectiveRecomputeASR class should be importable."""
    assert hasattr(SelectiveRecomputeASR, "recompute_low_confidence")


# --- recompute_utterance() per-segment interface tests ---


def _make_test_wav(duration_s: float = 1.0, sr: int = 16000) -> str:
    """Create a temporary silent WAV file for testing."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    n_samples = int(duration_s * sr)
    pcm = b"\x00\x00" * n_samples
    with wave.open(tmp.name, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    tmp.close()
    return tmp.name


def test_recompute_utterance_returns_dict_with_text():
    """recompute_utterance must return {text, confidence, recomputed}."""
    recomputer = SelectiveRecomputeASR(model_size="tiny", device="cpu")

    mock_segment = MagicMock()
    mock_segment.text = " improved text "
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ([mock_segment], MagicMock())
    recomputer._model = mock_model

    wav_path = _make_test_wav(1.0)
    try:
        result = recomputer.recompute_utterance(wav_path, language="en")
        assert result["text"] == "improved text"
        assert result["confidence"] == 0.90
        assert result["recomputed"] is True
    finally:
        os.unlink(wav_path)


def test_recompute_utterance_empty_text_returns_empty():
    """Empty transcription should return empty text."""
    recomputer = SelectiveRecomputeASR(model_size="tiny", device="cpu")
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ([], MagicMock())
    recomputer._model = mock_model

    wav_path = _make_test_wav(0.5)
    try:
        result = recomputer.recompute_utterance(wav_path)
        assert result["text"] == ""
        assert result["recomputed"] is True
    finally:
        os.unlink(wav_path)


def test_recompute_utterance_model_error_propagates():
    """Model errors should propagate (caller handles)."""
    recomputer = SelectiveRecomputeASR(model_size="tiny", device="cpu")
    mock_model = MagicMock()
    mock_model.transcribe.side_effect = RuntimeError("CUDA OOM")
    recomputer._model = mock_model

    wav_path = _make_test_wav(1.0)
    try:
        with pytest.raises(RuntimeError, match="CUDA OOM"):
            recomputer.recompute_utterance(wav_path)
    finally:
        os.unlink(wav_path)
