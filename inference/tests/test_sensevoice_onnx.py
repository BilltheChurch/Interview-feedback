"""Tests for SenseVoice ONNX backend.

Tests verify:
1. Module doesn't import torch (GATE 3.4)
2. Transcriber has correct properties
3. TranscriptResult schema matches PyTorch version
4. Config and runtime integration
"""

import ast
import os
from pathlib import Path

import pytest


class TestNoTorchImport:
    """GATE 3.4: ONNX backend must not import torch."""

    def test_no_torch_in_source(self):
        source = Path("app/services/sensevoice_onnx.py").read_text()
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert not alias.name.startswith("torch"), (
                        f"Found torch import: {alias.name}"
                    )
            if isinstance(node, ast.ImportFrom):
                if node.module:
                    assert not node.module.startswith("torch"), (
                        f"Found torch import from: {node.module}"
                    )


class TestOnnxTranscriberProperties:
    def test_device(self):
        from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber

        t = SenseVoiceOnnxTranscriber.__new__(SenseVoiceOnnxTranscriber)
        t._model_dir = "/fake"
        assert t.device == "onnx-cpu"

    def test_backend(self):
        from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber

        t = SenseVoiceOnnxTranscriber.__new__(SenseVoiceOnnxTranscriber)
        t._model_dir = "/fake"
        assert t.backend == "sensevoice-onnx"

    def test_model_size(self):
        from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber

        t = SenseVoiceOnnxTranscriber.__new__(SenseVoiceOnnxTranscriber)
        t._model_dir = "/fake"
        assert t.model_size == "SenseVoiceSmall-onnx"


class TestOnnxConfigIntegration:
    def test_config_accepts_sensevoice_onnx(self):
        """Config should accept 'sensevoice-onnx' as ASR_BACKEND."""
        from app.config import Settings

        s = Settings(
            _env_file=None,
            ASR_BACKEND="sensevoice-onnx",
            INFERENCE_API_KEY="test",
        )
        assert s.asr_backend == "sensevoice-onnx"

    def test_config_onnx_model_path_default(self):
        """Config should have a default ONNX model path."""
        from app.config import Settings

        s = Settings(
            _env_file=None,
            ASR_BACKEND="sensevoice-onnx",
            INFERENCE_API_KEY="test",
        )
        assert "sensevoice-onnx" in s.asr_onnx_model_path
        assert "sherpa-onnx-sense-voice" in s.asr_onnx_model_path

    def test_config_onnx_model_path_custom(self):
        """Config should accept custom ONNX model path."""
        from app.config import Settings

        s = Settings(
            _env_file=None,
            ASR_BACKEND="sensevoice-onnx",
            ASR_ONNX_MODEL_PATH="/custom/model/path",
            INFERENCE_API_KEY="test",
        )
        assert s.asr_onnx_model_path == "/custom/model/path"

    def test_runtime_builds_onnx_backend(self):
        """Runtime should create SenseVoiceOnnxTranscriber when configured."""
        from app.config import Settings
        from app.runtime import build_asr_backend
        from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber

        s = Settings(
            _env_file=None,
            ASR_BACKEND="sensevoice-onnx",
            ASR_ONNX_MODEL_PATH="/fake/path",
            INFERENCE_API_KEY="test",
        )
        backend = build_asr_backend(s)
        assert isinstance(backend, SenseVoiceOnnxTranscriber)

    def test_runtime_builds_sensevoice_backend(self):
        """Runtime should still create SenseVoiceTranscriber for 'sensevoice'."""
        from app.config import Settings
        from app.runtime import build_asr_backend
        from app.services.sensevoice_transcriber import SenseVoiceTranscriber

        s = Settings(
            _env_file=None,
            ASR_BACKEND="sensevoice",
            INFERENCE_API_KEY="test",
        )
        backend = build_asr_backend(s)
        assert isinstance(backend, SenseVoiceTranscriber)


class TestTranscriptResultSchema:
    """Verify TranscriptResult schema is shared between PyTorch and ONNX backends."""

    def test_shared_dataclass_import(self):
        """ONNX backend reuses TranscriptResult from whisper_batch module."""
        from app.services.sensevoice_onnx import TranscriptResult as OnnxResult
        from app.services.whisper_batch import TranscriptResult as WhisperResult

        assert OnnxResult is WhisperResult

    def test_shared_utterance_import(self):
        """ONNX backend reuses Utterance from whisper_batch module."""
        from app.services.sensevoice_onnx import Utterance as OnnxUtterance
        from app.services.whisper_batch import Utterance as WhisperUtterance

        assert OnnxUtterance is WhisperUtterance
