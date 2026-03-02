"""Incremental audio processing service.

Processes audio in 3-minute increments during recording, maintaining
global speaker profiles across increments. On finalization, merges all
checkpoints into a final report in ~18 seconds instead of 2-3 minutes.

Architecture:
  - First N increments use CUMULATIVE mode (audio from 0..end) to build
    a stable speaker map.
  - Subsequent increments use CHUNK mode with 30s overlap for continuity.
  - Speaker matching: cosine similarity > 0.6 against global centroids.
  - LLM checkpoint analysis runs every 2nd increment to control cost.

Dependencies (injected via constructor):
  - PyannoteFullDiarizer — speaker diarization
  - ASRBackend — speech recognition (LanguageAwareASRRouter)
  - CheckpointAnalyzer — LLM-based checkpoint analysis + merge
"""

from __future__ import annotations

import base64
import logging
import tempfile
import threading
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.config import Settings
from app.schemas import (
    CheckpointRequest,
    CheckpointResponse,
    EvidenceRef,
    IncrementalFinalizeRequest,
    IncrementalFinalizeResponse,
    IncrementalProcessRequest,
    IncrementalProcessResponse,
    MergeCheckpointsRequest,
    MergedUtteranceOut,
    Memo,
    SpeakerProfileOut,
    SpeakerStat,
    TranscriptUtterance,
    WordTimestampOut,
)
from app.services.checkpoint_analyzer import CheckpointAnalyzer
from app.services.diarize_full import DiarizeResult, PyannoteFullDiarizer, SpeakerSegment
from app.services.whisper_batch import TranscriptResult, Utterance as ASRUtterance

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Internal data structures
# ---------------------------------------------------------------------------


@dataclass
class SpeakerProfile:
    """Global speaker profile maintained across increments."""
    speaker_id: str
    embeddings: list[np.ndarray] = field(default_factory=list)
    centroid: np.ndarray = field(default_factory=lambda: np.zeros(0))
    total_speech_ms: int = 0
    first_seen_increment: int = 0
    display_name: str | None = None

    def update_centroid(self) -> None:
        """Recompute centroid as mean of all embeddings."""
        if self.embeddings:
            self.centroid = np.mean(self.embeddings, axis=0)

    def to_schema(self) -> SpeakerProfileOut:
        return SpeakerProfileOut(
            speaker_id=self.speaker_id,
            centroid=self.centroid.tolist() if self.centroid.size > 0 else [],
            total_speech_ms=self.total_speech_ms,
            first_seen_increment=self.first_seen_increment,
            display_name=self.display_name,
        )


@dataclass
class IncrementResult:
    """Result of processing a single increment."""
    increment_index: int
    utterances: list[MergedUtteranceOut]
    speaker_mapping: dict[str, str]  # local_id → global_id
    checkpoint: CheckpointResponse | None = None
    diarization_time_ms: int = 0
    transcription_time_ms: int = 0
    audio_start_ms: int = 0
    audio_end_ms: int = 0


