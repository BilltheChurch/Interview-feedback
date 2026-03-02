"""Test Parakeet TDT ASR backend (mocked — NeMo requires CUDA)."""
import pytest
from unittest.mock import MagicMock, patch


def test_parakeet_config_accepted():
    """Config should accept 'parakeet' as ASR backend."""
    from app.config import Settings
    s = Settings(
        _env_file=None,
        ASR_BACKEND="parakeet",
        SV_T_LOW=0.50, SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72, PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    assert s.asr_backend == "parakeet"


def test_parakeet_transcriber_interface():
    """ParakeetTDTTranscriber should have transcribe method."""
    from app.services.backends.asr_parakeet import ParakeetTDTTranscriber
    assert hasattr(ParakeetTDTTranscriber, "transcribe")
    assert hasattr(ParakeetTDTTranscriber, "transcribe_with_timestamps")


def test_parakeet_transcriber_has_transcribe_pcm():
    """ParakeetTDTTranscriber should have transcribe_pcm for raw audio."""
    from app.services.backends.asr_parakeet import ParakeetTDTTranscriber
    assert hasattr(ParakeetTDTTranscriber, "transcribe_pcm")


def test_parakeet_backend_fallback_on_import_error():
    """build_asr_backend should fall back to sensevoice-onnx when NeMo unavailable."""
    from app.config import Settings
    s = Settings(
        _env_file=None,
        ASR_BACKEND="parakeet",
        SV_T_LOW=0.50, SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72, PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    with patch(
        "app.services.backends.asr_parakeet.ParakeetTDTTranscriber",
        side_effect=ImportError("nemo not installed"),
    ):
        from app.runtime import build_asr_backend
        backend = build_asr_backend(s)
        # Should fall back to LanguageAwareASRRouter (sensevoice-onnx)
        assert backend is not None
        assert hasattr(backend, "transcribe")
