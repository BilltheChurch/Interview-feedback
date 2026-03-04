"""Tests for NemoMSDDDiarizer service.

All tests mock NeMo so they run fast without GPU, model downloads,
or nemo_toolkit installation. The NEMO_AVAILABLE flag is patched to
simulate both installed and missing-library scenarios.
"""

from __future__ import annotations

import json
import os
import tempfile
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Patch NeMo before importing the module under test
# ---------------------------------------------------------------------------

# We patch at the module level so the import guard `NEMO_AVAILABLE` is True
# for most tests, and explicitly set to False for degradation tests.
_mock_clustering_diarizer = MagicMock()


_nemo_modules = {
    "nemo": MagicMock(),
    "nemo.collections": MagicMock(),
    "nemo.collections.asr": MagicMock(),
    "nemo.collections.asr.models": MagicMock(ClusteringDiarizer=_mock_clustering_diarizer),
}

with patch.dict("sys.modules", _nemo_modules):
    import app.services.diarize_nemo as _nemo_mod

    # Force NEMO_AVAILABLE = True for tests that need it
    _nemo_mod.NEMO_AVAILABLE = True
    _nemo_mod.ClusteringDiarizer = _mock_clustering_diarizer

    from app.services.diarize_nemo import (
        DiarizeResult,
        NemoMSDDDiarizer,
        SpeakerSegment,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_wav(path: str, duration_sec: float = 1.0, sample_rate: int = 16000) -> None:
    """Write a minimal silent WAV file for test purposes."""
    num_frames = int(duration_sec * sample_rate)
    pcm = (np.zeros(num_frames, dtype=np.int16)).tobytes()
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)


def _make_rttm(path: str, entries: list[tuple[str, float, float]]) -> None:
    """Write a minimal RTTM file: entries = [(speaker_id, start_sec, duration_sec), ...]."""
    with open(path, "w") as fh:
        for speaker_id, start, dur in entries:
            fh.write(f"SPEAKER test_file 1 {start:.3f} {dur:.3f} <NA> <NA> {speaker_id} <NA> <NA>\n")


# ---------------------------------------------------------------------------
# Graceful degradation: NeMo not installed
# ---------------------------------------------------------------------------


class TestNemoNotInstalled:
    def test_instantiation_raises_import_error(self):
        """When NeMo is not installed, NemoMSDDDiarizer.__init__ must raise ImportError."""
        original = _nemo_mod.NEMO_AVAILABLE
        try:
            _nemo_mod.NEMO_AVAILABLE = False
            with pytest.raises(ImportError, match="NeMo is not installed"):
                NemoMSDDDiarizer()
        finally:
            _nemo_mod.NEMO_AVAILABLE = original

    def test_module_importable_without_nemo(self):
        """The module itself must be importable even without nemo_toolkit."""
        # If we reach this line the module already imported successfully above
        assert _nemo_mod is not None


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


class TestConstructor:
    def test_defaults(self):
        with patch.object(_nemo_mod, "NEMO_AVAILABLE", True):
            d = NemoMSDDDiarizer()
        assert d.model_name == "diar_msdd_telephonic"
        assert d.device in ("cpu", "cuda", "mps")
        assert d._model is None  # lazy — not loaded yet

    def test_explicit_device(self):
        with patch.object(_nemo_mod, "NEMO_AVAILABLE", True):
            d = NemoMSDDDiarizer(device="cuda")
        assert d.device == "cuda"

    def test_custom_model_name(self):
        with patch.object(_nemo_mod, "NEMO_AVAILABLE", True):
            d = NemoMSDDDiarizer(model_name="diar_msdd_meeting", device="cpu")
        assert d.model_name == "diar_msdd_meeting"

    def test_speaker_range_stored(self):
        with patch.object(_nemo_mod, "NEMO_AVAILABLE", True):
            d = NemoMSDDDiarizer(device="cpu", min_speakers=2, max_speakers=6)
        assert d._min_speakers == 2
        assert d._max_speakers == 6

    def test_num_speakers_stored(self):
        with patch.object(_nemo_mod, "NEMO_AVAILABLE", True):
            d = NemoMSDDDiarizer(device="cpu", num_speakers=4)
        assert d._default_num_speakers == 4


# ---------------------------------------------------------------------------
# Device resolution
# ---------------------------------------------------------------------------


