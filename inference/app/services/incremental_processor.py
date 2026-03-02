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
import json
import logging
import re
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
from app.services.name_resolver import NameResolver
from app.services.whisper_batch import TranscriptResult, Utterance as ASRUtterance

logger = logging.getLogger(__name__)

# Module-level compiled regex for CJK / non-target language detection
_CJK_CHAR_RE = re.compile(
    r'[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff'
    r'\u4e00-\u9fff\uf900-\ufaff\uff00-\uff9f]'
)
_ALPHA_CHAR_RE = re.compile(r'[a-zA-Z0-9]')

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
        arbiter=None,  # SpeakerArbiter (optional Pass 3 correction)
    ) -> None:
        self._settings = settings
        self._diarizer = diarizer
        self._asr = asr_backend
        self._checkpoint_analyzer = checkpoint_analyzer
        self._arbiter = arbiter
        self._llm = checkpoint_analyzer.llm
        self._name_resolver = NameResolver()
        self._sessions: dict[str, IncrementalSessionState] = {}
        self._lock = threading.Lock()

    # ── Public API ─────────────────────────────────────────────────────────

    def process_increment(self, req: IncrementalProcessRequest) -> IncrementalProcessResponse:
        """Process a single audio increment.

        1. Decode audio → temp WAV
        2. Diarize with pyannote → speaker segments
        3. Match local speakers to global profiles
        4. Transcribe each diarization segment individually (segment-driven ASR)
        5. Optionally run LLM checkpoint analysis
        6. Update session state, return result

        NOTE: We run diarization first, then transcribe per-segment. This is
        sequential (not parallel) because SenseVoice ONNX returns a single
        utterance for the full audio without word timestamps, making post-hoc
        merge impossible. Per-segment ASR produces properly speaker-labeled
        utterances with correct timestamps. Total time is similar (~20s vs ~17s)
        because per-segment ASR is very fast on short clips.
        """
        t0 = time.monotonic()
        session = self._get_or_create_session(req.session_id)

        # Restore speaker profiles from request if session is fresh
        if not session.speaker_profiles and req.previous_speaker_profiles:
            self._restore_profiles(session, req.previous_speaker_profiles)

        # Decode audio to temp WAV file
        wav_path = self._decode_audio(req.audio_b64, req.audio_format)

        try:
            # Step 1: Diarize — identify speaker segments
            diarize_result: DiarizeResult = self._diarizer.diarize(
                wav_path, num_speakers=req.num_speakers
            )
            diarization_time_ms = diarize_result.processing_time_ms

            # Step 2: Match speakers — local diarization labels → global profiles
            speaker_mapping = self._match_speakers(
                diarize_result, session, req.increment_index, req.audio_start_ms, req.audio_end_ms
            )

            # Step 3: Transcribe each diarization segment individually
            utterances, transcription_time_ms = self._transcribe_by_segments(
                wav_path, diarize_result, speaker_mapping,
                req.audio_start_ms, req.language,
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

        # Merge similar global speaker profiles before collecting utterances
        merge_map = self._merge_similar_profiles(session)

        # Collect all utterances across increments
        all_utterances = self._collect_all_utterances(session)

        # LLM transcript correction + speaker name extraction
        all_utterances, name_map = self._polish_transcript(
            all_utterances, session, req.locale
        )
        for speaker_id, name in name_map.items():
            if speaker_id in session.speaker_profiles:
                session.speaker_profiles[speaker_id].display_name = name

        # Compute speaker stats from accumulated data (reads display_name)
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

        Two-pass matching with minimum-duration filter to prevent over-segmentation:

        Pass 1 (strict, threshold=0.60):
          Greedy cosine matching, longest-first. Matched speakers get centroid
          update. Unmatched speakers are deferred to Pass 2.

        Pass 2 (relaxed, threshold=0.40):
          For unmatched locals, try unclaimed globals at lower threshold.
          Matched speakers do NOT update centroid (low-confidence embedding).

        Min-duration filter:
          Local speakers with < min_duration speech cannot create new global
          profiles. They are force-assigned to the best available global
          (even if all globals are already claimed).

        Returns: mapping of local_speaker_id → global_speaker_id
        """
        strict_thr = self._settings.incremental_speaker_match_threshold
        relaxed_thr = self._settings.incremental_speaker_match_threshold_relaxed
        min_dur_ms = self._settings.incremental_min_speaker_duration_ms
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

        # Prepare embeddings
        local_embs: dict[str, np.ndarray] = {}
        unmatched_locals: list[str] = []

        # ── Pass 1: strict matching ──────────────────────────────────────
        for local_id in local_speakers:
            local_emb_list = diarize_result.embeddings.get(local_id)
            if not local_emb_list:
                # No embedding — defer to Pass 2
                unmatched_locals.append(local_id)
                continue

            local_emb = np.array(local_emb_list, dtype=np.float32)
            local_embs[local_id] = local_emb

            best_global_id, best_sim = self._find_best_global(
                local_emb, session, claimed_globals
            )

            self._log_similarity_matrix(
                increment_index, local_id, local_emb,
                session, claimed_globals, best_global_id, best_sim, strict_thr, 1,
            )

            if best_global_id is not None and best_sim >= strict_thr:
                profile = session.speaker_profiles[best_global_id]
                profile.embeddings.append(local_emb)
                profile.update_centroid()
                profile.total_speech_ms += local_durations.get(local_id, 0)
                mapping[local_id] = best_global_id
                claimed_globals.add(best_global_id)
                logger.debug(
                    "  P1 → MATCHED %s → %s (sim=%.3f)",
                    local_id, best_global_id, best_sim,
                )
            else:
                unmatched_locals.append(local_id)

        # ── Pass 2: relaxed matching + min-duration filter ────────────────
        for local_id in unmatched_locals:
            local_emb = local_embs.get(local_id)
            dur_ms = local_durations.get(local_id, 0)

            if local_emb is None:
                # No embedding at all — only create if enough speech
                if dur_ms >= min_dur_ms:
                    global_id = self._create_new_speaker(
                        session, local_id, increment_index, dur_ms,
                    )
                    mapping[local_id] = global_id
                    claimed_globals.add(global_id)
                    logger.debug("  P2 → NEW %s (no embedding, dur=%dms)", global_id, dur_ms)
                else:
                    # Short speaker with no embedding — skip entirely
                    logger.debug("  P2 → SKIP %s (no embedding, dur=%dms < %dms)", local_id, dur_ms, min_dur_ms)
                continue

            # Try relaxed matching against unclaimed globals
            best_global_id, best_sim = self._find_best_global(
                local_emb, session, claimed_globals
            )

            self._log_similarity_matrix(
                increment_index, local_id, local_emb,
                session, claimed_globals, best_global_id, best_sim, relaxed_thr, 2,
            )

            if best_global_id is not None and best_sim >= relaxed_thr:
                # Relaxed match — do NOT update centroid (low-confidence embedding)
                profile = session.speaker_profiles[best_global_id]
                profile.total_speech_ms += dur_ms
                mapping[local_id] = best_global_id
                claimed_globals.add(best_global_id)
                logger.debug(
                    "  P2 → RELAXED-MATCH %s → %s (sim=%.3f, no centroid update)",
                    local_id, best_global_id, best_sim,
                )
            elif dur_ms >= min_dur_ms:
                # Enough speech — create new global speaker
                global_id = self._create_new_speaker(
                    session, local_id, increment_index, dur_ms, local_emb,
                )
                mapping[local_id] = global_id
                claimed_globals.add(global_id)
                logger.debug(
                    "  P2 → NEW %s (best=%s=%.3f < %.2f, dur=%dms)",
                    global_id, best_global_id, best_sim, relaxed_thr, dur_ms,
                )
            else:
                # Short speaker, low similarity — force-assign to best global
                # (including already-claimed globals as last resort)
                force_id, force_sim = self._find_best_global(
                    local_emb, session, frozenset(),  # empty exclusion = search all
                )
                if force_id is not None and force_sim >= relaxed_thr:
                    # Force-assign: similarity plausible, just duration too short
                    profile = session.speaker_profiles[force_id]
                    profile.total_speech_ms += dur_ms
                    mapping[local_id] = force_id
                    logger.debug(
                        "  P2 → FORCE-ASSIGN %s → %s (sim=%.3f, dur=%dms < %dms)",
                        local_id, force_id, force_sim, dur_ms, min_dur_ms,
                    )
                elif not session.speaker_profiles:
                    # No global profiles at all (first increment) — must create
                    global_id = self._create_new_speaker(
                        session, local_id, increment_index, dur_ms, local_emb,
                    )
                    mapping[local_id] = global_id
                    claimed_globals.add(global_id)
                    logger.debug("  P2 → NEW %s (no globals exist yet)", global_id)
                else:
                    # Short + low similarity to all globals = phantom speaker.
                    # Do not create new global; assign to best global (even if
                    # already claimed) to avoid polluting the speaker list.
                    if force_id is not None:
                        profile = session.speaker_profiles[force_id]
                        profile.total_speech_ms += dur_ms
                        mapping[local_id] = force_id
                        logger.debug(
                            "  P2 → ABSORB-PHANTOM %s → %s (sim=%.3f < %.2f, dur=%dms)",
                            local_id, force_id, force_sim, relaxed_thr, dur_ms,
                        )
                    else:
                        logger.debug("  P2 → DROP %s (no globals, dur=%dms)", local_id, dur_ms)

        return mapping

    def _find_best_global(
        self,
        local_emb: np.ndarray,
        session: IncrementalSessionState,
        exclude: set[str] | frozenset[str],
    ) -> tuple[str | None, float]:
        """Find the global speaker most similar to local_emb, excluding given IDs."""
        best_id: str | None = None
        best_sim: float = -1.0
        for gid, profile in session.speaker_profiles.items():
            if gid in exclude:
                continue
            if profile.centroid.size == 0:
                continue
            sim = self._cosine_similarity(local_emb, profile.centroid)
            if sim > best_sim:
                best_sim = sim
                best_id = gid
        return best_id, best_sim

    def _log_similarity_matrix(
        self,
        increment_index: int,
        local_id: str,
        local_emb: np.ndarray,
        session: IncrementalSessionState,
        claimed_globals: set[str],
        best_global_id: str | None,
        best_sim: float,
        threshold: float,
        pass_num: int,
    ) -> None:
        """Log similarity scores for diagnostics."""
        if not session.speaker_profiles:
            return
        sims_str = ", ".join(
            f"{gid}={self._cosine_similarity(local_emb, p.centroid):.3f}"
            for gid, p in session.speaker_profiles.items()
            if p.centroid.size > 0 and gid not in claimed_globals
        )
        logger.debug(
            "Inc %d P%d: local %s sims=[%s] best=%s(%.3f) thr=%.2f",
            increment_index, pass_num, local_id, sims_str,
            best_global_id, best_sim, threshold,
        )

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

    # ── Finalize-time speaker merging ─────────────────────────────────────

    def _merge_similar_profiles(
        self, session: IncrementalSessionState
    ) -> dict[str, str]:
        """Merge global speaker profiles with similar centroids.

        After all increments are processed, some global profiles may actually
        represent the same physical speaker whose embedding drifted during the
        session. This method performs pairwise centroid comparison and merges
        profiles above a similarity threshold.

        Strategy:
          1. Compute pairwise cosine similarity between all global centroids.
          2. Greedily merge the most similar pair (above threshold), keeping
             the profile with more total speech as the survivor.
          3. Repeat until no pair exceeds the threshold.
          4. Update all utterances in increment_results to use survivor IDs.

        Returns: merge_map {absorbed_id → survivor_id} (empty if no merges)
        """
        merge_thr = self._settings.incremental_finalize_merge_threshold
        merge_map: dict[str, str] = {}  # absorbed_id → survivor_id

        # Iteratively merge the most similar pair
        merged = True
        while merged:
            merged = False
            profile_ids = [
                pid for pid in session.speaker_profiles
                if pid not in merge_map
            ]
            if len(profile_ids) < 2:
                break

            # Find the most similar pair
            best_sim = -1.0
            best_pair: tuple[str, str] | None = None
            for i, pid_a in enumerate(profile_ids):
                pa = session.speaker_profiles[pid_a]
                if pa.centroid.size == 0:
                    continue
                for pid_b in profile_ids[i + 1:]:
                    pb = session.speaker_profiles[pid_b]
                    if pb.centroid.size == 0:
                        continue
                    sim = self._cosine_similarity(pa.centroid, pb.centroid)
                    if sim > best_sim:
                        best_sim = sim
                        best_pair = (pid_a, pid_b)

            if best_pair is None or best_sim < merge_thr:
                break

            # Merge: survivor = the one with more speech
            pid_a, pid_b = best_pair
            pa = session.speaker_profiles[pid_a]
            pb = session.speaker_profiles[pid_b]

            if pa.total_speech_ms >= pb.total_speech_ms:
                survivor, absorbed = pa, pb
            else:
                survivor, absorbed = pb, pa

            logger.info(
                "FINALIZE-MERGE: %s (%.0fs) absorbs %s (%.0fs), sim=%.3f",
                survivor.speaker_id, survivor.total_speech_ms / 1000,
                absorbed.speaker_id, absorbed.total_speech_ms / 1000,
                best_sim,
            )

            # Transfer embeddings and speech time
            survivor.embeddings.extend(absorbed.embeddings)
            survivor.update_centroid()
            survivor.total_speech_ms += absorbed.total_speech_ms

            # Record the merge and remove absorbed profile
            merge_map[absorbed.speaker_id] = survivor.speaker_id
            del session.speaker_profiles[absorbed.speaker_id]
            merged = True

        # Also resolve transitive merges: if A→B and B→C, make A→C
        for absorbed_id in list(merge_map):
            target = merge_map[absorbed_id]
            while target in merge_map:
                target = merge_map[target]
            merge_map[absorbed_id] = target

        # Update all utterances in increment_results
        if merge_map:
            self._remap_utterance_speakers(session, merge_map)
            logger.info(
                "Finalize merge complete: %d profiles merged, %d remain",
                len(merge_map), len(session.speaker_profiles),
            )

        return merge_map

    def _remap_utterance_speakers(
        self,
        session: IncrementalSessionState,
        merge_map: dict[str, str],
    ) -> None:
        """Update speaker IDs in all stored utterances after profile merging."""
        for result in session.increment_results:
            for utt in result.utterances:
                if utt.speaker in merge_map:
                    utt.speaker = merge_map[utt.speaker]
            # Also update speaker_mapping
            for local_id, global_id in result.speaker_mapping.items():
                if global_id in merge_map:
                    result.speaker_mapping[local_id] = merge_map[global_id]

    # ── Post-ASR text cleaning ─────────────────────────────────────────

    @staticmethod
    def _clean_asr_text(text: str, target_language: str) -> str:
        """Filter non-target language artefacts from ASR output.

        When the target language is English but the ASR model hallucinates
        CJK/kana characters (common with Moonshine on short/ambiguous audio),
        replace the text with ``[filler]`` to preserve timing information
        while removing garbage text.

        Returns the original text unchanged when:
          - target language is not English
          - CJK character ratio is ≤50%
          - text is empty
        """
        if not text or target_language not in ("en", "auto"):
            return text

        cjk_count = len(_CJK_CHAR_RE.findall(text))
        alpha_count = len(_ALPHA_CHAR_RE.findall(text))

        if cjk_count == 0:
            return text

        total = cjk_count + alpha_count
        if total == 0:
            return text

        if cjk_count / total > 0.5:
            return "[filler]"

        return text

    # ── LLM transcript polish + name extraction ─────────────────────────

    def _polish_transcript(
        self,
        utterances: list[MergedUtteranceOut],
        session: IncrementalSessionState,
        locale: str,
    ) -> tuple[list[MergedUtteranceOut], dict[str, str]]:
        """Polish transcript via LLM and extract speaker names.

        Two-layer approach:
          1. LLM corrects ASR errors and extracts names from context
          2. Regex name extraction runs as fallback / override

        Returns (polished_utterances, name_map).
        On LLM failure, returns (original_utterances, regex_name_map).
        """
        if not utterances:
            return utterances, {}

        # Always run regex name extraction (fast, reliable for explicit patterns)
        regex_names = self._extract_names_regex(utterances, session)

        # Attempt LLM polish
        llm_names: dict[str, str] = {}
        corrected_utterances = utterances
        try:
            corrected_utterances, llm_names = self._llm_polish(
                utterances, locale
            )
        except Exception:
            logger.warning(
                "LLM transcript polish failed, falling back to regex-only",
                exc_info=True,
            )

        # Merge names: regex results override LLM (regex more reliable for
        # explicit patterns like "my name is X")
        name_map = {**llm_names, **regex_names}

        return corrected_utterances, name_map

    def _llm_polish(
        self,
        utterances: list[MergedUtteranceOut],
        locale: str,
    ) -> tuple[list[MergedUtteranceOut], dict[str, str]]:
        """Call LLM to correct ASR errors and extract speaker names.

        Limits input to the first 200 utterances to control token budget.
        Returns (corrected_utterances, name_map).
        """
        max_utterances = 200
        capped = utterances[:max_utterances]

        transcript_json = [
            {"id": u.id, "speaker": u.speaker, "text": u.text}
            for u in capped
        ]

        system_prompt = (
            "You are an ASR post-processor. Fix transcription errors in the "
            "interview transcript below.\n\n"
            "Rules:\n"
            "1. Fix obvious ASR errors: spelling, word boundaries, repeated "
            "syllables (e.g. 'hellello'→'hello', 'bowcompatible'→'biocompatible').\n"
            "2. Replace '[filler]' with an appropriate English filler word "
            "(um, uh, hmm, yeah, etc.).\n"
            "3. Extract speaker names from self-introductions (patterns: "
            "'my name is X', 'I am X', 'call me X', 'go by X').\n"
            "4. Do NOT change meaning, add content, or rewrite style.\n"
            "5. Only fix clear ASR artefacts, do NOT correct grammar.\n"
            "6. Only include utterances that need correction in 'corrections'.\n\n"
            "Return JSON:\n"
            '{"corrections": [{"id": "u_0001", "text": "corrected text"}], '
            '"speaker_names": {"spk_03": "Tina"}}'
        )

        user_prompt = json.dumps(transcript_json, ensure_ascii=False)

        parsed = self._llm.generate_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
        )

        # Apply corrections
        corrections_list = parsed.get("corrections", [])
        correction_map: dict[str, str] = {}
        for c in corrections_list:
            uid = c.get("id", "")
            new_text = c.get("text", "")
            if uid and new_text:
                correction_map[uid] = new_text

        result_utterances: list[MergedUtteranceOut] = []
        for u in utterances:
            if u.id in correction_map:
                result_utterances.append(MergedUtteranceOut(
                    id=u.id,
                    speaker=u.speaker,
                    text=correction_map[u.id],
                    start_ms=u.start_ms,
                    end_ms=u.end_ms,
                    words=u.words,
                    language=u.language,
                    confidence=u.confidence,
                ))
            else:
                result_utterances.append(u)

        llm_names: dict[str, str] = {}
        raw_names = parsed.get("speaker_names", {})
        if isinstance(raw_names, dict):
            for spk, name in raw_names.items():
                if isinstance(spk, str) and isinstance(name, str) and name.strip():
                    llm_names[spk] = name.strip()

        return result_utterances, llm_names

    def _extract_names_regex(
        self,
        utterances: list[MergedUtteranceOut],
        session: IncrementalSessionState,
    ) -> dict[str, str]:
        """Extract speaker names from utterances using regex patterns.

        Groups utterances by speaker, takes the first 10 per speaker,
        and runs NameResolver on the concatenated text.
        """
        speaker_texts: dict[str, list[str]] = {}
        for u in utterances:
            bucket = speaker_texts.setdefault(u.speaker, [])
            if len(bucket) < 10:
                bucket.append(u.text)

        name_map: dict[str, str] = {}
        for speaker_id, texts in speaker_texts.items():
            combined = " ".join(texts)
            candidates = self._name_resolver.extract(combined)
            if candidates:
                name_map[speaker_id] = candidates[0].name

        return name_map

    # ── Segment-driven ASR ──────────────────────────────────────────────

    def _transcribe_by_segments(
        self,
        wav_path: str,
        diarize_result: DiarizeResult,
        speaker_mapping: dict[str, str],
        audio_start_ms: int,
        language: str,
    ) -> tuple[list[MergedUtteranceOut], int]:
        """Transcribe each diarization segment individually.

        Instead of transcribing the whole audio and trying to merge with
        diarization (which fails for ASR backends like SenseVoice ONNX that
        return a single utterance), we slice the audio per diarization segment
        and transcribe each one.

        Returns: (list of utterances, total transcription time in ms)
        """
        if not diarize_result.segments:
            return [], 0

        # Read the full WAV into memory once
        audio_samples, sr = self._read_wav_samples(wav_path)
        total_asr_ms = 0
        utterances: list[MergedUtteranceOut] = []

        # Merge adjacent segments from same speaker (gap < 500ms) to avoid
        # breaking mid-sentence at diarization micro-boundaries.
        merged_segments = self._merge_adjacent_segments(diarize_result.segments)
        utt_counter = 0

        for seg in merged_segments:
            # Slice audio for this segment
            start_sample = int(seg.start_ms / 1000 * sr)
            end_sample = int(seg.end_ms / 1000 * sr)
            segment_samples = audio_samples[start_sample:end_sample]

            if len(segment_samples) < int(0.3 * sr):
                # Skip very short segments (<300ms) — typically noise
                continue

            # Write segment to temp WAV
            seg_wav = self._samples_to_wav(segment_samples, sr)
            try:
                t_asr = time.monotonic()
                asr_result = self._asr.transcribe(seg_wav, language=language)
                total_asr_ms += int((time.monotonic() - t_asr) * 1000)
            finally:
                try:
                    Path(seg_wav).unlink(missing_ok=True)
                except OSError:
                    pass

            # Build utterance from ASR text + diarization speaker
            text = " ".join(u.text for u in asr_result.utterances).strip()
            text = self._clean_asr_text(text, language)
            if not text:
                continue

            global_speaker = speaker_mapping.get(seg.speaker_id, seg.speaker_id)
            abs_start = seg.start_ms + audio_start_ms
            abs_end = seg.end_ms + audio_start_ms

            utterances.append(MergedUtteranceOut(
                id=f"u_{utt_counter:04d}",
                speaker=global_speaker,
                text=text,
                start_ms=abs_start,
                end_ms=abs_end,
                words=[],
                language=asr_result.language or language,
                confidence=asr_result.utterances[0].confidence if asr_result.utterances else 1.0,
            ))
            utt_counter += 1

        return utterances, total_asr_ms

    @staticmethod
    def _merge_adjacent_segments(
        segments: list[SpeakerSegment], max_gap_ms: int = 500
    ) -> list[SpeakerSegment]:
        """Merge adjacent segments from the same speaker with gap < max_gap_ms.

        Prevents mid-sentence splits at diarization micro-boundaries.
        """
        if not segments:
            return []

        # Sort by start time
        sorted_segs = sorted(segments, key=lambda s: s.start_ms)
        merged: list[SpeakerSegment] = [SpeakerSegment(
            id=sorted_segs[0].id,
            speaker_id=sorted_segs[0].speaker_id,
            start_ms=sorted_segs[0].start_ms,
            end_ms=sorted_segs[0].end_ms,
            confidence=sorted_segs[0].confidence,
        )]

        for seg in sorted_segs[1:]:
            last = merged[-1]
            if (seg.speaker_id == last.speaker_id
                    and seg.start_ms - last.end_ms <= max_gap_ms):
                # Extend the previous segment
                last.end_ms = max(last.end_ms, seg.end_ms)
            else:
                merged.append(SpeakerSegment(
                    id=seg.id,
                    speaker_id=seg.speaker_id,
                    start_ms=seg.start_ms,
                    end_ms=seg.end_ms,
                    confidence=seg.confidence,
                ))

        return merged

    @staticmethod
    def _read_wav_samples(wav_path: str) -> tuple[np.ndarray, int]:
        """Read WAV file into float32 numpy array."""
        with wave.open(wav_path, "rb") as wf:
            sr = wf.getframerate()
            n_frames = wf.getnframes()
            raw = wf.readframes(n_frames)
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        return pcm, sr

    @staticmethod
    def _samples_to_wav(samples: np.ndarray, sr: int) -> str:
        """Write float32 samples to a temporary WAV file. Returns path."""
        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        try:
            with wave.open(tmp, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes(pcm.tobytes())
        finally:
            tmp.close()
        return tmp.name

    # ── Legacy merge logic (kept for non-ONNX ASR backends) ───────────────

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
