"""Real-time ASR endpoint for per-window Whisper transcription.

Called by the Edge Worker for each audio window during recording.
Replaces cloud FunASR with local GPU-accelerated Whisper.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.config import get_settings
from app.services.whisper_batch import (
    WhisperBatchTranscriber,
    TranscriptResult,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/asr", tags=["asr"])

# ---------------------------------------------------------------------------
# Lazy service singleton (initialized on first request)
# ---------------------------------------------------------------------------

_whisper: WhisperBatchTranscriber | None = None


def _get_whisper() -> WhisperBatchTranscriber:
    global _whisper
    if _whisper is None:
        settings = get_settings()
        _whisper = WhisperBatchTranscriber(
            model_size=settings.whisper_model_size,
            device=settings.whisper_device,
        )
    return _whisper


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------


class TranscribeWindowRequest(BaseModel):
    pcm_base64: str = Field(description="Base64-encoded raw PCM16 audio data")
    sample_rate: int = Field(default=16000, description="Sample rate of the PCM data")
    language: str = Field(default="auto", description="Language code or 'auto' for detection")


class WordTimestampOut(BaseModel):
    word: str
    start_ms: int
    end_ms: int
    confidence: float = 1.0


class UtteranceOut(BaseModel):
    id: str
    text: str
    start_ms: int
    end_ms: int
    words: list[WordTimestampOut] = Field(default_factory=list)
    language: str = ""
    confidence: float = 1.0


class TranscribeWindowResponse(BaseModel):
    text: str
    utterances: list[UtteranceOut]
    language: str
    duration_ms: int
    processing_time_ms: int
    backend: str
    device: str


class AsrStatusResponse(BaseModel):
    available: bool
    device: str
    backend: str
    model: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _map_result(result: TranscriptResult, device: str) -> TranscribeWindowResponse:
    """Map a TranscriptResult to the API response schema."""
    utterances = [
        UtteranceOut(
            id=u.id,
            text=u.text,
            start_ms=u.start_ms,
            end_ms=u.end_ms,
            words=[
                WordTimestampOut(
                    word=w.word,
                    start_ms=w.start_ms,
                    end_ms=w.end_ms,
                    confidence=w.confidence,
                )
                for w in u.words
            ],
            language=u.language,
            confidence=u.confidence,
        )
        for u in result.utterances
    ]

    # Concatenate all utterance texts
    full_text = " ".join(u.text for u in result.utterances).strip()

    return TranscribeWindowResponse(
        text=full_text,
        utterances=utterances,
        language=result.language,
        duration_ms=result.duration_ms,
        processing_time_ms=result.processing_time_ms,
        backend=result.backend,
        device=device,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/transcribe-window", response_model=TranscribeWindowResponse)
async def transcribe_window(
    request: Request,
    sample_rate: int = Query(default=16000, description="Sample rate (used for binary mode)"),
    language: str = Query(default="auto", description="Language code (used for binary mode)"),
) -> TranscribeWindowResponse:
    """Transcribe a single audio window using Whisper.

    Supports two input modes:

    - **JSON mode**: POST with ``Content-Type: application/json`` and body
      ``{"pcm_base64": "<base64>", "sample_rate": 16000, "language": "auto"}``

    - **Binary mode**: POST with ``Content-Type: application/octet-stream``
      and raw PCM bytes in the request body. Use query params for
      ``sample_rate`` and ``language``.
    """
    content_type = request.headers.get("content-type", "")

    if "application/json" in content_type:
        # JSON mode
        try:
            body = await request.json()
        except (ValueError, TypeError, KeyError):
            raise HTTPException(status_code=400, detail="Invalid JSON body")

        req = TranscribeWindowRequest(**body)
        try:
            pcm_data = base64.b64decode(req.pcm_base64)
        except (ValueError, binascii.Error):
            raise HTTPException(status_code=400, detail="Invalid base64 in pcm_base64 field")

        if len(pcm_data) == 0:
            raise HTTPException(status_code=400, detail="Empty PCM data")

        sr = req.sample_rate
        lang = req.language

    else:
        # Binary mode
        pcm_data = await request.body()
        if len(pcm_data) == 0:
            raise HTTPException(status_code=400, detail="Empty PCM data")

        sr = sample_rate
        lang = language

    whisper = _get_whisper()
    result: TranscriptResult = await asyncio.to_thread(
        whisper.transcribe_pcm, pcm_data, sr, lang
    )

    return _map_result(result, device=whisper.device)


@router.get("/status", response_model=AsrStatusResponse)
async def asr_status() -> AsrStatusResponse:
    """Report Whisper ASR availability and configuration."""
    try:
        whisper = _get_whisper()
        return AsrStatusResponse(
            available=True,
            device=whisper.device,
            backend=whisper.backend,
            model=whisper.model_size,
        )
    except Exception as exc:
        logger.warning("ASR status check failed: %s", exc)
        return AsrStatusResponse(
            available=False,
            device="unknown",
            backend="unknown",
            model="unknown",
        )