class TestDeviceResolution:
    def test_auto_resolves_to_cuda_when_available(self):
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True
        with patch.dict("sys.modules", {"torch": mock_torch}):
            result = NemoMSDDDiarizer._resolve_device("auto")
        assert result == "cuda"

    def test_auto_resolves_to_cpu_when_no_gpu(self):
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = False
        mock_torch.backends.mps.is_available.return_value = False
        with patch.dict("sys.modules", {"torch": mock_torch}):
            result = NemoMSDDDiarizer._resolve_device("auto")
        assert result == "cpu"

    def test_explicit_device_passthrough(self):
        assert NemoMSDDDiarizer._resolve_device("cuda") == "cuda"
        assert NemoMSDDDiarizer._resolve_device("cpu") == "cpu"

    def test_auto_torch_import_error_falls_back_to_cpu(self):
        with patch.dict("sys.modules", {"torch": None}):
            result = NemoMSDDDiarizer._resolve_device("auto")
        assert result == "cpu"


# ---------------------------------------------------------------------------
# RTTM parsing
# ---------------------------------------------------------------------------


class TestRttmParsing:
    def test_basic_two_speakers(self):
        with tempfile.NamedTemporaryFile(suffix=".rttm", mode="w", delete=False) as f:
            f.write("SPEAKER audio 1 0.000 5.000 <NA> <NA> SPEAKER_00 <NA> <NA>\n")
            f.write("SPEAKER audio 1 5.000 5.000 <NA> <NA> SPEAKER_01 <NA> <NA>\n")
            f.write("SPEAKER audio 1 10.000 3.000 <NA> <NA> SPEAKER_00 <NA> <NA>\n")
            tmp = f.name
        try:
            segments = NemoMSDDDiarizer._parse_rttm(tmp)
            assert len(segments) == 3
            assert segments[0].speaker_id == "SPEAKER_00"
            assert segments[0].start_ms == 0
            assert segments[0].end_ms == 5000
            assert segments[1].speaker_id == "SPEAKER_01"
            assert segments[1].start_ms == 5000
            assert segments[1].end_ms == 10000
            assert segments[2].start_ms == 10000
            assert segments[2].end_ms == 13000
        finally:
            Path(tmp).unlink(missing_ok=True)

    def test_empty_rttm(self):
        with tempfile.NamedTemporaryFile(suffix=".rttm", mode="w", delete=False) as f:
            tmp = f.name
        try:
            segments = NemoMSDDDiarizer._parse_rttm(tmp)
            assert segments == []
        finally:
            Path(tmp).unlink(missing_ok=True)

    def test_missing_rttm_returns_empty(self):
        segments = NemoMSDDDiarizer._parse_rttm("/nonexistent/path/output.rttm")
        assert segments == []

    def test_comment_lines_skipped(self):
        with tempfile.NamedTemporaryFile(suffix=".rttm", mode="w", delete=False) as f:
            f.write("# This is a comment\n")
            f.write("SPEAKER audio 1 0.000 2.000 <NA> <NA> SPEAKER_00 <NA> <NA>\n")
            tmp = f.name
        try:
            segments = NemoMSDDDiarizer._parse_rttm(tmp)
            assert len(segments) == 1
        finally:
            Path(tmp).unlink(missing_ok=True)

    def test_segment_ids_are_sequential(self):
        with tempfile.NamedTemporaryFile(suffix=".rttm", mode="w", delete=False) as f:
            for i in range(5):
                f.write(f"SPEAKER audio 1 {i*2}.000 2.000 <NA> <NA> SPEAKER_0{i % 2} <NA> <NA>\n")
            tmp = f.name
        try:
            segments = NemoMSDDDiarizer._parse_rttm(tmp)
            assert [s.id for s in segments] == [f"seg_{i:04d}" for i in range(5)]
        finally:
            Path(tmp).unlink(missing_ok=True)

    def test_confidence_defaults_to_1(self):
        with tempfile.NamedTemporaryFile(suffix=".rttm", mode="w", delete=False) as f:
            f.write("SPEAKER audio 1 0.000 3.000 <NA> <NA> SPEAKER_00 <NA> <NA>\n")
            tmp = f.name
        try:
            segments = NemoMSDDDiarizer._parse_rttm(tmp)
            assert segments[0].confidence == 1.0
        finally:
            Path(tmp).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Manifest writing
# ---------------------------------------------------------------------------


