"""Tests for PyannoteFullDiarizer service.

These tests mock pyannote.audio so they run fast without GPU,
HuggingFace token, or model downloads.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock

import numpy as np
import pytest

from app.services.diarize_full import (
    PyannoteFullDiarizer,
    DiarizeResult,
    SpeakerSegment,
    detect_device,
)


# ---------------------------------------------------------------------------
# Device detection
# ---------------------------------------------------------------------------


def test_detect_device_cuda():
    mock_torch = MagicMock()
    mock_torch.cuda.is_available.return_value = True
    # Explicitly set hip=None to indicate NVIDIA CUDA, not ROCm
    mock_torch.version.hip = None
    with patch.dict("sys.modules", {"torch": mock_torch}):
        from app.services.diarize_full import detect_device as dd

        assert dd() == "cuda"


def test_detect_device_rocm():
    mock_torch = MagicMock()
    mock_torch.cuda.is_available.return_value = True
    mock_torch.version.hip = "6.0.32830"  # ROCm HIP version
    with patch.dict("sys.modules", {"torch": mock_torch}):
        from app.services.diarize_full import detect_device as dd

        assert dd() == "rocm"


def test_detect_device_mps():
    mock_torch = MagicMock()
    mock_torch.cuda.is_available.return_value = False
    mock_torch.backends.mps.is_available.return_value = True
    with patch.dict("sys.modules", {"torch": mock_torch}):
        from app.services.diarize_full import detect_device as dd

        assert dd() == "mps"


def test_detect_device_cpu():
    mock_torch = MagicMock()
    mock_torch.cuda.is_available.return_value = False
    mock_torch.backends.mps.is_available.return_value = False
    with patch.dict("sys.modules", {"torch": mock_torch}):
        from app.services.diarize_full import detect_device as dd

        assert dd() == "cpu"


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


def test_constructor_defaults():
    with patch("app.services.diarize_full.detect_device", return_value="cpu"):
        d = PyannoteFullDiarizer(hf_token="hf_test")
        assert d.device == "cpu"
        assert d.model_id == "pyannote/speaker-diarization-community-1"


def test_constructor_explicit_device():
    d = PyannoteFullDiarizer(device="cuda", hf_token="hf_test")
    assert d.device == "cuda"


def test_constructor_custom_model():
    d = PyannoteFullDiarizer(
        device="cpu",
        hf_token="hf_test",
        model_id="custom/model",
    )
    assert d.model_id == "custom/model"


# ---------------------------------------------------------------------------
# Missing HF token
# ---------------------------------------------------------------------------


def test_diarize_raises_without_hf_token():
    """Pipeline load should fail if no HF token is provided."""
    d = PyannoteFullDiarizer(device="cpu", hf_token="")

    # Create a temporary file so FileNotFoundError doesn't fire first
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(b"\x00" * 100)
        tmp_path = f.name

    try:
        with patch.dict("os.environ", {"HF_TOKEN": ""}, clear=False):
            with pytest.raises(RuntimeError, match="HuggingFace token required"):
                d.diarize(tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# File not found
# ---------------------------------------------------------------------------


def test_diarize_file_not_found():
    d = PyannoteFullDiarizer(device="cpu", hf_token="hf_test")
    with pytest.raises(FileNotFoundError):
        d.diarize("/nonexistent/audio.wav")


# ---------------------------------------------------------------------------
# Mocked pipeline diarization
# ---------------------------------------------------------------------------


def _build_mock_annotation(speaker_turns):
    """Build a mock pyannote Annotation from a list of (start, end, speaker)."""

    class MockTurn:
        def __init__(self, start, end):
            self.start = start
            self.end = end

    class MockAnnotation:
        def __init__(self, turns):
            self._turns = turns

        def itertracks(self, yield_label=False):
            for start, end, speaker in self._turns:
                yield MockTurn(start, end), None, speaker

    return MockAnnotation(speaker_turns)


def test_diarize_with_mocked_pipeline():
    """Test the full diarize path with a mocked pyannote pipeline."""
    mock_annotation = _build_mock_annotation([
        (0.0, 5.0, "SPEAKER_00"),
        (5.0, 10.0, "SPEAKER_01"),
        (10.0, 15.0, "SPEAKER_00"),
        (15.0, 20.0, "SPEAKER_02"),
    ])

    mock_pipeline = MagicMock()
    mock_pipeline.return_value = mock_annotation

    mock_from_pretrained = MagicMock(return_value=mock_pipeline)

    with (
        patch("app.services.diarize_full.detect_device", return_value="cpu"),
    ):
        d = PyannoteFullDiarizer(device="cpu", hf_token="hf_test")

    # Inject mock pipeline directly
    d._pipeline = mock_pipeline

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(b"\x00" * 100)
        tmp_path = f.name

    try:
        # Skip embedding extraction for this test
        with patch.object(d, "_ensure_embedding_model"), \
             patch.object(d, "_extract_speaker_embeddings", return_value={}):
            result = d.diarize(tmp_path, num_speakers=3)

        assert isinstance(result, DiarizeResult)
        assert result.num_speakers == 3
        assert len(result.segments) == 4
        assert result.global_clustering_done is True

        # Check segment details
        assert result.segments[0].speaker_id == "SPEAKER_00"
        assert result.segments[0].start_ms == 0
        assert result.segments[0].end_ms == 5000

        assert result.segments[1].speaker_id == "SPEAKER_01"
        assert result.segments[1].start_ms == 5000
        assert result.segments[1].end_ms == 10000

        assert result.segments[3].speaker_id == "SPEAKER_02"
        assert result.segments[3].start_ms == 15000
        assert result.segments[3].end_ms == 20000

        assert result.duration_ms == 20000
        assert result.processing_time_ms >= 0
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def test_diarize_with_speaker_hints():
    """Test that min/max speaker hints are passed to the pipeline."""
    mock_annotation = _build_mock_annotation([
        (0.0, 10.0, "SPEAKER_00"),
        (10.0, 20.0, "SPEAKER_01"),
    ])

    mock_pipeline = MagicMock()
    mock_pipeline.return_value = mock_annotation

    with patch("app.services.diarize_full.detect_device", return_value="cpu"):
        d = PyannoteFullDiarizer(device="cpu", hf_token="hf_test")

    d._pipeline = mock_pipeline

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(b"\x00" * 100)
        tmp_path = f.name

    try:
        with patch.object(d, "_ensure_embedding_model"), \
             patch.object(d, "_extract_speaker_embeddings", return_value={}):
            result = d.diarize(tmp_path, min_speakers=2, max_speakers=4)

        # Verify pipeline was called with the speaker hints
        mock_pipeline.assert_called_once_with(tmp_path, min_speakers=2, max_speakers=4)
        assert result.num_speakers == 2
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def test_diarize_single_speaker():
    """Test diarization with a single speaker."""
    mock_annotation = _build_mock_annotation([
        (0.0, 30.0, "SPEAKER_00"),
    ])

    mock_pipeline = MagicMock()
    mock_pipeline.return_value = mock_annotation

    d = PyannoteFullDiarizer(device="cpu", hf_token="hf_test")
    d._pipeline = mock_pipeline

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(b"\x00" * 100)
        tmp_path = f.name

    try:
        with patch.object(d, "_ensure_embedding_model"), \
             patch.object(d, "_extract_speaker_embeddings", return_value={}):
            result = d.diarize(tmp_path, num_speakers=1)

        assert result.num_speakers == 1
        assert len(result.segments) == 1
        assert result.segments[0].speaker_id == "SPEAKER_00"
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def test_diarize_empty_result():
    """Test diarization that returns no segments (silence)."""
    mock_annotation = _build_mock_annotation([])

    mock_pipeline = MagicMock()
    mock_pipeline.return_value = mock_annotation

    d = PyannoteFullDiarizer(device="cpu", hf_token="hf_test")
    d._pipeline = mock_pipeline

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(b"\x00" * 100)
        tmp_path = f.name

    try:
        with patch.object(d, "_ensure_embedding_model"), \
             patch.object(d, "_extract_speaker_embeddings", return_value={}):
            result = d.diarize(tmp_path)

        assert result.num_speakers == 0
        assert len(result.segments) == 0
        assert result.duration_ms == 0
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# PCM diarization
# ---------------------------------------------------------------------------


def test_diarize_pcm():
    """Test PCM -> WAV -> diarize path."""
    mock_result = DiarizeResult(
        segments=[
            SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=5000),
        ],
        embeddings={},
        num_speakers=1,
        duration_ms=5000,
        processing_time_ms=50,
    )

    d = PyannoteFullDiarizer(device="cpu", hf_token="hf_test")

    with patch.object(d, "diarize", return_value=mock_result) as mock_diarize:
        pcm_data = np.zeros(16000, dtype=np.int16).tobytes()
        result = d.diarize_pcm(pcm_data, sample_rate=16000, num_speakers=1)

        assert result.num_speakers == 1
        mock_diarize.assert_called_once()
        call_path = mock_diarize.call_args[0][0]
        assert call_path.endswith(".wav")


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


def test_diarize_result_dataclass():
    r = DiarizeResult(
        segments=[
            SpeakerSegment(id="seg_0000", speaker_id="S1", start_ms=0, end_ms=1000),
        ],
        embeddings={"S1": [0.1, 0.2, 0.3]},
        num_speakers=1,
        duration_ms=1000,
        processing_time_ms=500,
    )
    assert r.global_clustering_done is True
    assert len(r.embeddings) == 1
    assert r.embeddings["S1"] == [0.1, 0.2, 0.3]


def test_speaker_segment_defaults():
    s = SpeakerSegment(id="seg_0000", speaker_id="S0", start_ms=0, end_ms=100)
    assert s.confidence == 1.0


# ---------------------------------------------------------------------------
# Phase 2: Schema correctness tests
# ---------------------------------------------------------------------------


class TestDiarizeResultSchema:
    def test_result_has_required_fields(self):
        result = DiarizeResult(
            segments=[
                SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=5000),
                SpeakerSegment(id="seg_0001", speaker_id="SPEAKER_01", start_ms=5000, end_ms=10000),
            ],
            embeddings={"SPEAKER_00": [0.1] * 256, "SPEAKER_01": [0.2] * 256},
            num_speakers=2,
            duration_ms=10000,
            processing_time_ms=500,
        )
        assert len(result.segments) == 2
        assert len(result.embeddings) == 2
        assert result.num_speakers == 2
        assert result.segments[0].speaker_id == "SPEAKER_00"

    def test_segment_fields(self):
        seg = SpeakerSegment(id="seg_0", speaker_id="SPEAKER_00", start_ms=100, end_ms=5000, confidence=0.95)
        assert seg.id == "seg_0"
        assert seg.speaker_id == "SPEAKER_00"
        assert seg.start_ms == 100
        assert seg.end_ms == 5000
        assert seg.confidence == 0.95

    def test_empty_segments(self):
        result = DiarizeResult(
            segments=[],
            embeddings={},
            num_speakers=0,
            duration_ms=0,
            processing_time_ms=100,
        )
        assert len(result.segments) == 0
        assert result.num_speakers == 0

    def test_global_clustering_done_default(self):
        result = DiarizeResult(
            segments=[], embeddings={}, num_speakers=0, duration_ms=0, processing_time_ms=0,
        )
        assert result.global_clustering_done is True


class TestDiarizerInit:
    def test_default_model_is_community_1(self):
        d = PyannoteFullDiarizer(hf_token="test_token")
        assert "community-1" in d._model_id

    def test_custom_model_id(self):
        d = PyannoteFullDiarizer(model_id="pyannote/speaker-diarization-3.1", hf_token="test")
        assert d._model_id == "pyannote/speaker-diarization-3.1"

    def test_missing_hf_token_stored(self):
        d = PyannoteFullDiarizer(hf_token="")
        assert d._hf_token == ""

    def test_device_auto_detection(self):
        d = PyannoteFullDiarizer(hf_token="test")
        # Should detect a valid device type
        assert d._device in ("cpu", "cuda", "mps", "rocm")


class TestDiarizerFileNotFound:
    def test_diarize_nonexistent_file(self):
        d = PyannoteFullDiarizer(hf_token="test_token")
        with pytest.raises(FileNotFoundError):
            d.diarize("/nonexistent/path/audio.wav")
