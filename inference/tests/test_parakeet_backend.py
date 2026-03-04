"""Test Parakeet TDT ASR backend (mocked — NeMo requires CUDA)."""
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


def test_parakeet_no_nemo_falls_back_with_log(caplog):
    """Without NeMo/CUDA, Parakeet must fallback and log warning."""
    import logging

    from app.config import Settings
    s = Settings(
        _env_file=None,
        ASR_BACKEND="parakeet",
        SV_T_LOW=0.50, SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72, PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    with patch(
        "app.services.backends.asr_parakeet.ParakeetTDTTranscriber",
        side_effect=OSError("libcudart.so not found"),
    ):
        from app.runtime import build_asr_backend
        with caplog.at_level(logging.WARNING, logger="app.runtime"):
            backend = build_asr_backend(s)

    from app.services.asr_router import LanguageAwareASRRouter
    assert isinstance(backend, LanguageAwareASRRouter)
    assert any("Parakeet unavailable" in r.message for r in caplog.records)
    assert any("falling back" in r.message for r in caplog.records)


def test_parakeet_transcribe_returns_transcript_result():
    """transcribe() must return TranscriptResult, not list[dict]."""
    from app.services.whisper_batch import TranscriptResult, Utterance

    # Mock the nemo module so we can instantiate without CUDA
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ["Hello world"]

    with patch.dict("sys.modules", {"nemo": MagicMock(), "nemo.collections": MagicMock(), "nemo.collections.asr": MagicMock()}):
        with patch("nemo.collections.asr.models.ASRModel.from_pretrained", return_value=mock_model):
            from app.services.backends.asr_parakeet import ParakeetTDTTranscriber
            # Bypass __init__ by creating instance manually
            transcriber = object.__new__(ParakeetTDTTranscriber)
            transcriber.model = mock_model
            transcriber._device = "cpu"
            transcriber.backend = "parakeet"
            transcriber.device = "cpu"
            transcriber.model_size = "nvidia/parakeet-tdt-0.6b-v2"

    # Create a real test WAV file
    import tempfile
    import wave
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(tmp.name, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 16000)  # 1 second of silence
    tmp.close()

    try:
        result = transcriber.transcribe(tmp.name)
        assert isinstance(result, TranscriptResult)
        assert len(result.utterances) == 1
        assert isinstance(result.utterances[0], Utterance)
        assert result.utterances[0].text == "Hello world"
        assert result.backend == "parakeet"
        assert result.duration_ms == 1000
    finally:
        import os
        os.unlink(tmp.name)