class TestManifestWriting:
    def test_manifest_valid_json(self):
        with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
            tmp = f.name
        try:
            NemoMSDDDiarizer._write_manifest("/tmp/audio.wav", tmp)
            with open(tmp) as fh:
                entry = json.loads(fh.read().strip())
            assert entry["audio_filepath"] == "/tmp/audio.wav"
            assert entry["offset"] == 0
            assert entry["label"] == "infer"
        finally:
            Path(tmp).unlink(missing_ok=True)

    def test_manifest_duration_field(self):
        with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
            tmp = f.name
        try:
            NemoMSDDDiarizer._write_manifest("/tmp/audio.wav", tmp, duration=30.5)
            with open(tmp) as fh:
                entry = json.loads(fh.read().strip())
            assert entry["duration"] == 30.5
        finally:
            Path(tmp).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# FileNotFoundError
# ---------------------------------------------------------------------------


class TestFileNotFound:
    def test_diarize_missing_file(self):
        d = NemoMSDDDiarizer(device="cpu")
        with pytest.raises(FileNotFoundError, match="Audio file not found"):
            d.diarize("/nonexistent/audio.wav")

    def test_diarize_missing_file_does_not_load_model(self):
        """Model must NOT be loaded if the file is missing (fail fast)."""
        d = NemoMSDDDiarizer(device="cpu")
        mock_ensure = MagicMock()
        d._ensure_model = mock_ensure
        with pytest.raises(FileNotFoundError):
            d.diarize("/nonexistent/audio.wav")
        mock_ensure.assert_not_called()


# ---------------------------------------------------------------------------
# Mocked full diarize() path
# ---------------------------------------------------------------------------


