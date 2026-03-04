"""Canonical Incremental Pipeline — the only supported incremental endpoint.

Prefix: /v1/incremental

Features:
- Feature flag gated (INCREMENTAL_V1_ENABLED)
- Redis state persistence for merge-only finalize
- Idempotent process-chunk via increment_id
- V1 field names (audio_start_ms/audio_end_ms)
"""
from __future__ import annotations

import asyncio
import base64
import logging
import tempfile
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.schemas import (
    IncrementalProcessRequest,
    IncrementalProcessResponse,
)
from app.schemas_v1 import (
    SCHEMA_VERSION,
    FinalizeRequestV1,
    FinalizeResponseV1,
    ProcessChunkRequestV1,
    ProcessChunkResponseV1,
)

logger = logging.getLogger(__name__)
v1_router = APIRouter(prefix="/v1/incremental", tags=["incremental-v1"])


def _v1_disabled_response() -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={"error": "V1 not enabled", "v": SCHEMA_VERSION},
    )


def _redis_unavailable_response() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"error": "Redis unavailable, V1 requires state persistence", "v": SCHEMA_VERSION},
    )


@v1_router.post("/process-chunk")
async def process_chunk_v1(req: ProcessChunkRequestV1, request: Request):
    """V1 process-chunk with idempotency + Redis state persistence."""
    runtime = request.app.state.runtime
    settings = runtime.settings

    # 1. Feature flag check
    if not settings.incremental_v1_enabled:
        return _v1_disabled_response()

    # 2. Window hard limit: single increment max 360s (cumulative mode worst case)
    MAX_WINDOW_MS = 360_000
    window_ms = req.audio_end_ms - req.audio_start_ms
    if window_ms > MAX_WINDOW_MS:
        return JSONResponse(
            status_code=413,
            content={
                "error": f"Window {window_ms}ms exceeds max {MAX_WINDOW_MS}ms. Use sliced sending.",
                "v": SCHEMA_VERSION,
            },
        )

    # 3. Redis availability check
    redis_state = runtime.redis_state
    if redis_state is None:
        return _redis_unavailable_response()

    # 4. Idempotency pre-check (read-only)
    if redis_state.is_already_processed(req.session_id, req.increment_id):
        logger.info(
            "V1 process-chunk: duplicate increment_id=%s for session=%s, returning cached",
            req.increment_id, req.session_id,
        )
        return ProcessChunkResponseV1(
            session_id=req.session_id,
            increment_id=req.increment_id,
            increment_index=req.increment_index,
            metrics={"idempotent_reject": True},
        )

    # 5. Convert V1 request to internal IncrementalProcessRequest
    internal_req = IncrementalProcessRequest(
        session_id=req.session_id,
        increment_index=req.increment_index,
        audio_b64=req.audio_b64,
        audio_format="wav",
        audio_start_ms=req.audio_start_ms,
        audio_end_ms=req.audio_end_ms,
        run_analysis=req.run_analysis,
        language=req.language,
        locale=req.locale,
    )

    t0 = time.monotonic()
    processor = runtime.incremental_processor
    result: IncrementalProcessResponse = await asyncio.to_thread(
        processor.process_increment, internal_req,
    )
    processing_ms = int((time.monotonic() - t0) * 1000)

    # 6. Atomic write to Redis (idempotent gate inside Lua script)
    profiles_dict = {}
    for p in result.speaker_profiles:
        p_data = p.model_dump() if hasattr(p, "model_dump") else p
        profiles_dict[p_data.get("speaker_id", f"spk_{len(profiles_dict)}")] = p_data

    utts_list = [
        u.model_dump() if hasattr(u, "model_dump") else u
        for u in result.utterances
    ]

    chkpt_dict = None
    if result.checkpoint is not None:
        chkpt_dict = (
            result.checkpoint.model_dump()
            if hasattr(result.checkpoint, "model_dump")
            else result.checkpoint
        )

    was_written = redis_state.atomic_write_increment(
        session_id=req.session_id,
        increment_id=req.increment_id,
        increment_index=req.increment_index,
        meta_updates={
            "last_increment": req.increment_index,
            "last_audio_end_ms": req.audio_end_ms,
            "status": "recording",
        },
        speaker_profiles=profiles_dict,
        utterances=utts_list,
        checkpoint=chkpt_dict,
    )

    if not was_written:
        logger.warning(
            "V1 process-chunk: atomic_write lost race for increment_id=%s",
            req.increment_id,
        )

    # 7. Build V1 response
    return ProcessChunkResponseV1(
        session_id=req.session_id,
        increment_id=req.increment_id,
        increment_index=req.increment_index,
        utterances=utts_list,
        speaker_profiles=[
            p.model_dump() if hasattr(p, "model_dump") else p
            for p in result.speaker_profiles
        ],
        speaker_mapping=result.speaker_mapping,
        checkpoint=chkpt_dict,
        speakers_detected=result.speakers_detected,
        stable_speaker_map=result.stable_speaker_map,
        metrics={
            "processing_ms": processing_ms,
            "diarization_ms": result.diarization_time_ms,
            "transcription_ms": result.transcription_time_ms,
            "was_written": was_written,
        },
    )


