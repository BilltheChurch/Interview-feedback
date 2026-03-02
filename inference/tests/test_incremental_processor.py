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
) -> DiarizeResult:
    """Build a minimal DiarizeResult for the given speaker IDs."""
    if segments is None:
        seg_list = []
        for i, spk in enumerate(speakers):
            seg_list.append(
                SpeakerSegment(
                    id=f"seg_{i:03d}",
                    speaker_id=spk,
                    start_ms=i * 5000,
                    end_ms=(i + 1) * 5000,
                    confidence=1.0,
                )
            )
    else:
        seg_list = segments

    if embeddings is None:
        embeddings = {spk: make_embedding(idx).tolist() for idx, spk in enumerate(speakers)}

    return DiarizeResult(
        segments=seg_list,
        embeddings=embeddings,
        num_speakers=len(speakers),
        duration_ms=len(speakers) * 5000,
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

    def test_greedy_matching_one_global_per_local(self, processor):
        """Two local speakers cannot both claim the same global speaker."""
        session = IncrementalSessionState(session_id="test-greedy")
        base_emb = make_embedding(5)
        self._add_profile(session, "spk_00", base_emb)

        # Both locals are similar to spk_00 — only one can win
        emb_a = base_emb + np.random.default_rng(1).standard_normal(EMB_DIM).astype(np.float32) * 0.03
        emb_a /= np.linalg.norm(emb_a)
        emb_b = base_emb + np.random.default_rng(2).standard_normal(EMB_DIM).astype(np.float32) * 0.03
        emb_b /= np.linalg.norm(emb_b)

        segments = [
            SpeakerSegment("seg_0", "A", 0, 8000),   # A speaks longer → matched first
            SpeakerSegment("seg_1", "B", 8000, 10000),
        ]
        diarize_result = DiarizeResult(
            segments=segments,
            embeddings={"A": emb_a.tolist(), "B": emb_b.tolist()},
            num_speakers=2,
            duration_ms=10000,
            processing_time_ms=100,
        )

        mapping = processor._match_speakers(diarize_result, session, 1, 0, 10_000)

        # The two mapped-to globals must be different
        assert mapping["A"] != mapping["B"]

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
    def _make_request(self, session_id: str = "e2e-session", index: int = 0) -> IncrementalProcessRequest:
        return IncrementalProcessRequest(
            session_id=session_id,
            increment_index=index,
            audio_b64=make_dummy_wav_b64(),
            audio_format="wav",
            audio_start_ms=0,
            audio_end_ms=10_000,
            num_speakers=2,
            run_analysis=True,
            language="en",
            locale="zh-CN",
        )

    def test_e2e_returns_correct_utterances_and_speakers(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """Full process_increment: mocked diarize + ASR + checkpoint → correct response."""
        emb_a = make_embedding(1)
        emb_b = make_embedding(2)
        diarize_result = DiarizeResult(
            segments=[
                SpeakerSegment("seg_0", "SPEAKER_00", 0, 4000),
                SpeakerSegment("seg_1", "SPEAKER_01", 5000, 9000),
            ],
            embeddings={
                "SPEAKER_00": emb_a.tolist(),
                "SPEAKER_01": emb_b.tolist(),
            },
            num_speakers=2,
            duration_ms=10_000,
            processing_time_ms=200,
        )
        asr_result = make_asr_result([
            ("u_0", "Hello from speaker A", 500, 3500),
            ("u_1", "Hello from speaker B", 5500, 8500),
            ("u_2", "Final words from B", 8600, 9000),
        ])
        checkpoint = make_checkpoint_response("e2e-session", 0)

        mock_diarizer.diarize.return_value = diarize_result
        mock_asr.transcribe.return_value = asr_result
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = checkpoint

        req = self._make_request("e2e-session", 0)
        resp = processor.process_increment(req)

        assert resp.session_id == "e2e-session"
        assert resp.increment_index == 0
        assert len(resp.utterances) == 3
        assert resp.speakers_detected == 2
        assert resp.checkpoint is not None

        # Each utterance must have a global speaker ID
        speaker_ids = {u.speaker for u in resp.utterances}
        assert speaker_ids.issubset({"spk_00", "spk_01"})

        # Speaker profiles must be returned
        assert len(resp.speaker_profiles) == 2
        profile_ids = {p.speaker_id for p in resp.speaker_profiles}
        assert "spk_00" in profile_ids
        assert "spk_01" in profile_ids

    def test_e2e_absolute_timestamps_offset_correctly(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """audio_start_ms is added to utterance timestamps."""
        emb = make_embedding(3)
        diarize_result = make_diarize_result(["SPK"], embeddings={"SPK": emb.tolist()})
        asr_result = make_asr_result([("u_0", "Test text", 1000, 2000)])

        mock_diarizer.diarize.return_value = diarize_result
        mock_asr.transcribe.return_value = asr_result
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = None

        req = IncrementalProcessRequest(
            session_id="offset-test",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(),
            audio_format="wav",
            audio_start_ms=60_000,
            audio_end_ms=70_000,
            run_analysis=False,
            language="en",
            locale="zh-CN",
        )
        resp = processor.process_increment(req)

        utt = resp.utterances[0]
        assert utt.start_ms == 1000 + 60_000
        assert utt.end_ms == 2000 + 60_000

    def test_e2e_no_analysis_when_run_analysis_false(
        self, processor, mock_diarizer, mock_asr, mock_checkpoint_analyzer
    ):
        """Checkpoint analysis is skipped when run_analysis=False."""
        mock_diarizer.diarize.return_value = make_diarize_result(["SPK"])
        mock_asr.transcribe.return_value = make_asr_result([("u_0", "text", 0, 1000)])

        req = IncrementalProcessRequest(
            session_id="no-analysis",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(),
            audio_format="wav",
            audio_start_ms=0,
            audio_end_ms=10_000,
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

        # First call — 2 speakers
        mock_diarizer.diarize.return_value = make_diarize_result(
            ["A", "B"], embeddings={"A": emb_a.tolist(), "B": emb_b.tolist()}
        )
        mock_asr.transcribe.return_value = make_asr_result([("u_0", "hello", 0, 1000)])
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = None

        req1 = IncrementalProcessRequest(
            session_id="persist-test",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(),
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
        mock_asr.transcribe.return_value = make_asr_result([("u_1", "world", 10000, 11000)])

        req2 = IncrementalProcessRequest(
            session_id="persist-test",
            increment_index=1,
            audio_b64=make_dummy_wav_b64(),
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
        mock_asr.transcribe.return_value = make_asr_result([("u_0", "hello", 0, 1000)])
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = None

        req = IncrementalProcessRequest(
            session_id="restore-test",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(),
            audio_format="wav",
            audio_start_ms=0,
            audio_end_ms=10_000,
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
        mock_asr.transcribe.return_value = make_asr_result([("u_0", "text", 0, 1000)])
        mock_checkpoint_analyzer.analyze_checkpoint.return_value = None

        req = IncrementalProcessRequest(
            session_id="no-restore",
            increment_index=0,
            audio_b64=make_dummy_wav_b64(),
            audio_format="wav",
            audio_start_ms=0,
            audio_end_ms=10_000,
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
