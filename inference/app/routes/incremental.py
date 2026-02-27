"""Incremental processing API endpoints.

Provides two endpoints for incremental audio processing during recording:
  - POST /incremental/process-chunk  — Process a single audio increment
  - POST /incremental/finalize       — Finalize and generate report
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Request

from app.schemas import (
    IncrementalFinalizeRequest,
    IncrementalFinalizeResponse,
    IncrementalProcessRequest,
    IncrementalProcessResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/incremental", tags=["incremental"])


@router.post("/process-chunk", response_model=IncrementalProcessResponse)
async def process_chunk(req: IncrementalProcessRequest, request: Request) -> IncrementalProcessResponse:
    """Process a single audio increment during recording.

    Called by the Worker every ~3 minutes with accumulated or chunked audio.
    Runs pyannote diarization + ASR in parallel, matches speakers to global
    profiles, and optionally runs LLM checkpoint analysis.
    """
    processor = request.app.state.runtime.incremental_processor
    return await asyncio.to_thread(processor.process_increment, req)


@router.post("/finalize", response_model=IncrementalFinalizeResponse)
async def finalize(req: IncrementalFinalizeRequest, request: Request) -> IncrementalFinalizeResponse:
    """Finalize incremental processing and generate the full report.

    Called by the Worker when recording ends. Processes any remaining
    audio, merges all checkpoints, and returns the complete transcript
    and feedback report.
    """
    processor = request.app.state.runtime.incremental_processor
    return await asyncio.to_thread(processor.finalize, req)