@dataclass
class IncrementalSessionState:
    """Per-session state maintained in memory across increments."""
    session_id: str
    speaker_profiles: dict[str, SpeakerProfile] = field(default_factory=dict)
    increment_results: list[IncrementResult] = field(default_factory=list)
    checkpoints: list[CheckpointResponse] = field(default_factory=list)
    stable_speaker_map: bool = False
    created_at: float = field(default_factory=time.monotonic)
    last_activity: float = field(default_factory=time.monotonic)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class IncrementalProcessor:
    """Orchestrates incremental audio processing during recording.

    Usage::

        processor = IncrementalProcessor(settings, diarizer, asr, checkpoint_analyzer)
        resp = processor.process_increment(request)
        # ... after recording ends ...
        final = processor.finalize(request)
    """

    def __init__(
        self,
        settings: Settings,
        diarizer: PyannoteFullDiarizer,
        asr_backend,  # ASRBackend (duck-typed)
        checkpoint_analyzer: CheckpointAnalyzer,
    ) -> None:
        self._settings = settings
        self._diarizer = diarizer
        self._asr = asr_backend
        self._checkpoint_analyzer = checkpoint_analyzer
        self._sessions: dict[str, IncrementalSessionState] = {}
        self._lock = threading.Lock()

    # ── Public API ─────────────────────────────────────────────────────────

    def process_increment(self, req: IncrementalProcessRequest) -> IncrementalProcessResponse:
        """Process a single audio increment.

        1. Decode audio → temp WAV
        2. Parallel: pyannote diarize + ASR transcribe
        3. Match local speakers to global profiles
        4. Merge ASR + diarization → utterances with speaker labels
        5. Optionally run LLM checkpoint analysis
        6. Update session state, return result
        """
        t0 = time.monotonic()
        session = self._get_or_create_session(req.session_id)

        # Restore speaker profiles from request if session is fresh
        if not session.speaker_profiles and req.previous_speaker_profiles:
            self._restore_profiles(session, req.previous_speaker_profiles)

        # Decode audio to temp WAV file
        wav_path = self._decode_audio(req.audio_b64, req.audio_format)

        try:
            # Run diarization and ASR in parallel (both are CPU/GPU bound)
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                diarize_future = pool.submit(
                    self._diarizer.diarize, wav_path, num_speakers=req.num_speakers
                )
                asr_future = pool.submit(
                    self._asr.transcribe, wav_path, language=req.language
                )

                diarize_result: DiarizeResult = diarize_future.result()
                asr_result: TranscriptResult = asr_future.result()

            diarization_time_ms = diarize_result.processing_time_ms
            transcription_time_ms = asr_result.processing_time_ms

            # Match speakers: local diarization labels → global profiles
            speaker_mapping = self._match_speakers(
                diarize_result, session, req.increment_index, req.audio_start_ms, req.audio_end_ms
            )

            # Merge ASR + diarization into speaker-labeled utterances
            utterances = self._merge_transcript_diarization(
                asr_result, diarize_result, speaker_mapping, req.audio_start_ms
            )

            # Check speaker map stability
            if req.increment_index >= self._settings.incremental_cumulative_threshold:
                session.stable_speaker_map = True

            # Conditionally run LLM checkpoint analysis
            checkpoint: CheckpointResponse | None = None
            if req.run_analysis and self._should_run_analysis(req.increment_index):
                checkpoint = self._run_checkpoint_analysis(
                    session, req, utterances
                )
                if checkpoint:
                    session.checkpoints.append(checkpoint)

            # Store increment result
            result = IncrementResult(
                increment_index=req.increment_index,
                utterances=utterances,
                speaker_mapping=speaker_mapping,
                checkpoint=checkpoint,
                diarization_time_ms=diarization_time_ms,
                transcription_time_ms=transcription_time_ms,
                audio_start_ms=req.audio_start_ms,
                audio_end_ms=req.audio_end_ms,
            )
            session.increment_results.append(result)
            session.last_activity = time.monotonic()

            total_ms = int((time.monotonic() - t0) * 1000)
            logger.info(
                "Increment %d for session %s: %d utterances, %d speakers, %dms total "
                "(diarize=%dms, asr=%dms)",
                req.increment_index, req.session_id, len(utterances),
                len(session.speaker_profiles), total_ms,
                diarization_time_ms, transcription_time_ms,
            )

            return IncrementalProcessResponse(
                session_id=req.session_id,
                increment_index=req.increment_index,
                utterances=utterances,
                speaker_profiles=[p.to_schema() for p in session.speaker_profiles.values()],
                speaker_mapping=speaker_mapping,
                checkpoint=checkpoint,
                diarization_time_ms=diarization_time_ms,
                transcription_time_ms=transcription_time_ms,
                total_processing_time_ms=total_ms,
                speakers_detected=len(session.speaker_profiles),
                stable_speaker_map=session.stable_speaker_map,
            )
        finally:
            try:
                Path(wav_path).unlink(missing_ok=True)
            except OSError:
                pass

    def finalize(self, req: IncrementalFinalizeRequest) -> IncrementalFinalizeResponse:
        """Finalize incremental processing and generate the full report.

        1. Process final audio chunk (if any unprocessed audio >5s remains)
        2. Collect all utterances + checkpoints
        3. Merge checkpoints via LLM → final report
        4. Clean up session state
        """
        t0 = time.monotonic()
        session = self._sessions.get(req.session_id)

        if not session:
            logger.warning("Finalize called for unknown session %s, creating empty", req.session_id)
            session = IncrementalSessionState(session_id=req.session_id)

        # Process final audio chunk if provided and long enough (>5s)
        if req.final_audio_b64:
            duration_ms = req.final_audio_end_ms - req.final_audio_start_ms
            if duration_ms > 5000:
                logger.info(
                    "Processing final audio chunk for session %s: %dms",
                    req.session_id, duration_ms,
                )
                try:
                    final_req = IncrementalProcessRequest(
                        session_id=req.session_id,
                        increment_index=len(session.increment_results),
                        audio_b64=req.final_audio_b64,
                        audio_format=req.final_audio_format,
                        audio_start_ms=req.final_audio_start_ms,
                        audio_end_ms=req.final_audio_end_ms,
                        run_analysis=False,
                        language="auto",
                        locale=req.locale,
                        memos=req.memos,
                        stats=req.stats,
                    )
                    self.process_increment(final_req)
                except Exception:
                    logger.warning(
                        "Failed to process final audio chunk for session %s",
                        req.session_id, exc_info=True,
                    )

        # Collect all utterances across increments
        all_utterances = self._collect_all_utterances(session)

        # Compute speaker stats from accumulated data
        speaker_stats = self._compute_speaker_stats(session)

        # Build evidence refs from utterances
        evidence = req.evidence or self._build_evidence_refs(all_utterances)

        # Generate final report via checkpoint merge
        report = None
        if session.checkpoints:
            try:
                merge_req = MergeCheckpointsRequest(
                    session_id=req.session_id,
                    checkpoints=session.checkpoints,
                    final_stats=speaker_stats if speaker_stats else req.stats,
                    final_memos=req.memos,
                    evidence=evidence,
                    locale=req.locale,
                )
                report = self._checkpoint_analyzer.merge_checkpoints(merge_req)
            except Exception:
                logger.warning(
                    "Failed to merge checkpoints for session %s",
                    req.session_id, exc_info=True,
                )

        total_audio_ms = 0
        for result in session.increment_results:
            total_audio_ms = max(total_audio_ms, result.audio_end_ms)

        finalize_ms = int((time.monotonic() - t0) * 1000)

        logger.info(
            "Finalized session %s: %d increments, %d utterances, %dms audio, %dms finalize",
            req.session_id, len(session.increment_results),
            len(all_utterances), total_audio_ms, finalize_ms,
        )

        # Clean up session
        self._remove_session(req.session_id)

        return IncrementalFinalizeResponse(
            session_id=req.session_id,
            transcript=all_utterances,
            speaker_stats=speaker_stats if speaker_stats else req.stats,
            report=report,
            total_increments=len(session.increment_results),
            total_audio_ms=total_audio_ms,
            finalize_time_ms=finalize_ms,
        )

    def cleanup_stale_sessions(self, max_age_s: float = 7200) -> int:
        """Remove sessions older than max_age_s seconds. Returns count removed."""
        now = time.monotonic()
        stale_ids = []
        with self._lock:
            for sid, state in self._sessions.items():
                if now - state.last_activity > max_age_s:
                    stale_ids.append(sid)
            for sid in stale_ids:
                del self._sessions[sid]
        if stale_ids:
            logger.info("Cleaned up %d stale incremental sessions", len(stale_ids))
        return len(stale_ids)

    # ── Speaker matching ───────────────────────────────────────────────────

    def _match_speakers(
        self,
        diarize_result: DiarizeResult,
        session: IncrementalSessionState,
        increment_index: int,
        audio_start_ms: int,
        audio_end_ms: int,
    ) -> dict[str, str]:
        """Match local diarization speakers to global session profiles.

        Uses greedy cosine similarity matching:
          - For each local speaker, find most similar global speaker
          - If similarity > threshold → match (update global centroid)
          - Otherwise → create new global speaker

        Returns: mapping of local_speaker_id → global_speaker_id
        """
        threshold = self._settings.incremental_speaker_match_threshold
        mapping: dict[str, str] = {}

        # Collect per-speaker durations from segments
        local_durations: dict[str, int] = {}
        for seg in diarize_result.segments:
            local_durations[seg.speaker_id] = (
                local_durations.get(seg.speaker_id, 0) + (seg.end_ms - seg.start_ms)
            )

        # Track which global speakers are already claimed this round
        claimed_globals: set[str] = set()

        # Sort local speakers by duration (longest first for better matching)
        local_speakers = sorted(
            diarize_result.embeddings.keys(),
            key=lambda s: local_durations.get(s, 0),
            reverse=True,
        )

        for local_id in local_speakers:
            local_emb_list = diarize_result.embeddings.get(local_id)
            if not local_emb_list:
                # No embedding — assign as new speaker
                global_id = self._create_new_speaker(
                    session, local_id, increment_index, local_durations.get(local_id, 0)
                )
                mapping[local_id] = global_id
                continue

            local_emb = np.array(local_emb_list, dtype=np.float32)

            # Find best matching global speaker
            best_global_id: str | None = None
            best_sim: float = -1.0

            for gid, profile in session.speaker_profiles.items():
                if gid in claimed_globals:
                    continue
                if profile.centroid.size == 0:
                    continue
                sim = self._cosine_similarity(local_emb, profile.centroid)
                if sim > best_sim:
                    best_sim = sim
                    best_global_id = gid

            if best_global_id is not None and best_sim >= threshold:
                # Match found — update global profile
                profile = session.speaker_profiles[best_global_id]
                profile.embeddings.append(local_emb)
                profile.update_centroid()
                profile.total_speech_ms += local_durations.get(local_id, 0)
                mapping[local_id] = best_global_id
                claimed_globals.add(best_global_id)
                logger.debug(
                    "Matched local %s → global %s (sim=%.3f)",
                    local_id, best_global_id, best_sim,
                )
            else:
                # No match — create new global speaker
                global_id = self._create_new_speaker(
                    session, local_id, increment_index,
                    local_durations.get(local_id, 0), local_emb,
                )
                mapping[local_id] = global_id
                claimed_globals.add(global_id)

        return mapping

    def _create_new_speaker(
        self,
        session: IncrementalSessionState,
        local_id: str,
        increment_index: int,
        speech_ms: int,
        embedding: np.ndarray | None = None,
    ) -> str:
        """Create a new global speaker profile."""
        global_id = f"spk_{len(session.speaker_profiles):02d}"
        profile = SpeakerProfile(
            speaker_id=global_id,
            total_speech_ms=speech_ms,
            first_seen_increment=increment_index,
        )
        if embedding is not None:
            profile.embeddings.append(embedding)
            profile.update_centroid()
        session.speaker_profiles[global_id] = profile
        logger.debug("Created new global speaker %s (from local %s)", global_id, local_id)
        return global_id

    @staticmethod
    def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        """Compute cosine similarity between two vectors."""
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return float(np.dot(a, b) / (norm_a * norm_b))

    # ── Merge logic ────────────────────────────────────────────────────────

    def _merge_transcript_diarization(
        self,
        asr_result: TranscriptResult,
        diarize_result: DiarizeResult,
        speaker_mapping: dict[str, str],
        audio_start_ms: int,
    ) -> list[MergedUtteranceOut]:
        """Merge ASR utterances with diarization segments, applying global speaker IDs.

        For each ASR utterance, find the diarization segment with max overlap,
        then map via speaker_mapping to the global speaker ID.
        """
        merged: list[MergedUtteranceOut] = []

        for utt in asr_result.utterances:
            local_speaker = self._find_best_speaker(utt, diarize_result.segments)
            global_speaker = speaker_mapping.get(local_speaker, local_speaker)

            # Offset timestamps by audio_start_ms for absolute positioning
            abs_start = utt.start_ms + audio_start_ms
            abs_end = utt.end_ms + audio_start_ms

            merged.append(MergedUtteranceOut(
                id=utt.id,
                speaker=global_speaker,
                text=utt.text,
                start_ms=abs_start,
                end_ms=abs_end,
                words=[
                    WordTimestampOut(
                        word=w.word,
                        start_ms=w.start_ms + audio_start_ms,
                        end_ms=w.end_ms + audio_start_ms,
                        confidence=w.confidence,
                    )
                    for w in utt.words
                ],
                language=utt.language,
                confidence=utt.confidence,
            ))

        return merged

    @staticmethod
    def _find_best_speaker(utterance: ASRUtterance, segments: list[SpeakerSegment]) -> str:
        """Find the diarization speaker with the most overlap for an ASR utterance."""
        best_speaker = "_unknown"
        best_overlap = 0

        for seg in segments:
            overlap_start = max(utterance.start_ms, seg.start_ms)
            overlap_end = min(utterance.end_ms, seg.end_ms)
            overlap = max(0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = seg.speaker_id

        return best_speaker

    # ── Checkpoint analysis ────────────────────────────────────────────────

    def _should_run_analysis(self, increment_index: int) -> bool:
        """Check if LLM analysis should run for this increment."""
        interval = self._settings.incremental_analysis_interval
        # Run analysis on every Nth increment (0-indexed), always run on first
        return increment_index == 0 or (increment_index + 1) % interval == 0

    def _run_checkpoint_analysis(
        self,
        session: IncrementalSessionState,
        req: IncrementalProcessRequest,
        utterances: list[MergedUtteranceOut],
    ) -> CheckpointResponse | None:
        """Run LLM checkpoint analysis on the current increment's utterances."""
        if not utterances:
            return None

        try:
            transcript_utterances = [
                TranscriptUtterance(
                    utterance_id=u.id,
                    stream_role="students",
                    speaker_name=u.speaker,
                    text=u.text,
                    start_ms=u.start_ms,
                    end_ms=u.end_ms,
                    duration_ms=u.end_ms - u.start_ms,
                )
                for u in utterances
            ]

            checkpoint_req = CheckpointRequest(
                session_id=req.session_id,
                checkpoint_index=len(session.checkpoints),
                utterances=transcript_utterances,
                memos=req.memos,
                stats=req.stats,
                locale=req.locale,
            )
            return self._checkpoint_analyzer.analyze_checkpoint(checkpoint_req)
        except Exception:
            logger.warning(
                "Checkpoint analysis failed for session %s increment %d",
                req.session_id, req.increment_index, exc_info=True,
            )
            return None

    # ── Session management ─────────────────────────────────────────────────

    def _get_or_create_session(self, session_id: str) -> IncrementalSessionState:
        with self._lock:
            if session_id not in self._sessions:
                if len(self._sessions) >= self._settings.incremental_max_sessions:
                    # Evict oldest session
                    oldest = min(self._sessions, key=lambda k: self._sessions[k].last_activity)
                    logger.warning("Evicting oldest incremental session %s", oldest)
                    del self._sessions[oldest]
                self._sessions[session_id] = IncrementalSessionState(session_id=session_id)
            return self._sessions[session_id]

    def _remove_session(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def _restore_profiles(
        self, session: IncrementalSessionState, profiles: list[SpeakerProfileOut]
    ) -> None:
        """Restore speaker profiles from a previous session (recovery mode)."""
        for p in profiles:
            centroid = np.array(p.centroid, dtype=np.float32) if p.centroid else np.zeros(0)
            profile = SpeakerProfile(
                speaker_id=p.speaker_id,
                centroid=centroid,
                embeddings=[centroid] if centroid.size > 0 else [],
                total_speech_ms=p.total_speech_ms,
                first_seen_increment=p.first_seen_increment,
                display_name=p.display_name,
            )
            session.speaker_profiles[p.speaker_id] = profile
        logger.info(
            "Restored %d speaker profiles for session %s",
            len(profiles), session.session_id,
        )

    # ── Helpers ────────────────────────────────────────────────────────────

    @staticmethod
    def _decode_audio(audio_b64: str, audio_format: str) -> str:
        """Decode base64 audio to a temporary WAV file on disk."""
        raw = base64.b64decode(audio_b64)

        if audio_format == "pcm_s16le":
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            with wave.open(tmp, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                wf.writeframes(raw)
            return tmp.name
        else:
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.write(raw)
            tmp.close()
            return tmp.name

    def _collect_all_utterances(
        self, session: IncrementalSessionState
    ) -> list[MergedUtteranceOut]:
        """Collect and deduplicate utterances across all increments.

        In cumulative mode, later increments re-process earlier audio,
        so we keep only the latest version of overlapping utterances.
        For chunk mode with overlap, we deduplicate by time range.
        """
        if not session.increment_results:
            return []

        cumulative_threshold = self._settings.incremental_cumulative_threshold

        # If all increments were cumulative, just use the last one
        last_cumulative_idx = min(
            cumulative_threshold - 1, len(session.increment_results) - 1
        )

        all_utterances: list[MergedUtteranceOut] = []

        # Start with the last cumulative increment (it contains all prior audio)
        if last_cumulative_idx >= 0 and last_cumulative_idx < len(session.increment_results):
            all_utterances.extend(session.increment_results[last_cumulative_idx].utterances)
            last_end_ms = session.increment_results[last_cumulative_idx].audio_end_ms
        else:
            last_end_ms = 0

        # Append chunk-mode increments, skipping overlap region
        for result in session.increment_results[last_cumulative_idx + 1:]:
            overlap_ms = self._settings.incremental_overlap_ms
            # Only include utterances that start after the overlap region
            cutoff_ms = result.audio_start_ms + overlap_ms
            for utt in result.utterances:
                if utt.start_ms >= cutoff_ms:
                    all_utterances.append(utt)

        # Sort by start time
        all_utterances.sort(key=lambda u: u.start_ms)
        return all_utterances

    def _compute_speaker_stats(
        self, session: IncrementalSessionState
    ) -> list[SpeakerStat]:
        """Compute speaker stats from accumulated profiles."""
        stats = []
        for profile in session.speaker_profiles.values():
            stats.append(SpeakerStat(
                speaker_key=profile.speaker_id,
                speaker_name=profile.display_name,
                talk_time_ms=profile.total_speech_ms,
                turns=0,  # Would need more tracking to compute accurately
            ))
        return stats

    @staticmethod
    def _build_evidence_refs(utterances: list[MergedUtteranceOut]) -> list[EvidenceRef]:
        """Build evidence references from utterances for report generation."""
        evidence: list[EvidenceRef] = []
        for i, utt in enumerate(utterances):
            if utt.text.strip():
                evidence.append(EvidenceRef(
                    evidence_id=f"e_{i:05d}",
                    time_range_ms=[utt.start_ms, utt.end_ms],
                    utterance_ids=[utt.id],
                    speaker_key=utt.speaker,
                    quote=utt.text[:400],
                    confidence=utt.confidence,
                ))
        return evidence
