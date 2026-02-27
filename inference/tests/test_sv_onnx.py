"""Tests for OnnxSVBackend.

Tests verify:
1. sv_onnx.py does not import modelscope at module level
2. Backend has correct properties (device, health)
3. Config integration works (SV_BACKEND=onnx)
4. Cosine similarity scoring is correct
5. Error handling for empty audio / empty embeddings
"""

import ast

import numpy as np
import pytest
from pathlib import Path


class TestNoModelScopeImport:
    """Verify sv_onnx.py does not import modelscope at module level."""

    def test_no_modelscope_in_source(self):
        source = Path("app/services/sv_onnx.py").read_text()
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert not alias.name.startswith("modelscope"), (
                        f"Found modelscope import: {alias.name}"
                    )
            if isinstance(node, ast.ImportFrom):
                if node.module:
                    assert not node.module.startswith("modelscope"), (
                        f"Found from modelscope import: {node.module}"
                    )


class TestOnnxSVBackendProperties:
    def test_device_is_onnx(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend.__new__(OnnxSVBackend)
        b._model_path = "/fake"
        b.model_id = "test"
        b.model_revision = "v1"
        b._embedding_dim = None
        b._model_load_seconds = None
        assert b.device == "onnx"

    def test_embedding_dim_initially_none(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend(model_path="/fake/path")
        assert b.embedding_dim is None

    def test_health_before_loading(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend(model_path="/fake/path")
        h = b.health()
        assert h.device == "onnx"
        assert h.model_id == "campplus-onnx"
        assert h.model_revision == "onnx-v1"
        assert h.embedding_dim is None
        assert h.model_load_seconds is None

    def test_custom_model_id(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend(
            model_path="/fake/path",
            model_id="custom-model",
            model_revision="v2",
        )
        h = b.health()
        assert h.model_id == "custom-model"
        assert h.model_revision == "v2"

    def test_model_path_expanduser(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend(model_path="~/some/path.onnx")
        assert "~" not in b._model_path


class TestErrorHandling:
    def test_empty_audio_raises(self):
        from app.services.sv_onnx import OnnxSVBackend
        from app.exceptions import SVBackendError

        b = OnnxSVBackend(model_path="/fake/path")
        with pytest.raises(SVBackendError, match="empty audio"):
            b.extract_embedding(np.array([], dtype=np.float32))

    def test_score_empty_embeddings_raises(self):
        from app.services.sv_onnx import OnnxSVBackend
        from app.exceptions import SVBackendError

        b = OnnxSVBackend(model_path="/fake/path")
        empty = np.array([], dtype=np.float32)
        valid = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        with pytest.raises(SVBackendError, match="empty embeddings"):
            b.score_embeddings(empty, valid)
        with pytest.raises(SVBackendError, match="empty embeddings"):
            b.score_embeddings(valid, empty)


class TestCosineScoring:
    def test_identical_vectors(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend.__new__(OnnxSVBackend)
        a = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        score = b._cosine_similarity(a, a)
        assert abs(score - 1.0) < 1e-6

    def test_orthogonal_vectors(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend.__new__(OnnxSVBackend)
        a = np.array([1.0, 0.0], dtype=np.float32)
        c = np.array([0.0, 1.0], dtype=np.float32)
        score = b._cosine_similarity(a, c)
        assert abs(score) < 1e-6

    def test_opposite_vectors(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend.__new__(OnnxSVBackend)
        a = np.array([1.0, 0.0], dtype=np.float32)
        c = np.array([-1.0, 0.0], dtype=np.float32)
        score = b._cosine_similarity(a, c)
        assert abs(score - (-1.0)) < 1e-6

    def test_zero_norm_raises(self):
        from app.services.sv_onnx import OnnxSVBackend
        from app.exceptions import SVBackendError

        b = OnnxSVBackend.__new__(OnnxSVBackend)
        zero = np.zeros(3, dtype=np.float32)
        valid = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        with pytest.raises(SVBackendError, match="zero-norm"):
            b._cosine_similarity(zero, valid)

    def test_score_embeddings_uses_cosine(self):
        from app.services.sv_onnx import OnnxSVBackend

        b = OnnxSVBackend.__new__(OnnxSVBackend)
        a = np.array([3.0, 4.0], dtype=np.float32)
        c = np.array([4.0, 3.0], dtype=np.float32)
        score = b.score_embeddings(a, c)
        # cos(a,c) = (12+12)/(5*5) = 24/25 = 0.96
        assert abs(score - 0.96) < 1e-6


class TestSVConfigIntegration:
    def test_config_accepts_onnx_backend(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,
            SV_BACKEND="onnx",
            INFERENCE_API_KEY="test",
        )
        assert s.sv_backend == "onnx"

    def test_config_default_is_modelscope(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,
            INFERENCE_API_KEY="test",
        )
        assert s.sv_backend == "modelscope"

    def test_config_onnx_model_path(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,
            SV_BACKEND="onnx",
            SV_ONNX_MODEL_PATH="/custom/path/model.onnx",
            INFERENCE_API_KEY="test",
        )
        assert s.sv_onnx_model_path == "/custom/path/model.onnx"

    def test_config_default_onnx_model_path(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,
            INFERENCE_API_KEY="test",
        )
        assert s.sv_onnx_model_path == "~/.cache/campplus-onnx/campplus.onnx"


class TestSVOnnxHealthDataclass:
    def test_health_dataclass_fields(self):
        from app.services.sv_onnx import SVOnnxHealth

        h = SVOnnxHealth(
            model_id="test",
            model_revision="v1",
            embedding_dim=192,
            model_loaded=True,
            model_load_seconds=0.5,
        )
        assert h.model_id == "test"
        assert h.model_revision == "v1"
        assert h.embedding_dim == 192
        assert h.model_loaded is True
        assert h.model_load_seconds == 0.5
        assert h.device == "onnx"