class TestDiarizeWithMockedNemo:
    """Test diarize() end-to-end with a mocked NeMo model and RTTM output."""

    def _make_diarizer_with_mock_model(self) -> tuple[NemoMSDDDiarizer, MagicMock]:
        d = NemoMSDDDiarizer(device="cpu")
        mock_model = MagicMock()
        d._model = mock_model  # bypass _ensure_model
        return d, mock_model

    def test_diarize_returns_diarize_result(self):
        d, mock_model = self._make_diarizer_with_mock_model()

        def fake_diarize_side_effect():
            # Simulate NeMo writing an RTTM into cfg.diarizer.out_dir
            out_dir = d._model.cfg.diarizer.out_dir
            rttm_dir = os.path.join(out_dir, "pred_rttms")
            os.makedirs(rttm_dir, exist_ok=True)

        mock_model.diarize.side_effect = fake_diarize_side_effect

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            _make_wav(f.name)
            tmp_path = f.name

        try:
            with patch.object(d, "_parse_rttm", return_value=[
                SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=5000),
                SpeakerSegment(id="seg_0001", speaker_id="SPEAKER_01", start_ms=5000, end_ms=10000),
            ]):
                result = d.diarize(tmp_path, num_speakers=2)

            assert isinstance(result, DiarizeResult)
            assert result.num_speakers == 2
            assert len(result.segments) == 2
            assert result.global_clustering_done is True
            assert result.duration_ms == 10000
            assert result.processing_time_ms >= 0
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def test_diarize_single_speaker(self):
        d, mock_model = self._make_diarizer_with_mock_model()
        mock_model.diarize.return_value = None

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            _make_wav(f.name)
            tmp_path = f.name

        try:
            with patch.object(d, "_parse_rttm", return_value=[
                SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=30000),
            ]):
                result = d.diarize(tmp_path, num_speakers=1)

            assert result.num_speakers == 1
            assert result.segments[0].speaker_id == "SPEAKER_00"
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def test_diarize_empty_result(self):
        d, mock_model = self._make_diarizer_with_mock_model()
        mock_model.diarize.return_value = None

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            _make_wav(f.name)
            tmp_path = f.name

        try:
            with patch.object(d, "_parse_rttm", return_value=[]):
                result = d.diarize(tmp_path)

            assert result.num_speakers == 0
            assert result.segments == []
            assert result.duration_ms == 0
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def test_diarize_num_speakers_sets_oracle_flag(self):
        d, mock_model = self._make_diarizer_with_mock_model()
        mock_model.diarize.return_value = None

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            _make_wav(f.name)
            tmp_path = f.name

        try:
            with patch.object(d, "_parse_rttm", return_value=[]):
                d.diarize(tmp_path, num_speakers=3)

            # When num_speakers is given, oracle mode should be enabled
            assert mock_model.cfg.diarizer.clustering.parameters.oracle_num_speakers is True
            assert mock_model.cfg.diarizer.speaker_embeddings.parameters.num_speakers == 3
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def test_diarize_no_num_speakers_disables_oracle(self):
        d, mock_model = self._make_diarizer_with_mock_model()
        mock_model.diarize.return_value = None

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            _make_wav(f.name)
            tmp_path = f.name

        try:
            with patch.object(d, "_parse_rttm", return_value=[]):
                d.diarize(tmp_path, max_speakers=6)

            assert mock_model.cfg.diarizer.clustering.parameters.oracle_num_speakers is False
            assert mock_model.cfg.diarizer.clustering.parameters.max_num_speakers == 6
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def test_segments_sorted_by_start_ms(self):
        """Segments returned by _parse_rttm may be unsorted — diarize() must sort them."""
        d, mock_model = self._make_diarizer_with_mock_model()
        mock_model.diarize.return_value = None

        unsorted_segments = [
            SpeakerSegment(id="seg_0002", speaker_id="SPEAKER_01", start_ms=10000, end_ms=15000),
            SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=5000),
            SpeakerSegment(id="seg_0001", speaker_id="SPEAKER_00", start_ms=5000, end_ms=10000),
        ]

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            _make_wav(f.name)
            tmp_path = f.name

        try:
            with patch.object(d, "_parse_rttm", return_value=unsorted_segments):
                result = d.diarize(tmp_path)

            starts = [s.start_ms for s in result.segments]
            assert starts == sorted(starts), "Segments must be sorted by start_ms"
        finally:
            Path(tmp_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# PCM diarization
# ---------------------------------------------------------------------------


class TestDiarizePcm:
    def test_diarize_pcm_creates_wav_and_calls_diarize(self):
        """diarize_pcm() must write a WAV file and delegate to diarize()."""
        d = NemoMSDDDiarizer(device="cpu")

        mock_result = DiarizeResult(
            segments=[SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=5000)],
            embeddings={},
            num_speakers=1,
            duration_ms=5000,
            processing_time_ms=10,
        )

        captured_path: list[str] = []

        def fake_diarize(audio_path, **kwargs):
            captured_path.append(audio_path)
            return mock_result

        d.diarize = fake_diarize

        pcm_data = np.zeros(16000, dtype=np.int16).tobytes()
        result = d.diarize_pcm(pcm_data, sample_rate=16000, num_speakers=1)

        assert result.num_speakers == 1
        assert len(captured_path) == 1
        assert captured_path[0].endswith(".wav")
        # Temp file should be cleaned up after diarize_pcm() returns
        assert not Path(captured_path[0]).exists()

    def test_diarize_pcm_wav_is_valid(self):
        """The temporary WAV written by diarize_pcm() must have correct headers."""
        d = NemoMSDDDiarizer(device="cpu")

        written_paths: list[str] = []

        def fake_diarize(audio_path, **kwargs):
            written_paths.append(audio_path)
            # Read the WAV before it's cleaned up
            with wave.open(audio_path) as wf:
                written_paths.append(str(wf.getnchannels()))
                written_paths.append(str(wf.getframerate()))
                written_paths.append(str(wf.getsampwidth()))
            return DiarizeResult(segments=[], embeddings={}, num_speakers=0, duration_ms=0, processing_time_ms=0)

        d.diarize = fake_diarize
        pcm = np.zeros(8000, dtype=np.int16).tobytes()
        d.diarize_pcm(pcm, sample_rate=8000)

        # [path, channels, frame_rate, sample_width]
        assert written_paths[1] == "1"    # mono
        assert written_paths[2] == "8000" # correct sample rate
        assert written_paths[3] == "2"    # 16-bit

    def test_diarize_pcm_passes_speaker_kwargs(self):
        d = NemoMSDDDiarizer(device="cpu")
        captured_kwargs: list[dict] = []

        def fake_diarize(audio_path, **kwargs):
            captured_kwargs.append(kwargs)
            return DiarizeResult(segments=[], embeddings={}, num_speakers=0, duration_ms=0, processing_time_ms=0)

        d.diarize = fake_diarize
        pcm = np.zeros(16000, dtype=np.int16).tobytes()
        d.diarize_pcm(pcm, num_speakers=3, min_speakers=2, max_speakers=5)

        assert captured_kwargs[0]["num_speakers"] == 3
        assert captured_kwargs[0]["min_speakers"] == 2
        assert captured_kwargs[0]["max_speakers"] == 5


# ---------------------------------------------------------------------------
# DiarizeResult schema consistency with PyannoteFullDiarizer
# ---------------------------------------------------------------------------


