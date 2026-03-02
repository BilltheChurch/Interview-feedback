"""Comprehensive unit tests for IncrementalProcessor service.

Tests cover:
  - Cosine similarity calculation
  - Speaker matching (new and existing speakers)
  - Full process_increment flow (e2e with mocks)
  - Finalize with checkpoints
  - Stale session cleanup
  - Profile restore (recovery mode)
  - LLM analysis interval logic
  - Utterance deduplication across cumulative/chunk increments
"""

from __future__ import annotations

import base64
import time
import wave
import io
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from app.config import Settings
from app.schemas import (
    AnalysisReportResponse,
    CheckpointResponse,
    IncrementalFinalizeRequest,
    IncrementalProcessRequest,
    MergedUtteranceOut,
    OverallFeedback,
    PersonFeedbackItem,
    PersonSummary,
    DimensionFeedback,
    DimensionClaim,
    ReportQualityMeta,
    SpeakerProfileOut,
    SpeakerStat,
    WordTimestampOut,
)
from app.services.diarize_full import DiarizeResult, SpeakerSegment
from app.services.incremental_processor import (
    IncrementalProcessor,
    IncrementalSessionState,
    IncrementResult,
    SpeakerProfile,
)
from app.services.whisper_batch import TranscriptResult, Utterance as ASRUtterance, WordTimestamp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

EMB_DIM = 256


def make_embedding(seed: int) -> np.ndarray:
    """Create a deterministic unit-normalised 256-dim embedding."""
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(EMB_DIM).astype(np.float32)
    return v / np.linalg.norm(v)


def make_settings(**overrides) -> Settings:
    """Build a Settings object with test-friendly defaults.

    Uses model_construct to bypass env-file loading and validation.
    """
    defaults = dict(
        app_name="test-inference",
        app_host="127.0.0.1",
        app_port=8000,
        log_level="DEBUG",
        inference_api_key="",
        trust_proxy_headers=False,
        sv_model_id="iic/test",
        sv_model_revision="master",
        sv_t_low=0.60,
        sv_t_high=0.70,
        cluster_match_threshold=0.60,
        profile_auto_threshold=0.72,
        profile_confirm_threshold=0.60,
        profile_margin_threshold=0.08,
        enrollment_ready_seconds=12.0,
        enrollment_ready_samples=3,
        report_model_provider="dashscope",
        report_model_name="qwen-plus",
        dashscope_api_key="",
        report_timeout_ms=45000,
        audio_sr=16000,
        max_audio_seconds=30,
        max_audio_bytes=5 * 1024 * 1024,
        max_request_body_bytes=6 * 1024 * 1024,
        rate_limit_enabled=False,
        rate_limit_requests=60,
        rate_limit_window_seconds=60,
        enable_diarization=True,
        segmenter_backend="vad",
        modelscope_cache="~/.cache/modelscope",
        sv_device="cpu",
        sv_backend="modelscope",
        sv_onnx_model_path="~/.cache/campplus-onnx/campplus.onnx",
        vad_mode=2,
        vad_frame_ms=30,
        vad_min_speech_ms=300,
        vad_min_silence_ms=250,
        asr_backend="sensevoice",
        sensevoice_model_id="iic/SenseVoiceSmall",
        sensevoice_device="cpu",
        asr_onnx_model_path="~/.cache/sensevoice-onnx/model",
        whisper_model_size="large-v3",
        whisper_device="cpu",
        pyannote_model_id="pyannote/speaker-diarization-community-1",
        pyannote_embedding_model_id="pyannote/wespeaker-voxceleb-resnet34-LM",
        pyannote_device="cpu",
        hf_token="",
        incremental_interval_ms=180_000,
        incremental_overlap_ms=30_000,
        incremental_cumulative_threshold=2,
        incremental_analysis_interval=2,
        incremental_speaker_match_threshold=0.60,
        incremental_speaker_match_threshold_relaxed=0.40,
        incremental_min_speaker_duration_ms=15_000,
        incremental_finalize_merge_threshold=0.55,
        incremental_max_sessions=10,
    )
    defaults.update(overrides)
    return Settings.model_construct(**defaults)


