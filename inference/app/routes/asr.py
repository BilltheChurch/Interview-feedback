"""Real-time ASR endpoint for per-window and streaming transcription.

Called by the Edge Worker for each audio window during recording.
Supports configurable ASR backends (SenseVoice, Whisper) via runtime.

Streaming endpoint (/asr/stream) uses WebSocket for real-time transcription
via sherpa-onnx OnlineRecognizer (Paraformer trilingual).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import struct

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.services.whisper_batch import TranscriptResult

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/asr", tags=["asr"])

# Lazy-init streaming service (only when first WebSocket connects)
_streaming_service = None
_streaming_lock = asyncio.Lock()

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

    asr = request.app.state.runtime.asr_backend
    result: TranscriptResult = await asyncio.to_thread(
        asr.transcribe_pcm, pcm_data, sr, lang
    )

    return _map_result(result, device=asr.device)


@router.get("/status", response_model=AsrStatusResponse)
async def asr_status(request: Request) -> AsrStatusResponse:
    """Report ASR backend availability and configuration."""
    try:
        asr = request.app.state.runtime.asr_backend
        return AsrStatusResponse(
            available=True,
            device=asr.device,
            backend=asr.backend,
            model=asr.model_size,
        )
    except Exception as exc:
        logger.warning("ASR status check failed: %s", exc)
        return AsrStatusResponse(
            available=False,
            device="unknown",
            backend="unknown",
            model="unknown",
        )


# ---------------------------------------------------------------------------
# Streaming ASR via WebSocket
# ---------------------------------------------------------------------------


async def _get_streaming_service():
    """Lazy-init the streaming ASR service."""
    global _streaming_service
    if _streaming_service is not None:
        return _streaming_service

    async with _streaming_lock:
        if _streaming_service is not None:
            return _streaming_service

        from app.services.streaming_asr import StreamingASRService

        svc = StreamingASRService()
        if not svc.available:
            logger.warning("Streaming ASR model not found — /asr/stream will be unavailable")
            return None
        _streaming_service = svc
        return svc


@router.websocket("/stream")
async def asr_stream(websocket: WebSocket):
    """WebSocket endpoint for real-time streaming ASR.

    Protocol:
        1. Client connects, sends JSON: {"type": "start", "session_id": "xxx"}
        2. Client sends binary frames (raw PCM16 @ 16kHz mono, 1-second chunks)
        3. Server sends JSON: {"type": "partial"|"final", "text": "...", "segment_id": N}
        4. Client sends JSON: {"type": "stop"} to end session

    Replaces FunASR DashScope WebSocket — runs locally with zero latency.
    """
    await websocket.accept()

    svc = await _get_streaming_service()
    if svc is None:
        await websocket.send_json({
            "type": "error",
            "detail": "Streaming ASR model not available. Download the paraformer model first.",
        })
        await websocket.close(code=1011)
        return

    session = None
    session_id = None

    try:
        # Wait for start message
        start_msg = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
        if start_msg.get("type") != "start":
            await websocket.send_json({"type": "error", "detail": "Expected {type: 'start'}"})
            await websocket.close(code=1002)
            return

        session_id = start_msg.get("session_id", "unknown")
        sample_rate = start_msg.get("sample_rate", 16000)

        session = await asyncio.to_thread(svc.create_session, session_id)

        await websocket.send_json({
            "type": "ready",
            "session_id": session_id,
            "provider": svc.provider,
        })

        logger.info("Streaming ASR session started: %s", session_id)

        # Main loop: receive audio, send results
        while True:
            message = await websocket.receive()

            if "text" in message:
                # JSON control message
                data = json.loads(message["text"])
                if data.get("type") == "stop":
                    logger.info("Streaming ASR session stopped by client: %s", session_id)
                    break
                continue

            if "bytes" in message:
                # Binary PCM16 audio data
                pcm_bytes = message["bytes"]
                if len(pcm_bytes) == 0:
                    continue

                # Convert PCM16 bytes to float32 samples
                n_samples = len(pcm_bytes) // 2
                pcm16 = struct.unpack(f"<{n_samples}h", pcm_bytes)
                samples = [s / 32768.0 for s in pcm16]

                # Feed to recognizer (CPU-bound, offload to thread)
                results = await asyncio.to_thread(
                    session.feed_pcm, samples, sample_rate
                )

                # Send results back
                for r in results:
                    await websocket.send_json({
                        "type": "final" if r.is_final else "partial",
                        "text": r.text,
                        "segment_id": r.segment_id,
                        "end_ms": r.end_ms,
                        "is_final": r.is_final,
                    })

    except WebSocketDisconnect:
        logger.info("Streaming ASR client disconnected: %s", session_id)
    except asyncio.TimeoutError:
        logger.warning("Streaming ASR timeout waiting for start message")
        await websocket.close(code=1008)
    except Exception:
        logger.exception("Streaming ASR error for session %s", session_id)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        if session_id:
            svc.close_session(session_id)
