"""Test B-Prime arbiter wiring: Pass 3 must call CAM++ with real audio slices.

Acceptance criteria:
- CAM++ extract_embedding called > 0 times for low-confidence mappings
- Pass 3 produces real WAV files (not empty paths)
- Temp WAV files cleaned up after execution
- Temp WAV files cleaned up even if arbiter raises
"""
import os
import tempfile
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import numpy as np
import pytest

from app.services.speaker_arbiter import SpeakerArbiter


# ── Helpers ────────────────────────────────────────────────────────────────


def _make_test_wav(duration_s: float = 1.0, sr: int = 16000) -> str:
    """Create a temporary WAV file with silence."""
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


def _make_embedding(dim: int = 192, seed: int = 42) -> np.ndarray:
    rng = np.random.RandomState(seed)
    emb = rng.randn(dim).astype(np.float32)
    return emb / (np.linalg.norm(emb) + 1e-8)


def _make_controlled_pair(dim: int = 192, cosine_sim: float = 0.45):
    """Create two unit vectors with a specific cosine similarity.

    This is essential for testing Pass 3: we need local→global matching
    to succeed (sim >= relaxed_thr=0.40) but confidence to be low
    (sim < arbiter_threshold=0.50).
    """
    import math
    v1 = np.zeros(dim, dtype=np.float32)
    v1[0] = 1.0

    theta = math.acos(cosine_sim)
    v2 = np.zeros(dim, dtype=np.float32)
    v2[0] = math.cos(theta)
    v2[1] = math.sin(theta)
    return v1, v2


class FakeProfile:
    """Minimal profile with centroid for arbiter matching."""

    def __init__(self, centroid: np.ndarray, total_speech_ms: int = 5000):
        self.centroid = centroid
        self.embeddings = [centroid]
        self.total_speech_ms = total_speech_ms
        self.speaker_id = ""
        self.first_seen_increment = 0

    def update_centroid(self):
        if self.embeddings:
            self.centroid = np.mean(self.embeddings, axis=0).astype(np.float32)


class FakeSegment:
    """Minimal diarization segment."""

    def __init__(self, speaker_id: str, start_ms: int, end_ms: int):
        self.id = f"seg-{speaker_id}-{start_ms}"
        self.speaker_id = speaker_id
        self.start_ms = start_ms
        self.end_ms = end_ms
        self.confidence = 0.5


class FakeDiarizeResult:
    """Minimal DiarizeResult for testing."""

    def __init__(self, segments, embeddings):
        self.segments = segments
        self.embeddings = embeddings
        self.processing_time_ms = 100


# ── Tests ──────────────────────────────────────────────────────────────────


def test_arbiter_extract_embedding_called_for_low_confidence():
    """When mapping confidence < 0.50, arbiter MUST call sv.extract_embedding()."""
    # Create two distinct embeddings so cosine sim is low
    emb_local = _make_embedding(seed=1)
    emb_global = _make_embedding(seed=99)  # different → low sim

    sv = MagicMock()
    # When arbiter calls extract_embedding, return the global emb (so correction happens)
    sv.extract_embedding.return_value = MagicMock(embedding=emb_global)

    arbiter = SpeakerArbiter(sv_backend=sv, confidence_threshold=0.50)

    # Low confidence mapping
    mapping = {"local_0": "global_0"}
    confidences = {"local_0": 0.30}  # low → triggers arbiter

    # Create real temp WAV for audio_segments
    wav_path = _make_test_wav(duration_s=1.0)
    try:
        audio_segments = {"local_0": wav_path}
        profiles = {
            "global_0": FakeProfile(emb_global),
            "global_1": FakeProfile(emb_global),
        }
        profiles["global_0"].speaker_id = "global_0"
        profiles["global_1"].speaker_id = "global_1"

        result = arbiter.arbitrate(mapping, confidences, audio_segments, profiles)

        # Key assertion: CAM++ was actually called
        assert sv.extract_embedding.call_count > 0, (
            "arbiter MUST call sv.extract_embedding for low-confidence mappings"
        )
    finally:
        os.unlink(wav_path)