def make_dummy_wav_b64(duration_frames: int = 16000) -> str:
    """Create a minimal silent WAV file encoded as base64."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * duration_frames)
    return base64.b64encode(buf.getvalue()).decode()


def make_diarize_result(
    speakers: list[str],
    embeddings: dict[str, list[float]] | None = None,
    segments: list[SpeakerSegment] | None = None,
    seg_duration_ms: int = 20_000,
) -> DiarizeResult:
    """Build a minimal DiarizeResult for the given speaker IDs.

    seg_duration_ms defaults to 20s — above the 15s min-duration threshold
    so tests create new global speakers by default.
    """
    if segments is None:
        seg_list = []
        for i, spk in enumerate(speakers):
            seg_list.append(
                SpeakerSegment(
                    id=f"seg_{i:03d}",
                    speaker_id=spk,
                    start_ms=i * seg_duration_ms,
                    end_ms=(i + 1) * seg_duration_ms,
                    confidence=1.0,
                )
            )
    else:
        seg_list = segments

    if embeddings is None:
        embeddings = {spk: make_embedding(idx).tolist() for idx, spk in enumerate(speakers)}

    total_ms = len(speakers) * seg_duration_ms if segments is None else (segments[-1].end_ms if segments else 0)
    return DiarizeResult(
        segments=seg_list,
        embeddings=embeddings,
        num_speakers=len(speakers),
        duration_ms=total_ms,
        processing_time_ms=100,
    )


def make_asr_result(
    utterances: list[tuple[str, str, int, int]],
) -> TranscriptResult:
    """Build a minimal TranscriptResult.

    utterances: list of (id, text, start_ms, end_ms)
    """
    utt_list = [
        ASRUtterance(
            id=uid,
            text=text,
            start_ms=start,
            end_ms=end,
            words=[WordTimestamp(word=w, start_ms=start, end_ms=end, confidence=1.0) for w in text.split()],
            language="en",
            confidence=0.95,
        )
        for uid, text, start, end in utterances
    ]
    return TranscriptResult(
        utterances=utt_list,
        language="en",
        duration_ms=utt_list[-1].end_ms if utt_list else 0,
        processing_time_ms=50,
        backend="faster-whisper",
        model_size="large-v3",
    )


def make_checkpoint_response(session_id: str, idx: int) -> CheckpointResponse:
    return CheckpointResponse(
        session_id=session_id,
        checkpoint_index=idx,
        timestamp_ms=idx * 60_000,
        summary=f"Checkpoint {idx} summary",
        per_speaker_notes=[],
        dimension_signals=[],
    )


def make_analysis_report(session_id: str) -> AnalysisReportResponse:
    """Build a minimal AnalysisReportResponse."""
    from datetime import datetime, timezone
    return AnalysisReportResponse(
        session_id=session_id,
        overall=OverallFeedback(narrative="Test narrative"),
        per_person=[
            PersonFeedbackItem(
                person_key="spk_00",
                display_name="Speaker 0",
                dimensions=[
                    DimensionFeedback(
                        dimension="leadership",
                        label_zh="领导力",
                        score=7.0,
                        score_rationale="Good",
                        strengths=[
                            DimensionClaim(
                                claim_id="c_01",
                                text="Strong leadership.",
                                evidence_refs=[],
                                confidence=0.8,
                            )
                        ],
                        risks=[],
                        actions=[],
                    )
                ],
                summary=PersonSummary(strengths=["Good"], risks=[], actions=[]),
            )
        ],
        quality=ReportQualityMeta(
            generated_at=datetime.now(timezone.utc).isoformat(),
            build_ms=500,
            claim_count=1,
        ),
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def mock_diarizer() -> MagicMock:
    return MagicMock()


@pytest.fixture
def mock_asr() -> MagicMock:
    return MagicMock()


@pytest.fixture
def mock_checkpoint_analyzer() -> MagicMock:
    return MagicMock()


@pytest.fixture
def processor(settings, mock_diarizer, mock_asr, mock_checkpoint_analyzer) -> IncrementalProcessor:
    return IncrementalProcessor(
        settings=settings,
        diarizer=mock_diarizer,
        asr_backend=mock_asr,
        checkpoint_analyzer=mock_checkpoint_analyzer,
    )


# ---------------------------------------------------------------------------
# 1. test_cosine_similarity
# ---------------------------------------------------------------------------


class TestCosineSimilarity:
    def test_identical_vectors_return_one(self):
        v = make_embedding(0)
        sim = IncrementalProcessor._cosine_similarity(v, v)
        assert abs(sim - 1.0) < 1e-5, f"Expected ~1.0, got {sim}"

    def test_identical_non_unit_vectors_return_one(self):
        v = np.array([3.0, 4.0], dtype=np.float32)
        sim = IncrementalProcessor._cosine_similarity(v, v)
        assert abs(sim - 1.0) < 1e-5

    def test_orthogonal_vectors_return_zero(self):
        a = np.array([1.0, 0.0], dtype=np.float32)
        b = np.array([0.0, 1.0], dtype=np.float32)
        sim = IncrementalProcessor._cosine_similarity(a, b)
        assert abs(sim - 0.0) < 1e-5

    def test_zero_vector_returns_zero(self):
        zero = np.zeros(EMB_DIM, dtype=np.float32)
        other = make_embedding(0)
        assert IncrementalProcessor._cosine_similarity(zero, other) == 0.0
        assert IncrementalProcessor._cosine_similarity(other, zero) == 0.0
        assert IncrementalProcessor._cosine_similarity(zero, zero) == 0.0

    def test_opposite_vectors_return_minus_one(self):
        v = make_embedding(42)
        neg_v = -v
        sim = IncrementalProcessor._cosine_similarity(v, neg_v)
        assert sim < -0.99


# ---------------------------------------------------------------------------
# 2. test_speaker_matching_new_speakers
# ---------------------------------------------------------------------------


class TestSpeakerMatchingNewSpeakers:
    def test_two_new_speakers_created(self, processor):
        """When session has no profiles, both speakers become new globals."""
        session = IncrementalSessionState(session_id="test-new")
        diarize_result = make_diarize_result(["A", "B"])

        mapping = processor._match_speakers(diarize_result, session, 0, 0, 10_000)

        assert len(session.speaker_profiles) == 2
        global_ids = set(mapping.values())
        assert "spk_00" in global_ids
        assert "spk_01" in global_ids
        assert mapping["A"] in {"spk_00", "spk_01"}
        assert mapping["B"] in {"spk_00", "spk_01"}
        assert mapping["A"] != mapping["B"]

    def test_single_new_speaker(self, processor):
        """Single speaker with no prior session → spk_00 created."""
        session = IncrementalSessionState(session_id="test-single")
        diarize_result = make_diarize_result(["SPEAKER_00"])

        mapping = processor._match_speakers(diarize_result, session, 0, 0, 5_000)

        assert len(session.speaker_profiles) == 1
        assert mapping["SPEAKER_00"] == "spk_00"

    def test_new_speaker_centroid_populated(self, processor):
        """New speakers have a valid (non-zero) centroid stored."""
        session = IncrementalSessionState(session_id="test-centroid")
        emb = make_embedding(7)
        diarize_result = make_diarize_result(["X"], embeddings={"X": emb.tolist()})

        processor._match_speakers(diarize_result, session, 0, 0, 5_000)

        profile = session.speaker_profiles["spk_00"]
        assert profile.centroid.size == EMB_DIM
        np.testing.assert_allclose(profile.centroid, emb, atol=1e-5)

    def test_speaker_without_embedding_becomes_new(self, processor):
        """Local speaker with empty embedding still maps to a new global speaker."""
        session = IncrementalSessionState(session_id="test-no-emb")
        diarize_result = make_diarize_result(["LONELY"], embeddings={"LONELY": []})

        mapping = processor._match_speakers(diarize_result, session, 0, 0, 5_000)

        assert "LONELY" in mapping
        assert len(session.speaker_profiles) == 1


# ---------------------------------------------------------------------------
# 3. test_speaker_matching_existing
# ---------------------------------------------------------------------------


class TestSpeakerMatchingExisting:
    def _add_profile(self, session: IncrementalSessionState, spk_id: str, emb: np.ndarray):
        profile = SpeakerProfile(
            speaker_id=spk_id,
            embeddings=[emb],
            centroid=emb.copy(),
            total_speech_ms=5000,
            first_seen_increment=0,
        )
        session.speaker_profiles[spk_id] = profile

    def test_similar_embedding_matches_existing(self, processor):
        """An embedding very close to an existing centroid → matched."""
        session = IncrementalSessionState(session_id="test-match")
        base_emb = make_embedding(10)
        self._add_profile(session, "spk_00", base_emb)

        # Slightly perturbed version of the same embedding — still above 0.60 threshold
        noise = np.random.default_rng(99).standard_normal(EMB_DIM).astype(np.float32) * 0.05
        similar_emb = base_emb + noise
        similar_emb /= np.linalg.norm(similar_emb)

        diarize_result = make_diarize_result(["LOCAL_A"], embeddings={"LOCAL_A": similar_emb.tolist()})
        mapping = processor._match_speakers(diarize_result, session, 1, 5000, 10_000)

        assert mapping["LOCAL_A"] == "spk_00"
        # No new global speaker created
        assert len(session.speaker_profiles) == 1

    def test_different_embedding_creates_new_speaker(self, processor):
        """An embedding orthogonal to the existing centroid → new global speaker."""
        session = IncrementalSessionState(session_id="test-new-from-diff")
        base_emb = make_embedding(10)
        self._add_profile(session, "spk_00", base_emb)

        # Build an embedding nearly orthogonal to base_emb
        orth = np.random.default_rng(1234).standard_normal(EMB_DIM).astype(np.float32)
        orth -= np.dot(orth, base_emb) * base_emb  # Gram-Schmidt orthogonalise
        orth /= np.linalg.norm(orth)

        diarize_result = make_diarize_result(["LOCAL_B"], embeddings={"LOCAL_B": orth.tolist()})
        mapping = processor._match_speakers(diarize_result, session, 1, 5000, 10_000)

        assert mapping["LOCAL_B"] != "spk_00"
        assert len(session.speaker_profiles) == 2

    def test_greedy_matching_long_speakers_different_globals(self, processor):
        """Two long local speakers similar to same global → one matched, one creates new."""
        session = IncrementalSessionState(session_id="test-greedy")
        base_emb = make_embedding(5)
        self._add_profile(session, "spk_00", base_emb)

        # Both locals are similar to spk_00 — only one can win in Pass 1
        emb_a = base_emb + np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.03
        emb_a /= np.linalg.norm(emb_a)
        emb_b = base_emb + np.random.default_rng(2).standard_normal(EMB_DIM).astype(np.float32) * 0.03
        emb_b /= np.linalg.norm(emb_b)

        segments = [
            SpeakerSegment("seg_0", "A", 0, 25_000),    # A: 25s, matched first (longest)
            SpeakerSegment("seg_1", "B", 25_000, 50_000),  # B: 25s, above min-duration → new speaker
        ]
        diarize_result = DiarizeResult(
            segments=segments,
            embeddings={"A": emb_a.tolist(), "B": emb_b.tolist()},
            num_speakers=2,
            duration_ms=50_000,
            processing_time_ms=100,
        )

        mapping = processor._match_speakers(diarize_result, session, 1, 0, 50_000)

        # A wins spk_00 in Pass 1; B is long enough to create new in Pass 2
        assert mapping["A"] != mapping["B"]

    def test_short_speaker_force_assigned_to_best_global(self, processor):
        """A short local speaker (<15s) is force-assigned instead of creating new global."""
        session = IncrementalSessionState(session_id="test-force-assign")
        base_emb = make_embedding(5)
        self._add_profile(session, "spk_00", base_emb)

        emb_a = base_emb + np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.03
        emb_a /= np.linalg.norm(emb_a)
        emb_b = base_emb + np.random.default_rng(2).standard_normal(EMB_DIM).astype(np.float32) * 0.03
        emb_b /= np.linalg.norm(emb_b)

        segments = [
            SpeakerSegment("seg_0", "A", 0, 25_000),    # A: 25s, wins spk_00
            SpeakerSegment("seg_1", "B", 25_000, 30_000),  # B: 5s, below min-duration
        ]
        diarize_result = DiarizeResult(
            segments=segments,
            embeddings={"A": emb_a.tolist(), "B": emb_b.tolist()},
            num_speakers=2,
            duration_ms=30_000,
            processing_time_ms=100,
        )

        mapping = processor._match_speakers(diarize_result, session, 1, 0, 30_000)

        # B is too short → force-assigned to best global (spk_00), no new profile
        assert mapping["A"] == "spk_00"
        assert mapping["B"] == "spk_00"
        assert len(session.speaker_profiles) == 1  # no new speakers created

    def test_phantom_speaker_absorbed_not_created(self, processor):
        """A short speaker with low similarity is absorbed (not new global)."""
        session = IncrementalSessionState(session_id="test-phantom")
        emb_a = make_embedding(60)
        emb_b = make_embedding(61)
        self._add_profile(session, "spk_00", emb_a)
        self._add_profile(session, "spk_01", emb_b)

        # Phantom: nearly random embedding, low sim to everyone
        phantom_emb = make_embedding(999)
        # Verify it's dissimilar
        sim_a = float(np.dot(phantom_emb, emb_a))
        sim_b = float(np.dot(phantom_emb, emb_b))
        assert sim_a < 0.40 and sim_b < 0.40, f"Expected low sims, got {sim_a:.3f}, {sim_b:.3f}"

        # 2 real speakers (long) + 1 phantom (short, 5s)
        segments = [
            SpeakerSegment("seg_0", "REAL_A", 0, 25_000),
            SpeakerSegment("seg_1", "REAL_B", 25_000, 50_000),
            SpeakerSegment("seg_2", "PHANTOM", 50_000, 55_000),  # 5s < 15s min
        ]
        close_a = emb_a + np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        close_a /= np.linalg.norm(close_a)
        close_b = emb_b + np.random.default_rng(2).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        close_b /= np.linalg.norm(close_b)

        diarize_result = DiarizeResult(
            segments=segments,
            embeddings={
                "REAL_A": close_a.tolist(),
                "REAL_B": close_b.tolist(),
                "PHANTOM": phantom_emb.tolist(),
            },
            num_speakers=3,
            duration_ms=55_000,
            processing_time_ms=100,
        )

        mapping = processor._match_speakers(diarize_result, session, 2, 0, 55_000)

        # Real speakers matched
        assert mapping["REAL_A"] == "spk_00"
        assert mapping["REAL_B"] == "spk_01"
        # Phantom absorbed into existing (not new) — still only 2 globals
        assert "PHANTOM" in mapping
        assert len(session.speaker_profiles) == 2

    def test_relaxed_pass2_matches_drifted_embedding(self, processor):
        """Pass 2 relaxed threshold (0.40) catches embeddings that drift below 0.60.

        DRIFTED has enough speech (>15s) but no unclaimed global above strict
        threshold. Pass 2 finds spk_00 unclaimed with sim in (0.40, 0.60).
        """
        session = IncrementalSessionState(session_id="test-relaxed")
        base_emb = make_embedding(30)
        other_emb = make_embedding(31)
        self._add_profile(session, "spk_00", base_emb)
        self._add_profile(session, "spk_01", other_emb)

        # Create an embedding with sim ~0.50 to spk_00 (below 0.60 but above 0.40)
        noise = np.random.default_rng(42).standard_normal(EMB_DIM).astype(np.float32) * 0.12
        drifted = base_emb + noise
        drifted /= np.linalg.norm(drifted)

        sim = float(np.dot(drifted, base_emb) / (np.linalg.norm(drifted) * np.linalg.norm(base_emb)))
        assert 0.40 < sim < 0.60, f"Expected sim in (0.40, 0.60), got {sim:.3f}"

        # GOOD_MATCH claims spk_01 in Pass 1; DRIFTED goes to Pass 2
        close_to_01 = other_emb + np.random.default_rng(99).standard_normal(EMB_DIM).astype(np.float32) * 0.03
        close_to_01 /= np.linalg.norm(close_to_01)

        segments = [
            SpeakerSegment("seg_0", "GOOD_MATCH", 0, 25_000),   # 25s > 15s min
            SpeakerSegment("seg_1", "DRIFTED", 25_000, 50_000),  # 25s > 15s min
        ]
        diarize_result = DiarizeResult(
            segments=segments,
            embeddings={"GOOD_MATCH": close_to_01.tolist(), "DRIFTED": drifted.tolist()},
            num_speakers=2,
            duration_ms=50_000,
            processing_time_ms=100,
        )

        mapping = processor._match_speakers(diarize_result, session, 2, 0, 50_000)

        # GOOD_MATCH → spk_01 in Pass 1; DRIFTED → spk_00 in Pass 2 (relaxed, unclaimed)
        assert mapping["GOOD_MATCH"] == "spk_01"
        assert mapping["DRIFTED"] == "spk_00"
        assert len(session.speaker_profiles) == 2

    def test_relaxed_match_does_not_update_centroid(self, processor):
        """Pass 2 relaxed match does NOT update the global speaker's centroid.

        Single local speaker with drifted embedding. In Pass 1 it fails strict
        threshold; in Pass 2 spk_00 is unclaimed and sim > 0.40 → relaxed match.
        """
        session = IncrementalSessionState(session_id="test-no-centroid-update")
        base_emb = make_embedding(40)
        self._add_profile(session, "spk_00", base_emb)
        original_centroid = session.speaker_profiles["spk_00"].centroid.copy()

        # Drifted embedding — above 0.40 but below 0.60
        noise = np.random.default_rng(55).standard_normal(EMB_DIM).astype(np.float32) * 0.12
        drifted = base_emb + noise
        drifted /= np.linalg.norm(drifted)

        sim = float(np.dot(drifted, base_emb) / (np.linalg.norm(drifted) * np.linalg.norm(base_emb)))
        assert 0.40 < sim < 0.60, f"Expected sim in (0.40, 0.60), got {sim:.3f}"

        # Use segments long enough to be above min-duration
        diarize_result = make_diarize_result(
            ["DRIFTED"], embeddings={"DRIFTED": drifted.tolist()}, seg_duration_ms=20_000,
        )
        processor._match_speakers(diarize_result, session, 1, 0, 20_000)

        # Centroid should NOT have changed (relaxed match skips centroid update)
        np.testing.assert_array_equal(
            session.speaker_profiles["spk_00"].centroid, original_centroid
        )

    def test_existing_centroid_updated_after_match(self, processor):
        """Matching updates the existing profile's centroid with the new embedding."""
        session = IncrementalSessionState(session_id="test-centroid-update")
        base_emb = make_embedding(20)
        self._add_profile(session, "spk_00", base_emb)

        similar_emb = base_emb + np.random.default_rng(77).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        similar_emb /= np.linalg.norm(similar_emb)

        diarize_result = make_diarize_result(["LOC"], embeddings={"LOC": similar_emb.tolist()})
        processor._match_speakers(diarize_result, session, 1, 0, 5000)

        profile = session.speaker_profiles["spk_00"]
        assert len(profile.embeddings) == 2  # original + new