def _cosine_sim(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors."""
    a_arr = np.array(a, dtype=np.float32)
    b_arr = np.array(b, dtype=np.float32)
    norm_a = np.linalg.norm(a_arr)
    norm_b = np.linalg.norm(b_arr)
    if norm_a < 1e-8 or norm_b < 1e-8:
        return 0.0
    return float(np.dot(a_arr, b_arr) / (norm_a * norm_b))


def _merge_redis_profiles(
    all_profiles: dict[str, dict], settings
) -> tuple[dict[str, dict], dict[str, str]]:
    """Merge similar speaker profiles by cosine similarity.

    Returns (merged_profiles, merge_map) where merge_map maps old_id -> new_id.
    The profile with a display_name (or more speech) is kept as representative.
    """
    threshold = settings.incremental_finalize_merge_threshold
    merge_map: dict[str, str] = {spk: spk for spk in all_profiles}
    merged: dict[str, dict] = dict(all_profiles)

    # Greedy merge: compare all pairs, merge most similar first
    changed = True
    while changed:
        changed = False
        current_ids = list(merged.keys())
        for i in range(len(current_ids)):
            for j in range(i + 1, len(current_ids)):
                id_a, id_b = current_ids[i], current_ids[j]
                if id_a not in merged or id_b not in merged:
                    continue
                ca = merged[id_a].get("centroid", [])
                cb = merged[id_b].get("centroid", [])
                if not ca or not cb:
                    continue
                sim = _cosine_sim(ca, cb)
                if sim >= threshold:
                    # Merge b into a (keep named one, or one with more speech)
                    a_named = bool(merged[id_a].get("display_name"))
                    b_named = bool(merged[id_b].get("display_name"))
                    if b_named and not a_named:
                        keep, drop = id_b, id_a
                    elif merged[id_b].get("total_speech_ms", 0) > merged[id_a].get("total_speech_ms", 0) and not a_named:
                        keep, drop = id_b, id_a
                    else:
                        keep, drop = id_a, id_b
                    # Merge speech time
                    merged[keep]["total_speech_ms"] = (
                        merged[keep].get("total_speech_ms", 0) +
                        merged[drop].get("total_speech_ms", 0)
                    )
                    # Update merge map
                    for k, v in merge_map.items():
                        if v == drop:
                            merge_map[k] = keep
                    del merged[drop]
                    changed = True
                    break
            if changed:
                break

    return merged, merge_map


def _remap_utterances(
    utterances: list[dict],
    merged_profiles: dict[str, dict],
    merge_map: dict[str, str],
) -> list[dict]:
    """Remap utterance speaker IDs to merged profile IDs."""
    remapped = []
    for u in utterances:
        new_u = dict(u)
        old_spk = u.get("speaker", "")
        new_spk = merge_map.get(old_spk, old_spk)
        new_u["speaker"] = new_spk
        # Add display_name if available
        profile = merged_profiles.get(new_spk, {})
        if profile.get("display_name"):
            new_u["speaker_name"] = profile["display_name"]
        remapped.append(new_u)
    return remapped


def _build_transcript(utterances: list[dict]) -> list[dict]:
    """Sort utterances by start_ms, deduplicate overlapping."""
    sorted_utts = sorted(utterances, key=lambda u: u.get("start_ms", 0))
    # Simple dedup: skip utterances that overlap > 50% with previous
    deduped = []
    for u in sorted_utts:
        if deduped:
            prev = deduped[-1]
            overlap_start = max(prev.get("start_ms", 0), u.get("start_ms", 0))
            overlap_end = min(prev.get("end_ms", 0), u.get("end_ms", 0))
            overlap = max(0, overlap_end - overlap_start)
            u_dur = max(1, u.get("end_ms", 0) - u.get("start_ms", 0))
            if overlap / u_dur > 0.5 and prev.get("speaker") == u.get("speaker"):
                continue  # Skip duplicate
        deduped.append(u)
    return deduped


def _compute_stats(utterances: list[dict], total_audio_ms: int) -> list[dict]:
    """Compute per-speaker statistics from utterances."""
    spk_data: dict[str, dict] = defaultdict(lambda: {
        "talk_time_ms": 0, "turns": 0, "speaker_name": None,
    })
    for u in utterances:
        spk = u.get("speaker", "unknown")
        dur = max(0, u.get("end_ms", 0) - u.get("start_ms", 0))
        spk_data[spk]["talk_time_ms"] += dur
        spk_data[spk]["turns"] += 1
        if u.get("speaker_name") and not spk_data[spk]["speaker_name"]:
            spk_data[spk]["speaker_name"] = u["speaker_name"]
    return [
        {
            "speaker_key": spk,
            "speaker_name": data["speaker_name"] or spk,
            "talk_time_ms": data["talk_time_ms"],
            "turns": data["turns"],
        }
        for spk, data in spk_data.items()
    ]


def _merge_checkpoints(checkpoints: list[dict]) -> str:
    """Merge all checkpoint summaries into a single context string."""
    parts = []
    for i, chk in enumerate(checkpoints):
        summary = chk.get("summary", "")
        if summary:
            parts.append(f"[Checkpoint {i}] {summary}")
    return "\n\n".join(parts)


def _decode_recompute_audio(audio_b64: str, audio_format: str) -> str:
    """Decode base64 audio to temp WAV file. Returns path."""
    raw = base64.b64decode(audio_b64)
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.write(raw)
    tmp.close()
    return tmp.name


@v1_router.post("/finalize")
async def finalize_v1(req: FinalizeRequestV1, request: Request):
    """V1 finalize — Redis-true-source merge-only.

    Reads ALL data from Redis. Does NOT call processor.finalize().
    Worker must send tail audio via process-chunk before calling finalize.
    """
    runtime = request.app.state.runtime
    settings = runtime.settings

    if not settings.incremental_v1_enabled:
        return _v1_disabled_response()

    redis_state = runtime.redis_state
    if redis_state is None:
        return _redis_unavailable_response()

    t0 = time.monotonic()

    # 1. Read ALL pre-computed state from Redis (true source)
    meta = redis_state.get_meta(req.session_id)
    all_utterances = redis_state.get_all_utterances(req.session_id)
    all_checkpoints = redis_state.get_all_checkpoints(req.session_id)
    all_profiles = redis_state.get_all_speaker_profiles(req.session_id)

    last_increment = int(meta.get("last_increment", "-1"))
    total_increments = last_increment + 1

    logger.info(
        "V1 finalize (Redis merge-only): session=%s, %d increments, "
        "%d utterances, %d checkpoints, %d profiles",
        req.session_id, total_increments, len(all_utterances),
        len(all_checkpoints), len(all_profiles),
    )

    if not all_utterances:
        return JSONResponse(
            status_code=404,
            content={"error": "No increments found in Redis", "v": SCHEMA_VERSION},
        )

    # 2. Merge speaker profiles (cosine dedup)
    merged_profiles, merge_map = _merge_redis_profiles(all_profiles, settings)

    # 3. Remap utterances to merged speaker IDs
    remapped = _remap_utterances(all_utterances, merged_profiles, merge_map)

    # 4. Build transcript (sorted, deduped)
    transcript = _build_transcript(remapped)

    # 4.5. Recompute low-confidence utterances (best-effort)
    recompute_requested = len(req.recompute_segments) if req.recompute_segments else 0
    recompute_succeeded = 0
    recompute_skipped = 0
    recompute_failed = 0

    if req.recompute_segments and runtime.recompute_asr is not None:
        # Dual-key alignment: primary=utterance_id, fallback=(increment_index, start_ms, end_ms)
        utt_by_id = {u.get("id", ""): u for u in transcript}
        utt_by_coords = {
            (u.get("increment_index", -1), u.get("start_ms", -1), u.get("end_ms", -1)): u
            for u in transcript
        }

        for seg in req.recompute_segments:
            target = utt_by_id.get(seg.utterance_id)
            if target is None:
                target = utt_by_coords.get(
                    (seg.increment_index, seg.start_ms, seg.end_ms)
                )
            if target is None:
                recompute_skipped += 1
                continue
            try:
                wav_path = _decode_recompute_audio(seg.audio_b64, seg.audio_format)
                try:
                    result = runtime.recompute_asr.recompute_utterance(
                        wav_path,
                        language=target.get("language", "en"),
                        start_ms=seg.start_ms,
                        end_ms=seg.end_ms,
                    )
                    if result.get("text"):
                        target["text"] = result["text"]
                        target["confidence"] = result["confidence"]
                        target["recomputed"] = True
                        recompute_succeeded += 1
                    else:
                        recompute_skipped += 1
                finally:
                    Path(wav_path).unlink(missing_ok=True)
            except Exception:
                recompute_failed += 1
                logger.warning(
                    "Recompute failed for utterance %s, keeping original",
                    seg.utterance_id, exc_info=True,
                )

    # 5. Compute speaker stats
    speaker_stats = _compute_stats(remapped, req.total_audio_ms)

    # 6. Merge checkpoints for report context
    _checkpoint_context = _merge_checkpoints(all_checkpoints)

    # 7. Generate report via synthesizer (reuses existing LLM pipeline)
    report = None
    if transcript and speaker_stats:
        try:
            from app.schemas import EvidenceRef, Memo, SpeakerStat, SynthesizeReportRequest
            memos = [Memo(**m) if isinstance(m, dict) else m for m in req.memos]
            stats_objs = [SpeakerStat(**s) if isinstance(s, dict) else s for s in req.stats]
            evidence = [EvidenceRef(**e) if isinstance(e, dict) else e for e in req.evidence]

            synth_req = SynthesizeReportRequest(
                session_id=req.session_id,
                transcript=transcript,
                memos=memos,
                stats=stats_objs if stats_objs else [
                    SpeakerStat(**s) for s in speaker_stats
                ],
                evidence=evidence,
                locale=req.locale,
            )
            synth_result = await asyncio.to_thread(
                runtime.report_synthesizer.synthesize, synth_req,
            )
            report = synth_result.model_dump() if hasattr(synth_result, "model_dump") else synth_result
        except Exception:
            logger.warning(
                "V1 finalize: report synthesis failed for session=%s",
                req.session_id, exc_info=True,
            )

    finalize_ms = int((time.monotonic() - t0) * 1000)

    # 8. Cleanup Redis
    try:
        redis_state.cleanup_session(req.session_id)
    except Exception as exc:
        logger.warning("V1 finalize: Redis cleanup failed: %s", exc)

    return FinalizeResponseV1(
        session_id=req.session_id,
        transcript=transcript,
        speaker_stats=speaker_stats,
        report=report,
        total_increments=total_increments,
        total_audio_ms=req.total_audio_ms,
        finalize_time_ms=finalize_ms,
        metrics={
            "redis_utterances": len(all_utterances),
            "redis_checkpoints": len(all_checkpoints),
            "redis_profiles": len(all_profiles),
            "merged_speaker_count": len(merged_profiles),
            "finalize_ms": finalize_ms,
            "recompute_requested": recompute_requested,
            "recompute_succeeded": recompute_succeeded,
            "recompute_skipped": recompute_skipped,
            "recompute_failed": recompute_failed,
        },
    )