class TestInterfaceConsistency:
    """Verify NemoMSDDDiarizer returns the same DiarizeResult types as PyannoteFullDiarizer."""

    def test_diarize_result_type(self):
        result = DiarizeResult(
            segments=[
                SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=5000),
            ],
            embeddings={"SPEAKER_00": [0.1] * 192},
            num_speakers=1,
            duration_ms=5000,
            processing_time_ms=100,
        )
        assert result.global_clustering_done is True

    def test_speaker_segment_fields(self):
        seg = SpeakerSegment(
            id="seg_0001",
            speaker_id="SPEAKER_01",
            start_ms=5000,
            end_ms=10000,
            confidence=0.95,
        )
        assert seg.id == "seg_0001"
        assert seg.speaker_id == "SPEAKER_01"
        assert seg.start_ms == 5000
        assert seg.end_ms == 10000
        assert seg.confidence == 0.95

    def test_speaker_segment_confidence_default(self):
        seg = SpeakerSegment(id="seg_0000", speaker_id="S0", start_ms=0, end_ms=100)
        assert seg.confidence == 1.0

    def test_diarize_result_embeddings_are_float_lists(self):
        embeddings = {"SPEAKER_00": [float(i) * 0.01 for i in range(192)]}
        result = DiarizeResult(
            segments=[],
            embeddings=embeddings,
            num_speakers=1,
            duration_ms=0,
            processing_time_ms=0,
        )
        assert isinstance(result.embeddings["SPEAKER_00"], list)
        assert all(isinstance(v, float) for v in result.embeddings["SPEAKER_00"])

    def test_nemo_diarizer_has_same_public_methods_as_pyannote(self):
        """NemoMSDDDiarizer must expose diarize() and diarize_pcm() like PyannoteFullDiarizer."""
        from app.services.diarize_full import PyannoteFullDiarizer

        for method in ("diarize", "diarize_pcm"):
            assert hasattr(NemoMSDDDiarizer, method), f"Missing method: {method}"
            assert hasattr(PyannoteFullDiarizer, method), f"PyannoteFullDiarizer missing: {method}"

    def test_nemo_diarizer_diarize_signature_matches(self):
        """diarize() must accept same kwargs as PyannoteFullDiarizer.diarize()."""
        import inspect

        from app.services.diarize_full import PyannoteFullDiarizer

        nemo_sig = inspect.signature(NemoMSDDDiarizer.diarize)
        pyannote_sig = inspect.signature(PyannoteFullDiarizer.diarize)

        nemo_params = set(nemo_sig.parameters.keys()) - {"self"}
        pyannote_params = set(pyannote_sig.parameters.keys()) - {"self"}

        assert nemo_params == pyannote_params, (
            f"Signature mismatch:\n  NeMo: {nemo_params}\n  Pyannote: {pyannote_params}"
        )

    def test_nemo_diarizer_diarize_pcm_signature_matches(self):
        """diarize_pcm() must accept same kwargs as PyannoteFullDiarizer.diarize_pcm()."""
        import inspect

        from app.services.diarize_full import PyannoteFullDiarizer

        nemo_sig = inspect.signature(NemoMSDDDiarizer.diarize_pcm)
        pyannote_sig = inspect.signature(PyannoteFullDiarizer.diarize_pcm)

        nemo_params = set(nemo_sig.parameters.keys()) - {"self"}
        pyannote_params = set(pyannote_sig.parameters.keys()) - {"self"}

        assert nemo_params == pyannote_params, (
            f"Signature mismatch:\n  NeMo: {nemo_params}\n  Pyannote: {pyannote_params}"
        )


# ---------------------------------------------------------------------------
# Config integration
# ---------------------------------------------------------------------------


class TestConfigIntegration:
    def test_diarization_backend_default_is_pyannote(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,  # type: ignore[call-arg]
            INFERENCE_API_KEY="test",
        )
        assert s.diarization_backend == "pyannote"

    def test_diarization_backend_nemo(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,  # type: ignore[call-arg]
            INFERENCE_API_KEY="test",
            DIARIZATION_BACKEND="nemo",
        )
        assert s.diarization_backend == "nemo"

    def test_nemo_model_name_default(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,  # type: ignore[call-arg]
            INFERENCE_API_KEY="test",
        )
        assert s.nemo_model_name == "diar_msdd_telephonic"

    def test_nemo_device_default(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,  # type: ignore[call-arg]
            INFERENCE_API_KEY="test",
        )
        assert s.nemo_device == "auto"

    def test_nemo_model_name_override(self):
        from app.config import Settings

        s = Settings(
            _env_file=None,  # type: ignore[call-arg]
            INFERENCE_API_KEY="test",
            NEMO_MODEL_NAME="diar_msdd_meeting",
        )
        assert s.nemo_model_name == "diar_msdd_meeting"