# ---------------------------------------------------------------------------
# 4. test_process_increment_e2e
# ---------------------------------------------------------------------------


class TestProcessIncrementE2E:
    def _make_request(
        self, session_id: str = "e2e-session", index: int = 0,
        duration_frames: int = 160_000,  # 10s at 16kHz
        audio_start_ms: int = 0,
        audio_end_ms: int = 10_000,
    ) -> IncrementalProcessRequest:
        return IncrementalProcessRequest(
            session_id=session_id,
            increment_index=index,
            audio_b64=make_dummy_wav_b64(duration_frames),
            audio_format="wav",
            audio_start_ms=audio_start_ms,
            audio_end_ms=audio_end_ms,
            num_speakers=2,
            run_analysis=True,
            language="en",
            locale="zh-CN",
        )

    def test_e2e_returns_correct_utterances_and_speakers(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """Full process_increment: mocked diarize + per-segment ASR → correct response.

        With the segment-driven ASR architecture, each diarization segment is
        transcribed individually. ASR is called once per segment, and the
        resulting text + diarization timestamps form each utterance.

        Segments must be >= 15s to exceed the min-duration filter so both
        speakers create global profiles.
        """
        emb_a = make_embedding(1)
        emb_b = make_embedding(2)
        diarize_result = DiarizeResult(
            segments=[
                SpeakerSegment("seg_0", "SPEAKER_00", 0, 20_000),
                SpeakerSegment("seg_1", "SPEAKER_01", 20_000, 40_000),
            ],
            embeddings={
                "SPEAKER_00": emb_a.tolist(),
                "SPEAKER_01": emb_b.tolist(),
            },
            num_speakers=2,
            duration_ms=40_000,
            processing_time_ms=200,
        )
        # Each segment calls transcribe() independently; use side_effect
        asr_result_a = make_asr_result([("u_0", "Hello from speaker A", 0, 20_000)])
        asr_result_b = make_asr_result([("u_0", "Hello from speaker B", 0, 20_000)])
        checkpoint = make_checkpoint_response("e2e-session", 0)

        mock_diarizer.diarize.return_value = diarize_result
        mock_asr.transcribe.side_effect = [asr_result_a, asr_result_b]
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = checkpoint

        req = self._make_request("e2e-session", 0, duration_frames=640_000, audio_end_ms=40_000)
        resp = processor.process_increment(req)

        assert resp.session_id == "e2e-session"
        assert resp.increment_index == 0
        # 2 diarization segments → 2 utterances (one per segment)
        assert len(resp.utterances) == 2
        assert resp.speakers_detected == 2
        assert resp.checkpoint is not None

        # Verify per-segment text
        assert resp.utterances[0].text == "Hello from speaker A"
        assert resp.utterances[1].text == "Hello from speaker B"

        # Each utterance must have a global speaker ID
        speaker_ids = {u.speaker for u in resp.utterances}
        assert speaker_ids.issubset({"spk_00", "spk_01"})

        # Timestamps are segment-level (from diarization), not ASR-internal
        assert resp.utterances[0].start_ms == 0
        assert resp.utterances[0].end_ms == 20_000
        assert resp.utterances[1].start_ms == 20_000
        assert resp.utterances[1].end_ms == 40_000

        # Speaker profiles must be returned
        assert len(resp.speaker_profiles) == 2
        profile_ids = {p.speaker_id for p in resp.speaker_profiles}
        assert "spk_00" in profile_ids
        assert "spk_01" in profile_ids

    def test_e2e_absolute_timestamps_offset_correctly(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """audio_start_ms is added to diarization segment timestamps.

        With segment-driven ASR, timestamps come from the diarization segments
        (not from ASR), and are offset by audio_start_ms to produce absolute
        session-level timestamps.
        """
        emb = make_embedding(3)
        # Segment 0-20000ms (default seg_duration_ms=20s, above 15s min-duration)
        diarize_result = make_diarize_result(["SPK"], embeddings={"SPK": emb.tolist()})
        asr_result = make_asr_result([("u_0", "Test text", 0, 20_000)])

        mock_diarizer.diarize.return_value = diarize_result
        mock_asr.transcribe.return_value = asr_result
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = None

        req = IncrementalProcessRequest(
            session_id="offset-test",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(320_000),  # 20s at 16kHz
            audio_format="wav",
            audio_start_ms=60_000,
            audio_end_ms=80_000,
            run_analysis=False,
            language="en",
            locale="zh-CN",
        )
        resp = processor.process_increment(req)

        utt = resp.utterances[0]
        # Timestamps = diarization segment times + audio_start_ms
        # Segment is 0-20000ms, audio_start_ms=60000 → 60000-80000
        assert utt.start_ms == 0 + 60_000
        assert utt.end_ms == 20_000 + 60_000

    def test_e2e_no_analysis_when_run_analysis_false(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """Checkpoint analysis is skipped when run_analysis=False."""
        mock_diarizer.diarize.return_value = make_diarize_result(["SPK"])
        mock_asr.transcribe.return_value = make_asr_result([("u_0", "text", 0, 5000)])

        req = IncrementalProcessRequest(
            session_id="no-analysis",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(80_000),  # 5s at 16kHz
            audio_format="wav",
            audio_start_ms=0,
            audio_end_ms=5_000,
            run_analysis=False,
            language="en",
            locale="zh-CN",
        )
        resp = processor.process_increment(req)

        mock_checkpoint_analyzer.analyze_checkpoint.assert_not_called()
        assert resp.checkpoint is None

    def test_e2e_session_state_persists_across_calls(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """Second call to process_increment for same session retains speaker profiles."""
        emb_a = make_embedding(10)
        emb_b = make_embedding(11)

        # First call — 2 speakers (segments at 0-5s and 5-10s)
        mock_diarizer.diarize.return_value = make_diarize_result(
            ["A", "B"], embeddings={"A": emb_a.tolist(), "B": emb_b.tolist()}
        )
        mock_asr.transcribe.return_value = make_asr_result([("u_0", "hello", 0, 5000)])
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = None

        req1 = IncrementalProcessRequest(
            session_id="persist-test",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(160_000),  # 10s at 16kHz
            audio_format="wav",
            audio_start_ms=0,
            audio_end_ms=10_000,
            run_analysis=False,
            language="en",
            locale="zh-CN",
        )
        processor.process_increment(req1)

        # Second call — same session, same speakers (similar embeddings)
        noise_a = emb_a + np.random.default_rng(99).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        noise_a /= np.linalg.norm(noise_a)
        noise_b = emb_b + np.random.default_rng(88).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        noise_b /= np.linalg.norm(noise_b)

        mock_diarizer.diarize.return_value = make_diarize_result(
            ["A", "B"], embeddings={"A": noise_a.tolist(), "B": noise_b.tolist()}
        )
        mock_asr.transcribe.return_value = make_asr_result([("u_1", "world", 0, 5000)])

        req2 = IncrementalProcessRequest(
            session_id="persist-test",
            increment_index=1,
            audio_b64=make_dummy_wav_b64(160_000),  # 10s at 16kHz
            audio_format="wav",
            audio_start_ms=10_000,
            audio_end_ms=20_000,
            run_analysis=False,
            language="en",
            locale="zh-CN",
        )
        resp2 = processor.process_increment(req2)

        # Should still only have 2 speaker profiles (no new ones created)
        assert resp2.speakers_detected == 2


# ---------------------------------------------------------------------------
# 5. test_finalize_with_checkpoints
# ---------------------------------------------------------------------------


class TestFinalizeWithCheckpoints:
    def _build_session_with_increments(
        self,
        processor: IncrementalProcessor,
        session_id: str,
        num_increments: int = 2,
    ) -> IncrementalSessionState:
        """Manually inject increment results + checkpoints into a session."""
        session = processor._get_or_create_session(session_id)

        for i in range(num_increments):
            utterances = [
                MergedUtteranceOut(
                    id=f"u_{i}_{j}",
                    speaker="spk_00",
                    text=f"Increment {i} utterance {j}",
                    start_ms=i * 60_000 + j * 5000,
                    end_ms=i * 60_000 + j * 5000 + 4000,
                )
                for j in range(3)
            ]
            result = IncrementResult(
                increment_index=i,
                utterances=utterances,
                speaker_mapping={"A": "spk_00"},
                checkpoint=make_checkpoint_response(session_id, i),
                diarization_time_ms=100,
                transcription_time_ms=50,
                audio_start_ms=i * 60_000,
                audio_end_ms=(i + 1) * 60_000,
            )
            session.increment_results.append(result)
            session.checkpoints.append(result.checkpoint)  # type: ignore[arg-type]

        return session

    def test_finalize_returns_report_and_utterances(
        self, processor, mock_checkpoint_analyzer
    ):
        """Finalize merges checkpoints and returns a full report."""
        session_id = "finalize-test"
        self._build_session_with_increments(processor, session_id, num_increments=2)

        report = make_analysis_report(session_id)
        mock_checkpoint_analyzer.merge_checkpoints.return_value = report

        req = IncrementalFinalizeRequest(
            session_id=session_id,
            locale="zh-CN",
        )
        resp = processor.finalize(req)

        assert resp.session_id == session_id
        assert resp.report is not None
        assert resp.report.session_id == session_id
        assert len(resp.transcript) > 0
        mock_checkpoint_analyzer.merge_checkpoints.assert_called_once()

    def test_finalize_collects_correct_total_audio_ms(
        self, processor, mock_checkpoint_analyzer
    ):
        """total_audio_ms should equal the max audio_end_ms across increments."""
        session_id = "finalize-audio-ms"
        self._build_session_with_increments(processor, session_id, num_increments=2)

        mock_checkpoint_analyzer.merge_checkpoints.return_value = make_analysis_report(session_id)

        req = IncrementalFinalizeRequest(session_id=session_id, locale="zh-CN")
        resp = processor.finalize(req)

        assert resp.total_audio_ms == 2 * 60_000  # Two increments of 60s each

    def test_finalize_no_checkpoints_returns_none_report(self, processor):
        """Finalize with no checkpoints returns report=None (no LLM call)."""
        session_id = "finalize-no-checkpoints"
        session = processor._get_or_create_session(session_id)
        session.increment_results.append(
            IncrementResult(
                increment_index=0,
                utterances=[
                    MergedUtteranceOut(id="u_0", speaker="spk_00", text="Hello", start_ms=0, end_ms=1000)
                ],
                speaker_mapping={},
                checkpoint=None,
                audio_start_ms=0,
                audio_end_ms=60_000,
            )
        )

        req = IncrementalFinalizeRequest(session_id=session_id, locale="zh-CN")
        resp = processor.finalize(req)

        assert resp.report is None

    def test_finalize_cleans_up_session(self, processor, mock_checkpoint_analyzer):
        """After finalize, the session is removed from memory."""
        session_id = "finalize-cleanup"
        self._build_session_with_increments(processor, session_id, num_increments=1)
        mock_checkpoint_analyzer.merge_checkpoints.return_value = make_analysis_report(session_id)

        req = IncrementalFinalizeRequest(session_id=session_id, locale="zh-CN")
        processor.finalize(req)

        assert session_id not in processor._sessions

    def test_finalize_unknown_session_returns_empty_response(self, processor):
        """Finalize called for unknown session returns sensible empty response."""
        req = IncrementalFinalizeRequest(session_id="ghost-session", locale="zh-CN")
        resp = processor.finalize(req)

        assert resp.session_id == "ghost-session"
        assert resp.total_increments == 0
        assert resp.transcript == []
        assert resp.report is None


# ---------------------------------------------------------------------------
# 5b. test_finalize_speaker_merging
# ---------------------------------------------------------------------------


class TestFinalizeSpeakerMerging:
    """Tests for finalize-time global speaker profile merging."""

    def _make_session_with_profiles(
        self,
        processor: IncrementalProcessor,
        profiles: dict[str, tuple[np.ndarray, int]],
        utterances_per_profile: int = 3,
    ) -> IncrementalSessionState:
        """Create a session with speaker profiles and utterances referencing them.

        profiles: {global_id: (centroid_embedding, total_speech_ms)}
        """
        session = processor._get_or_create_session("merge-test")
        for gid, (emb, speech_ms) in profiles.items():
            session.speaker_profiles[gid] = SpeakerProfile(
                speaker_id=gid,
                embeddings=[emb],
                centroid=emb.copy(),
                total_speech_ms=speech_ms,
                first_seen_increment=0,
            )

        # Add increment results with utterances referencing these profiles
        all_utts = []
        for i, gid in enumerate(profiles):
            for j in range(utterances_per_profile):
                all_utts.append(MergedUtteranceOut(
                    id=f"u_{i}_{j}",
                    speaker=gid,
                    text=f"Text from {gid} utt {j}",
                    start_ms=i * 60_000 + j * 5000,
                    end_ms=i * 60_000 + j * 5000 + 4000,
                ))

        session.increment_results.append(IncrementResult(
            increment_index=0,
            utterances=all_utts,
            speaker_mapping={f"local_{gid}": gid for gid in profiles},
            audio_start_ms=0,
            audio_end_ms=180_000,
        ))
        return session

    def test_similar_profiles_merged(self, processor):
        """Two profiles with centroid sim > 0.55 are merged into one."""
        base = make_embedding(100)
        # Create a similar embedding (small perturbation → sim ~0.95+)
        noise = np.random.default_rng(42).standard_normal(EMB_DIM).astype(np.float32) * 0.03
        similar = base + noise
        similar /= np.linalg.norm(similar)

        # Verify they are above threshold
        sim = float(np.dot(base, similar) / (np.linalg.norm(base) * np.linalg.norm(similar)))
        assert sim > 0.55, f"Expected sim > 0.55, got {sim:.3f}"

        session = self._make_session_with_profiles(processor, {
            "spk_00": (base, 60_000),
            "spk_01": (similar, 30_000),  # Less speech → absorbed
        })

        merge_map = processor._merge_similar_profiles(session)

        assert "spk_01" in merge_map
        assert merge_map["spk_01"] == "spk_00"  # spk_00 has more speech → survivor
        assert len(session.speaker_profiles) == 1
        assert "spk_00" in session.speaker_profiles
        assert "spk_01" not in session.speaker_profiles

        # Verify utterances were remapped
        for utt in session.increment_results[0].utterances:
            assert utt.speaker == "spk_00", f"Utterance {utt.id} still has speaker {utt.speaker}"

    def test_dissimilar_profiles_not_merged(self, processor):
        """Two profiles with sim < 0.55 remain separate."""
        emb_a = make_embedding(200)
        emb_b = make_embedding(201)  # Different seed → likely orthogonal

        sim = float(np.dot(emb_a, emb_b) / (np.linalg.norm(emb_a) * np.linalg.norm(emb_b)))
        assert sim < 0.55, f"Expected sim < 0.55, got {sim:.3f}"

        session = self._make_session_with_profiles(processor, {
            "spk_00": (emb_a, 50_000),
            "spk_01": (emb_b, 40_000),
        })

        merge_map = processor._merge_similar_profiles(session)

        assert len(merge_map) == 0
        assert len(session.speaker_profiles) == 2

    def test_merge_keeps_profile_with_more_speech(self, processor):
        """The profile with more total_speech_ms survives."""
        base = make_embedding(300)
        noise = np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        similar = base + noise
        similar /= np.linalg.norm(similar)

        session = self._make_session_with_profiles(processor, {
            "spk_00": (base, 20_000),       # Less speech
            "spk_01": (similar, 80_000),     # More speech → survivor
        })

        merge_map = processor._merge_similar_profiles(session)

        assert "spk_00" in merge_map
        assert merge_map["spk_00"] == "spk_01"
        assert "spk_01" in session.speaker_profiles
        assert "spk_00" not in session.speaker_profiles

    def test_transitive_merge_resolved(self, processor):
        """If A→B and B→C, A should resolve to C."""
        # Create 3 similar profiles in a chain
        base = make_embedding(400)
        noise1 = np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        noise2 = np.random.default_rng(2).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        emb_b = base + noise1
        emb_b /= np.linalg.norm(emb_b)
        emb_c = base + noise2
        emb_c /= np.linalg.norm(emb_c)

        session = self._make_session_with_profiles(processor, {
            "spk_00": (base, 10_000),
            "spk_01": (emb_b, 15_000),
            "spk_02": (emb_c, 50_000),  # Most speech → final survivor
        })

        merge_map = processor._merge_similar_profiles(session)

        # All absorbed profiles should ultimately point to the survivor
        remaining = set(session.speaker_profiles.keys())
        assert len(remaining) == 1
        survivor = remaining.pop()
        # Every absorbed ID in merge_map should resolve to the survivor
        for absorbed_id, target in merge_map.items():
            assert target == survivor, f"{absorbed_id}→{target}, expected {survivor}"

    def test_no_merge_when_single_profile(self, processor):
        """No crash or merge when session has only 1 profile."""
        emb = make_embedding(500)
        session = self._make_session_with_profiles(processor, {
            "spk_00": (emb, 30_000),
        })

        merge_map = processor._merge_similar_profiles(session)
        assert len(merge_map) == 0
        assert len(session.speaker_profiles) == 1

    def test_no_merge_when_no_profiles(self, processor):
        """No crash when session has no profiles."""
        session = processor._get_or_create_session("empty-merge")
        merge_map = processor._merge_similar_profiles(session)
        assert len(merge_map) == 0

    def test_merged_profile_has_combined_embeddings(self, processor):
        """Survivor profile gets all embeddings from absorbed profile."""
        base = make_embedding(600)
        noise = np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        similar = base + noise
        similar /= np.linalg.norm(similar)

        session = self._make_session_with_profiles(processor, {
            "spk_00": (base, 60_000),
            "spk_01": (similar, 30_000),
        })

        # Give spk_01 an extra embedding
        session.speaker_profiles["spk_01"].embeddings.append(similar * 0.99)

        processor._merge_similar_profiles(session)

        survivor = session.speaker_profiles["spk_00"]
        # spk_00 had 1 emb + spk_01 had 2 embs = 3 total
        assert len(survivor.embeddings) == 3
        assert survivor.total_speech_ms == 90_000  # 60k + 30k

    def test_merge_updates_speaker_mapping(self, processor):
        """speaker_mapping in increment results is updated after merge."""
        base = make_embedding(700)
        noise = np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        similar = base + noise
        similar /= np.linalg.norm(similar)

        session = self._make_session_with_profiles(processor, {
            "spk_00": (base, 60_000),
            "spk_01": (similar, 30_000),
        })

        processor._merge_similar_profiles(session)

        # All speaker_mapping values should now point to spk_00
        for result in session.increment_results:
            for local_id, global_id in result.speaker_mapping.items():
                assert global_id == "spk_00", f"{local_id}→{global_id}, expected spk_00"

    def test_finalize_merges_before_collecting_utterances(
        self, processor, mock_checkpoint_analyzer
    ):
        """Full finalize flow: similar profiles are merged and utterances are correct."""
        base = make_embedding(800)
        noise = np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.02
        similar = base + noise
        similar /= np.linalg.norm(similar)

        session = processor._get_or_create_session("finalize-merge-e2e")

        # Add 2 similar profiles
        session.speaker_profiles["spk_00"] = SpeakerProfile(
            speaker_id="spk_00",
            embeddings=[base],
            centroid=base.copy(),
            total_speech_ms=60_000,
            first_seen_increment=0,
        )
        session.speaker_profiles["spk_01"] = SpeakerProfile(
            speaker_id="spk_01",
            embeddings=[similar],
            centroid=similar.copy(),
            total_speech_ms=30_000,
            first_seen_increment=5,
        )

        # Add increment results with utterances from both speakers
        session.increment_results.append(IncrementResult(
            increment_index=0,
            utterances=[
                MergedUtteranceOut(id="u_0", speaker="spk_00", text="Hello", start_ms=0, end_ms=5000),
                MergedUtteranceOut(id="u_1", speaker="spk_01", text="World", start_ms=5000, end_ms=10000),
            ],
            speaker_mapping={"A": "spk_00", "B": "spk_01"},
            audio_start_ms=0,
            audio_end_ms=60_000,
        ))
        session.checkpoints.append(make_checkpoint_response("finalize-merge-e2e", 0))
        mock_checkpoint_analyzer.merge_checkpoints.return_value = make_analysis_report("finalize-merge-e2e")

        req = IncrementalFinalizeRequest(session_id="finalize-merge-e2e", locale="zh-CN")
        resp = processor.finalize(req)

        # After merge, all utterances should reference spk_00
        for utt in resp.transcript:
            assert utt.speaker == "spk_00", f"Utterance {utt.id} has speaker {utt.speaker}"

        # Speaker stats should only have 1 speaker
        assert len(resp.speaker_stats) == 1


# ---------------------------------------------------------------------------
# 6. test_cleanup_stale_sessions
# ---------------------------------------------------------------------------


class TestCleanupStaleSessions:
    def test_stale_session_removed(self, processor):
        """Session with last_activity > max_age_s is removed."""
        processor._get_or_create_session("fresh-session")
        processor._get_or_create_session("stale-session")

        # Make one session look old by back-dating last_activity
        stale = processor._sessions["stale-session"]
        stale.last_activity = time.monotonic() - 200  # 200s ago

        removed = processor.cleanup_stale_sessions(max_age_s=100)

        assert removed == 1
        assert "stale-session" not in processor._sessions
        assert "fresh-session" in processor._sessions

    def test_fresh_sessions_not_removed(self, processor):
        """Sessions younger than max_age_s are preserved."""
        processor._get_or_create_session("a")
        processor._get_or_create_session("b")

        removed = processor.cleanup_stale_sessions(max_age_s=3600)

        assert removed == 0
        assert len(processor._sessions) == 2

    def test_all_stale_sessions_removed(self, processor):
        """All sessions can be removed if all are stale."""
        for sid in ["x", "y", "z"]:
            processor._get_or_create_session(sid)
            processor._sessions[sid].last_activity = time.monotonic() - 10_000

        removed = processor.cleanup_stale_sessions(max_age_s=100)

        assert removed == 3
        assert len(processor._sessions) == 0

    def test_cleanup_returns_count(self, processor):
        """Return value equals number of sessions removed."""
        for sid in ["p", "q"]:
            processor._get_or_create_session(sid)
            processor._sessions[sid].last_activity = time.monotonic() - 500

        result = processor.cleanup_stale_sessions(max_age_s=100)
        assert result == 2


# ---------------------------------------------------------------------------
# 7. test_restore_profiles
# ---------------------------------------------------------------------------


class TestRestoreProfiles:
    def test_profiles_restored_from_request(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """previous_speaker_profiles in the request are loaded into session."""
        centroid = make_embedding(99).tolist()
        prev_profiles = [
            SpeakerProfileOut(
                speaker_id="spk_00",
                centroid=centroid,
                total_speech_ms=30_000,
                first_seen_increment=0,
                display_name="Alice",
            )
        ]

        mock_diarizer.diarize.return_value = make_diarize_result(["S"])
        mock_asr.transcribe.return_value = make_asr_result([("u_0", "hello", 0, 5000)])
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = None

        req = IncrementalProcessRequest(
            session_id="restore-test",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(80_000),  # 5s at 16kHz
            audio_format="wav",
            audio_start_ms=0,
            audio_end_ms=5_000,
            run_analysis=False,
            language="en",
            locale="zh-CN",
            previous_speaker_profiles=prev_profiles,
        )
        processor.process_increment(req)

        session = processor._sessions["restore-test"]
        # spk_00 was restored + potentially a new one from the new local speaker
        assert "spk_00" in session.speaker_profiles
        restored = session.speaker_profiles["spk_00"]
        np.testing.assert_allclose(restored.centroid, np.array(centroid, dtype=np.float32), atol=1e-5)
        assert restored.total_speech_ms == 30_000
        assert restored.display_name == "Alice"

    def test_profiles_not_restored_if_session_exists(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """If session already has profiles, previous_speaker_profiles are ignored."""
        # Pre-create session with a profile
        session = processor._get_or_create_session("no-restore")
        existing_emb = make_embedding(50)
        session.speaker_profiles["spk_00"] = SpeakerProfile(
            speaker_id="spk_00",
            embeddings=[existing_emb],
            centroid=existing_emb.copy(),
            total_speech_ms=1000,
        )

        previous_profiles = [
            SpeakerProfileOut(
                speaker_id="spk_99",
                centroid=make_embedding(1).tolist(),
                total_speech_ms=999,
                first_seen_increment=0,
            )
        ]

        mock_diarizer.diarize.return_value = make_diarize_result(["T"])
        mock_asr.transcribe.return_value = make_asr_result([("u_0", "text", 0, 5000)])
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = None

        req = IncrementalProcessRequest(
            session_id="no-restore",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(80_000),  # 5s at 16kHz
            audio_format="wav",
            audio_start_ms=0,
            audio_end_ms=5_000,
            run_analysis=False,
            language="en",
            locale="zh-CN",
            previous_speaker_profiles=previous_profiles,
        )
        processor.process_increment(req)

        # spk_99 from previous_speaker_profiles should NOT be present
        assert "spk_99" not in processor._sessions["no-restore"].speaker_profiles

    def test_restore_profiles_with_empty_centroid(self, processor):
        """Profiles with empty centroid are restored with zero-size centroid."""
        session = processor._get_or_create_session("empty-centroid")
        profiles = [
            SpeakerProfileOut(
                speaker_id="spk_00",
                centroid=[],
                total_speech_ms=0,
                first_seen_increment=0,
            )
        ]
        processor._restore_profiles(session, profiles)

        profile = session.speaker_profiles["spk_00"]
        assert profile.centroid.size == 0


# ---------------------------------------------------------------------------
# 8. test_should_run_analysis
# ---------------------------------------------------------------------------


class TestShouldRunAnalysis:
    """LLM checkpoint analysis scheduling with interval=2."""

    def test_interval_2_index_0_runs(self, processor):
        # Always run on the first increment (index 0)
        assert processor._should_run_analysis(0) is True

    def test_interval_2_index_1_runs(self, processor):
        # (1 + 1) % 2 == 0 → True
        assert processor._should_run_analysis(1) is True

    def test_interval_2_index_2_does_not_run(self, processor):
        # (2 + 1) % 2 == 1 ≠ 0 and not index 0 → False
        assert processor._should_run_analysis(2) is False

    def test_interval_2_index_3_runs(self, processor):
        # (3 + 1) % 2 == 0 → True
        assert processor._should_run_analysis(3) is True

    def test_interval_2_index_4_does_not_run(self, processor):
        assert processor._should_run_analysis(4) is False

    def test_interval_2_index_5_runs(self, processor):
        assert processor._should_run_analysis(5) is True

    def test_interval_3_custom(self):
        """With interval=3, analysis runs at index 0, 2, 5, 8, ..."""
        settings = make_settings(incremental_analysis_interval=3)
        proc = IncrementalProcessor(settings, MagicMock(), MagicMock(), MagicMock())
        assert proc._should_run_analysis(0) is True   # always
        assert proc._should_run_analysis(1) is False  # (1+1)%3=2
        assert proc._should_run_analysis(2) is True   # (2+1)%3=0
        assert proc._should_run_analysis(3) is False  # (3+1)%3=1
        assert proc._should_run_analysis(5) is True   # (5+1)%3=0


# ---------------------------------------------------------------------------
# 9. test_collect_all_utterances_dedup
# ---------------------------------------------------------------------------


class TestCollectAllUtterancesDedup:
    """Utterance deduplication logic for cumulative vs chunk increments."""

    def _make_utterances(self, prefix: str, start_offset_ms: int, count: int) -> list[MergedUtteranceOut]:
        return [
            MergedUtteranceOut(
                id=f"{prefix}_u_{i}",
                speaker="spk_00",
                text=f"Text {prefix} {i}",
                start_ms=start_offset_ms + i * 5000,
                end_ms=start_offset_ms + i * 5000 + 4000,
            )
            for i in range(count)
        ]

    def test_cumulative_takes_last_increment(self, processor):
        """With 2 cumulative increments, only the last is used as the base."""
        settings = make_settings(
            incremental_cumulative_threshold=2,  # first 2 increments are cumulative
            incremental_overlap_ms=0,
        )
        proc = IncrementalProcessor(settings, MagicMock(), MagicMock(), MagicMock())
        session = proc._get_or_create_session("dedup-cumulative")

        # Increment 0 (cumulative): 0..60s
        session.increment_results.append(IncrementResult(
            increment_index=0,
            utterances=self._make_utterances("inc0", 0, 3),
            speaker_mapping={},
            audio_start_ms=0,
            audio_end_ms=60_000,
        ))
        # Increment 1 (cumulative): 0..120s — should replace increment 0
        session.increment_results.append(IncrementResult(
            increment_index=1,
            utterances=self._make_utterances("inc1", 0, 6),
            speaker_mapping={},
            audio_start_ms=0,
            audio_end_ms=120_000,
        ))

        all_utts = proc._collect_all_utterances(session)

        # Should use increment 1's utterances (the last cumulative one)
        assert len(all_utts) == 6
        assert all(u.id.startswith("inc1") for u in all_utts)

    def test_chunk_mode_appends_after_overlap(self, processor):
        """Chunk-mode increments skip utterances in the overlap region."""
        settings = make_settings(
            incremental_cumulative_threshold=1,  # first 1 increment is cumulative
            incremental_overlap_ms=30_000,       # 30s overlap
        )
        proc = IncrementalProcessor(settings, MagicMock(), MagicMock(), MagicMock())
        session = proc._get_or_create_session("dedup-chunk")

        # Increment 0 (cumulative): 0..60s
        session.increment_results.append(IncrementResult(
            increment_index=0,
            utterances=self._make_utterances("inc0", 0, 4),  # 0-20s
            speaker_mapping={},
            audio_start_ms=0,
            audio_end_ms=60_000,
        ))

        # Increment 1 (chunk): 30s..90s — overlap region is 30s..60s
        # Utterances starting before 60s (30+30) should be skipped
        chunk_utts = [
            MergedUtteranceOut(id="chunk_overlap", speaker="spk_00", text="In overlap",
                               start_ms=45_000, end_ms=50_000),
            MergedUtteranceOut(id="chunk_new_0", speaker="spk_00", text="After overlap 1",
                               start_ms=62_000, end_ms=67_000),
            MergedUtteranceOut(id="chunk_new_1", speaker="spk_00", text="After overlap 2",
                               start_ms=70_000, end_ms=75_000),
        ]
        session.increment_results.append(IncrementResult(
            increment_index=1,
            utterances=chunk_utts,
            speaker_mapping={},
            audio_start_ms=30_000,  # chunk starts at 30s
            audio_end_ms=90_000,
        ))

        all_utts = proc._collect_all_utterances(session)

        # Overlap utterance (start 45s < cutoff 60s) must be excluded
        utt_ids = [u.id for u in all_utts]
        assert "chunk_overlap" not in utt_ids
        assert "chunk_new_0" in utt_ids
        assert "chunk_new_1" in utt_ids

    def test_empty_session_returns_empty_list(self, processor):
        """No increments → empty utterance list."""
        session = IncrementalSessionState(session_id="empty")
        result = processor._collect_all_utterances(session)
        assert result == []

    def test_utterances_sorted_by_start_ms(self, processor):
        """Collected utterances are sorted in chronological order."""
        settings = make_settings(
            incremental_cumulative_threshold=1,
            incremental_overlap_ms=0,
        )
        proc = IncrementalProcessor(settings, MagicMock(), MagicMock(), MagicMock())
        session = proc._get_or_create_session("sort-test")

        # Cumulative increment with utterances in order
        session.increment_results.append(IncrementResult(
            increment_index=0,
            utterances=[
                MergedUtteranceOut(id="u_a", speaker="spk_00", text="A", start_ms=10_000, end_ms=12_000),
                MergedUtteranceOut(id="u_b", speaker="spk_00", text="B", start_ms=0, end_ms=2_000),
            ],
            speaker_mapping={},
            audio_start_ms=0,
            audio_end_ms=60_000,
        ))
        # Chunk increment after the cumulative one
        session.increment_results.append(IncrementResult(
            increment_index=1,
            utterances=[
                MergedUtteranceOut(id="u_c", speaker="spk_00", text="C", start_ms=65_000, end_ms=67_000),
            ],
            speaker_mapping={},
            audio_start_ms=60_000,
            audio_end_ms=120_000,
        ))

        all_utts = proc._collect_all_utterances(session)
        starts = [u.start_ms for u in all_utts]
        assert starts == sorted(starts)


# ---------------------------------------------------------------------------
# 12. test_clean_asr_text — Layer 1 non-target language filtering
# ---------------------------------------------------------------------------


class TestCleanAsrText:
    """Tests for _clean_asr_text static method (Layer 1 post-ASR filter)."""

    def test_pure_japanese_replaced_with_filler(self):
        """Pure Japanese/kana output from Moonshine → [filler]."""
        cases = ["カレで。", "うん。", "あた？", "ばんは。", "あん。"]
        for text in cases:
            result = IncrementalProcessor._clean_asr_text(text, "en")
            assert result == "[filler]", f"Expected [filler] for '{text}', got '{result}'"

    def test_mixed_cjk_high_ratio_replaced(self):
        """Mostly CJK with minor English → [filler]."""
        # "嗯ん a" → CJK=2, alpha=1, ratio=0.67 > 0.5
        result = IncrementalProcessor._clean_asr_text("嗯ん a", "en")
        assert result == "[filler]"

    def test_normal_english_unchanged(self):
        """Standard English text passes through unchanged."""
        text = "Hello, my name is Tina and I usually go by Tina."
        result = IncrementalProcessor._clean_asr_text(text, "en")
        assert result == text

    def test_chinese_target_language_no_filter(self):
        """When target language is Chinese, CJK text is NOT filtered."""
        text = "大家好，我叫张三"
        result = IncrementalProcessor._clean_asr_text(text, "zh")
        assert result == text

    def test_empty_text_unchanged(self):
        """Empty string returns empty string."""
        assert IncrementalProcessor._clean_asr_text("", "en") == ""

    def test_english_with_minor_cjk_preserved(self):
        """English text with minor CJK (≤50%) is preserved."""
        text = "And said bug。"  # 1 CJK char vs ~10 alpha chars
        result = IncrementalProcessor._clean_asr_text(text, "en")
        assert result == text

    def test_auto_language_also_filters(self):
        """Target language 'auto' also filters CJK artefacts."""
        result = IncrementalProcessor._clean_asr_text("うん。", "auto")
        assert result == "[filler]"


# ---------------------------------------------------------------------------
# 13. test_polish_transcript — Layer 2 LLM correction + name extraction
# ---------------------------------------------------------------------------


def _make_utterance(uid: str, speaker: str, text: str, start_ms: int = 0) -> MergedUtteranceOut:
    """Helper to create a test utterance."""
    return MergedUtteranceOut(
        id=uid,
        speaker=speaker,
        text=text,
        start_ms=start_ms,
        end_ms=start_ms + 2000,
        words=[],
        language="en",
        confidence=0.9,
    )


class TestPolishTranscript:
    """Tests for _polish_transcript (Layer 2 LLM + regex)."""

    def _make_processor(self) -> IncrementalProcessor:
        """Create a processor with a mock LLM."""
        mock_analyzer = MagicMock()
        mock_analyzer.llm = MagicMock()
        settings = Settings(
            dashscope_api_key="test-key",
            dashscope_model_name="qwen-flash",
            dashscope_timeout_ms=30000,
        )
        return IncrementalProcessor(settings, MagicMock(), MagicMock(), mock_analyzer)

    def test_llm_corrections_applied(self):
        """LLM corrections are applied to matching utterance IDs."""
        proc = self._make_processor()
        utts = [
            _make_utterance("u_0001", "spk_00", "hellello world"),
            _make_utterance("u_0002", "spk_01", "this is fine"),
        ]
        session = IncrementalSessionState(
            session_id="test",
            speaker_profiles={"spk_00": SpeakerProfile("spk_00"), "spk_01": SpeakerProfile("spk_01")},
        )
        proc._llm.generate_json.return_value = {
            "corrections": [{"id": "u_0001", "text": "hello world"}],
            "speaker_names": {},
        }

        result_utts, name_map = proc._polish_transcript(utts, session, "en-US")

        assert result_utts[0].text == "hello world"
        assert result_utts[1].text == "this is fine"  # unchanged

    def test_llm_extracts_names(self):
        """LLM speaker_names are returned in name_map."""
        proc = self._make_processor()
        utts = [_make_utterance("u_0001", "spk_03", "Any I usually go back Tina")]
        session = IncrementalSessionState(
            session_id="test",
            speaker_profiles={"spk_03": SpeakerProfile("spk_03")},
        )
        proc._llm.generate_json.return_value = {
            "corrections": [{"id": "u_0001", "text": "Hi, I usually go by Tina"}],
            "speaker_names": {"spk_03": "Tina"},
        }

        _, name_map = proc._polish_transcript(utts, session, "en-US")

        # regex also matches "go by Tina" in corrected text, but both say "Tina"
        assert name_map["spk_03"] == "Tina"

    def test_llm_failure_falls_back_to_regex(self):
        """When LLM fails, regex name extraction still works."""
        proc = self._make_processor()
        utts = [_make_utterance("u_0001", "spk_01", "my name is Alice")]
        session = IncrementalSessionState(
            session_id="test",
            speaker_profiles={"spk_01": SpeakerProfile("spk_01")},
        )
        proc._llm.generate_json.side_effect = Exception("LLM timeout")

        result_utts, name_map = proc._polish_transcript(utts, session, "en-US")

        # Text unchanged (LLM failed)
        assert result_utts[0].text == "my name is Alice"
        # But regex still extracted the name
        assert name_map["spk_01"] == "Alice"

    def test_regex_overrides_llm_names(self):
        """Regex name extraction overrides LLM names (regex is more reliable)."""
        proc = self._make_processor()
        utts = [_make_utterance("u_0001", "spk_02", "my name is Bob")]
        session = IncrementalSessionState(
            session_id="test",
            speaker_profiles={"spk_02": SpeakerProfile("spk_02")},
        )
        proc._llm.generate_json.return_value = {
            "corrections": [],
            "speaker_names": {"spk_02": "Robert"},  # LLM says "Robert"
        }

        _, name_map = proc._polish_transcript(utts, session, "en-US")

        # regex extracts "Bob" from "my name is Bob" — overrides LLM "Robert"
        assert name_map["spk_02"] == "Bob"

    def test_empty_utterances_returns_empty(self):
        """Empty utterance list returns immediately."""
        proc = self._make_processor()
        session = IncrementalSessionState(session_id="test")

        result_utts, name_map = proc._polish_transcript([], session, "en-US")

        assert result_utts == []
        assert name_map == {}
        proc._llm.generate_json.assert_not_called()


# ---------------------------------------------------------------------------
# 14. test_name_flow_to_report — Name integration into finalize
# ---------------------------------------------------------------------------


class TestNameFlowToReport:
    """Test that extracted names flow into speaker_stats via finalize."""

    def test_finalize_sets_display_name_from_polish(self):
        """After finalize, speaker_stats should contain extracted names."""
        mock_analyzer = MagicMock()
        mock_analyzer.llm = MagicMock()
        mock_analyzer.merge_checkpoints.return_value = None
        settings = Settings(
            dashscope_api_key="test-key",
            dashscope_model_name="qwen-flash",
            dashscope_timeout_ms=30000,
            incremental_cumulative_threshold=1,
        )
        proc = IncrementalProcessor(settings, MagicMock(), MagicMock(), mock_analyzer)

        # Set up session with one increment containing a self-introduction
        session = proc._get_or_create_session("name-test")
        session.speaker_profiles["spk_00"] = SpeakerProfile(
            speaker_id="spk_00", total_speech_ms=10000,
        )
        session.increment_results.append(IncrementResult(
            increment_index=0,
            utterances=[
                _make_utterance("u_0001", "spk_00", "my name is Charlie"),
            ],
            speaker_mapping={"SPEAKER_00": "spk_00"},
            audio_start_ms=0,
            audio_end_ms=60_000,
        ))
        session.checkpoints = []

        # LLM returns empty (no corrections), name will come from regex
        mock_analyzer.llm.generate_json.return_value = {
            "corrections": [],
            "speaker_names": {},
        }

        req = IncrementalFinalizeRequest(
            session_id="name-test",
            locale="en-US",
        )
        resp = proc.finalize(req)

        # Check that speaker name was extracted and placed in stats
        assert len(resp.speaker_stats) == 1
        assert resp.speaker_stats[0].speaker_name == "Charlie"

    def test_finalize_name_in_merge_request(self):
        """The extracted name should appear in the merge_checkpoints request."""
        mock_analyzer = MagicMock()
        mock_analyzer.llm = MagicMock()
        settings = Settings(
            dashscope_api_key="test-key",
            dashscope_model_name="qwen-flash",
            dashscope_timeout_ms=30000,
            incremental_cumulative_threshold=1,
        )
        proc = IncrementalProcessor(settings, MagicMock(), MagicMock(), mock_analyzer)

        session = proc._get_or_create_session("merge-name-test")
        session.speaker_profiles["spk_01"] = SpeakerProfile(
            speaker_id="spk_01", total_speech_ms=15000,
        )
        session.increment_results.append(IncrementResult(
            increment_index=0,
            utterances=[
                _make_utterance("u_0001", "spk_01", "please call me Diana"),
            ],
            speaker_mapping={"SPEAKER_00": "spk_01"},
            audio_start_ms=0,
            audio_end_ms=60_000,
        ))
        session.checkpoints = [CheckpointResponse(
            session_id="merge-name-test",
            checkpoint_index=0,
            timestamp_ms=0,
            summary="Test checkpoint",
            per_speaker_notes=[],
            dimension_signals=[],
        )]

        mock_analyzer.llm.generate_json.return_value = {
            "corrections": [],
            "speaker_names": {},
        }
        # merge_checkpoints will be called — capture the request via side_effect
        captured_merge_req = {}

        def capture_merge(req):
            captured_merge_req["req"] = req
            return None  # Return None to skip report generation

        mock_analyzer.merge_checkpoints.side_effect = capture_merge

        req = IncrementalFinalizeRequest(
            session_id="merge-name-test",
            locale="en-US",
        )
        proc.finalize(req)

        # Verify merge_checkpoints was called with stats containing the name
        merge_req = captured_merge_req["req"]
        stats = merge_req.final_stats
        assert any(s.speaker_name == "Diana" for s in stats)