def test_pass3_slices_real_audio_for_low_confidence():
    """_match_speakers Pass 3 must produce real WAV files for arbiter.

    Scenario: local speaker force-assigned to global with cosine sim=0.45
    (>= relaxed_thr=0.40 but < arbiter_threshold=0.50).
    """
    from app.services.incremental_processor import IncrementalProcessor

    # Create processor with mock arbiter that captures audio_segments
    mock_arbiter = MagicMock(spec=SpeakerArbiter)
    mock_arbiter.confidence_threshold = 0.50
    captured_segments = {}

    def capture_arbitrate(pyannote_mapping, pyannote_confidences, audio_segments, global_profiles):
        captured_segments.update(audio_segments)
        return dict(pyannote_mapping)  # no correction, just capture

    mock_arbiter.arbitrate.side_effect = capture_arbitrate

    settings = MagicMock()
    settings.incremental_speaker_match_threshold = 0.60
    settings.incremental_speaker_match_threshold_relaxed = 0.40
    settings.incremental_min_speaker_duration_ms = 500

    proc = IncrementalProcessor(
        settings=settings,
        diarizer=MagicMock(),
        asr_backend=MagicMock(),
        checkpoint_analyzer=MagicMock(),
        arbiter=mock_arbiter,
    )

    # Create test WAV (3 seconds)
    wav_path = _make_test_wav(duration_s=3.0)

    try:
        # Controlled cosine similarity = 0.45:
        # >= 0.40 (relaxed_thr) for force-assign, but < 0.50 (arbiter threshold)
        emb_local, emb_global = _make_controlled_pair(cosine_sim=0.45)

        from app.services.incremental_processor import IncrementalSessionState, SpeakerProfile
        session = IncrementalSessionState(session_id="test-sess")
        profile = SpeakerProfile(
            speaker_id="spk_00",
            total_speech_ms=5000,
            first_seen_increment=0,
        )
        profile.embeddings.append(emb_global)
        profile.update_centroid()
        session.speaker_profiles["spk_00"] = profile

        # Short duration (400ms < 500ms min_dur_ms) → force-assign path
        # But segment must be >= 300ms for arbiter slicing
        diarize_result = FakeDiarizeResult(
            segments=[
                FakeSegment("local_0", 0, 400),
            ],
            embeddings={
                "local_0": emb_local.tolist(),
            },
        )

        mapping = proc._match_speakers(
            diarize_result, session, increment_index=1,
            audio_start_ms=0, audio_end_ms=3000,
            wav_path=wav_path,
        )

        # Arbiter must have been called
        assert mock_arbiter.arbitrate.called, "arbiter.arbitrate must be called"

        # Check that audio_segments contained real file paths
        for lid, seg_path in captured_segments.items():
            assert seg_path, f"audio_segments[{lid}] must not be empty"
            assert seg_path.endswith(".wav"), f"Expected .wav path, got {seg_path}"

    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)


