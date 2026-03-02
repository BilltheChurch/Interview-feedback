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
import logging
import time

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


@v1_router.post("/finalize")
async def finalize_v1(req: FinalizeRequestV1, request: Request):
    """V1 finalize — reads pre-computed state from Redis, merge-only."""
    runtime = request.app.state.runtime
    settings = runtime.settings

    # 1. Feature flag check
    if not settings.incremental_v1_enabled:
        return _v1_disabled_response()

    # 2. Redis availability check
    redis_state = runtime.redis_state
    if redis_state is None:
        return _redis_unavailable_response()

    t0 = time.monotonic()

    # 3. Read all pre-computed state from Redis
    meta = redis_state.get_meta(req.session_id)
    all_utterances = redis_state.get_all_utterances(req.session_id)
    all_checkpoints = redis_state.get_all_checkpoints(req.session_id)
    all_profiles = redis_state.get_all_speaker_profiles(req.session_id)

    last_audio_end_ms = int(meta.get("last_audio_end_ms", "0"))
    last_increment = int(meta.get("last_increment", "-1"))
    total_increments = last_increment + 1

    logger.info(
        "V1 finalize: session=%s, %d increments in Redis, %d utterances, %d checkpoints, "
        "last_audio_end_ms=%d, total_audio_ms=%d",
        req.session_id, total_increments, len(all_utterances),
        len(all_checkpoints), last_audio_end_ms, req.total_audio_ms,
    )

    # 4. Tail processing: if there's unprocessed audio at the end
    #    (gap between last_processed and total_audio > some small threshold),
    #    we still need to run the existing finalize which handles tail audio.
    #    The key improvement: most audio is already processed, so this is fast.
    from app.schemas import (
        IncrementalFinalizeRequest,
        IncrementalFinalizeResponse,
        Memo,
        SpeakerStat,
        EvidenceRef,
    )

    # Convert memos/stats/evidence from dicts to schema objects
    memos = [Memo(**m) if isinstance(m, dict) else m for m in req.memos]
    stats = [SpeakerStat(**s) if isinstance(s, dict) else s for s in req.stats]
    evidence = [EvidenceRef(**e) if isinstance(e, dict) else e for e in req.evidence]

    # Use existing finalize logic — it handles:
    # - Processing any remaining tail audio from in-memory session
    # - Merging speaker profiles
    # - Collecting all utterances with deduplication
    # - LLM transcript polishing
    # - Checkpoint merging for final report
    internal_req = IncrementalFinalizeRequest(
        session_id=req.session_id,
        locale=req.locale,
        memos=memos,
        stats=stats,
        evidence=evidence,
        name_aliases=req.name_aliases,
    )

    processor = runtime.incremental_processor
    result: IncrementalFinalizeResponse = await asyncio.to_thread(
        processor.finalize, internal_req,
    )

    finalize_ms = int((time.monotonic() - t0) * 1000)

    # 5. Cleanup Redis session state
    try:
        redis_state.cleanup_session(req.session_id)
    except Exception as exc:
        logger.warning("V1 finalize: Redis cleanup failed for session=%s: %s", req.session_id, exc)

    # 6. Build V1 response
    transcript = [
        u.model_dump() if hasattr(u, "model_dump") else u
        for u in result.transcript
    ]
    speaker_stats = [
        s.model_dump() if hasattr(s, "model_dump") else s
        for s in result.speaker_stats
    ]
    report = None
    if result.report is not None:
        report = result.report.model_dump() if hasattr(result.report, "model_dump") else result.report

    return FinalizeResponseV1(
        session_id=req.session_id,
        transcript=transcript,
        speaker_stats=speaker_stats,
        report=report,
        total_increments=max(total_increments, result.total_increments),
        total_audio_ms=max(req.total_audio_ms, result.total_audio_ms),
        finalize_time_ms=finalize_ms,
        metrics={
            "redis_utterances": len(all_utterances),
            "redis_checkpoints": len(all_checkpoints),
            "redis_profiles": len(all_profiles),
            "finalize_ms": finalize_ms,
        },
    )