def test_pass3_cleans_up_temp_wav_after_execution():
    """Pass 3 temp WAV files must be deleted after arbiter completes.

    Uses force-assign scenario: short speaker (400ms < 500ms min_dur) with
    controlled cosine sim=0.45 (>= 0.40 relaxed, < 0.50 arbiter threshold).
    """
    from app.services.incremental_processor import IncrementalProcessor, IncrementalSessionState, SpeakerProfile

    created_temps = []

    def capture_arbitrate(pyannote_mapping, pyannote_confidences, audio_segments, global_profiles):
        for lid, path in audio_segments.items():
            assert Path(path).exists(), f"Temp WAV {path} must exist when arbiter runs"
            created_temps.append(path)
        return dict(pyannote_mapping)

    mock_arbiter = MagicMock(spec=SpeakerArbiter)
    mock_arbiter.confidence_threshold = 0.50
    mock_arbiter.arbitrate.side_effect = capture_arbitrate

    settings = MagicMock()
    settings.incremental_speaker_match_threshold = 0.60
    settings.incremental_speaker_match_threshold_relaxed = 0.40
    settings.incremental_min_speaker_duration_ms = 500

    proc = IncrementalProcessor(
        settings=settings,
        diarizer=MagicMock(),
        asr_backend=MagicMock(),
        checkpoint_analyzer=MagicMock(),
        arbiter=mock_arbiter,
    )

    wav_path = _make_test_wav(duration_s=3.0)

    try:
        emb_local, emb_global = _make_controlled_pair(cosine_sim=0.45)

        session = IncrementalSessionState(session_id="test-sess")
        profile = SpeakerProfile(
            speaker_id="spk_00", total_speech_ms=5000, first_seen_increment=0,
        )
        profile.embeddings.append(emb_global)
        profile.update_centroid()
        session.speaker_profiles["spk_00"] = profile

        # Short duration (400ms) → force-assign, but >= 300ms for slicing
        diarize_result = FakeDiarizeResult(
            segments=[FakeSegment("local_0", 0, 400)],
            embeddings={"local_0": emb_local.tolist()},
        )

        proc._match_speakers(
            diarize_result, session, 1, 0, 3000, wav_path,
        )

        assert len(created_temps) > 0, "Expected at least 1 temp WAV to be created"
        for tmp_path in created_temps:
            assert not Path(tmp_path).exists(), (
                f"Temp WAV {tmp_path} must be deleted after _match_speakers"
            )

    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)


def test_pass3_cleans_up_temp_wav_on_arbiter_error():
    """Pass 3 temp WAV files must be deleted even if arbiter raises.

    Same force-assign scenario as cleanup test, but arbiter explodes.
    """
    from app.services.incremental_processor import IncrementalProcessor, IncrementalSessionState, SpeakerProfile

    created_temps = []

    def exploding_arbitrate(pyannote_mapping, pyannote_confidences, audio_segments, global_profiles):
        for lid, path in audio_segments.items():
            created_temps.append(path)
        raise RuntimeError("Arbiter exploded!")

    mock_arbiter = MagicMock(spec=SpeakerArbiter)
    mock_arbiter.confidence_threshold = 0.50
    mock_arbiter.arbitrate.side_effect = exploding_arbitrate

    settings = MagicMock()
    settings.incremental_speaker_match_threshold = 0.60
    settings.incremental_speaker_match_threshold_relaxed = 0.40
    settings.incremental_min_speaker_duration_ms = 500

    proc = IncrementalProcessor(
        settings=settings,
        diarizer=MagicMock(),
        asr_backend=MagicMock(),
        checkpoint_analyzer=MagicMock(),
        arbiter=mock_arbiter,
    )

    wav_path = _make_test_wav(duration_s=3.0)

    try:
        emb_local, emb_global = _make_controlled_pair(cosine_sim=0.45)

        session = IncrementalSessionState(session_id="test-sess")
        profile = SpeakerProfile(
            speaker_id="spk_00", total_speech_ms=5000, first_seen_increment=0,
        )
        profile.embeddings.append(emb_global)
        profile.update_centroid()
        session.speaker_profiles["spk_00"] = profile

        # Short duration → force-assign with sim=0.45 < arbiter threshold 0.50
        diarize_result = FakeDiarizeResult(
            segments=[FakeSegment("local_0", 0, 400)],
            embeddings={"local_0": emb_local.tolist()},
        )

        # Should NOT raise — arbiter error is swallowed (best-effort)
        mapping = proc._match_speakers(
            diarize_result, session, 1, 0, 3000, wav_path,
        )

        # mapping should still be valid (Pass 1+2 result preserved)
        assert isinstance(mapping, dict)

        # All temp WAVs must be cleaned up despite error
        assert len(created_temps) > 0, "Expected at least 1 temp WAV"
        for tmp_path in created_temps:
            assert not Path(tmp_path).exists(), (
                f"Temp WAV {tmp_path} must be deleted even on arbiter error"
            )

    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)
