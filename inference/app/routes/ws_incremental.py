"""WebSocket endpoint for incremental audio processing.

Protocol: StartFrame (JSON) -> PCMFrame[] (binary) -> EndFrame (JSON) -> ResultFrame (JSON)

Enforces:
- Schema version validation
- Idempotent increment_id (Redis HSETNX)
- Per-session serial lock (Redis SET NX)
- Frame sequence + CRC32 validation
"""
from __future__ import annotations

import io
import json
import logging
import tempfile
import wave

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from app.services.ws_protocol import (
    SCHEMA_VERSION,
    ErrorFrame,
    ResultFrame,
    decode_pcm_frame,
    validate_start_frame,
)

logger = logging.getLogger(__name__)


def register_ws_routes(app: FastAPI, runtime) -> None:
    """Register WebSocket routes — gated by INCREMENTAL_V1_ENABLED.

    When disabled, WS endpoint is not registered at all (returns 404 on connect attempt).
    """
    if not runtime.settings.incremental_v1_enabled:
        logger.info("WS incremental routes disabled (INCREMENTAL_V1_ENABLED=false)")
        return

    @app.websocket("/ws/v1/increment")
    async def ws_increment(ws: WebSocket):
        await ws.accept()
        try:
            await _handle_increment(ws, runtime)
        except WebSocketDisconnect:
            logger.info("WS client disconnected")
        except Exception as e:
            logger.error("WS error: %s", e, exc_info=True)
            try:
                await ws.send_text(
                    json.dumps(ErrorFrame(code="INTERNAL_ERROR", message=str(e)).to_dict())
                )
            except Exception:
                pass


# Keep create_ws_app for backward compatibility (standalone WS server mode)
def create_ws_app(runtime) -> FastAPI:
    """Create a standalone FastAPI app with the WS endpoint."""
    app = FastAPI(title="Inference WS")
    register_ws_routes(app, runtime)
    return app


async def _handle_increment(ws: WebSocket, runtime) -> None:
    redis_state = runtime.redis_state

    # Redis is required for WS endpoint (stateful processing)
    if redis_state is None:
        await ws.send_text(
            json.dumps(ErrorFrame(
                code="REDIS_UNAVAILABLE",
                message="Redis is required for WS incremental endpoint",
            ).to_dict())
        )
        return

    # 1. Receive StartFrame
    raw_start = await ws.receive_text()
    try:
        start_data = json.loads(raw_start)
        start = validate_start_frame(start_data)
    except (json.JSONDecodeError, ValueError) as e:
        await ws.send_text(
            json.dumps(ErrorFrame(code="INVALID_START_FRAME", message=str(e)).to_dict())
        )
        return

    sid = start.session_id
    inc_id = start.increment_id

    # 2. Idempotency pre-check (read-only -- marking happens inside atomic_write_increment)
    if redis_state.is_already_processed(sid, inc_id):
        await ws.send_text(
            json.dumps(ErrorFrame(
                code="DUPLICATE_INCREMENT",
                message=f"Increment {inc_id} already processed (idempotent reject)",
            ).to_dict())
        )
        return

    # 3. Acquire per-session lock (Constraint 3)
    lock_id = f"ws-{inc_id}"
    if not redis_state.acquire_session_lock(sid, lock_id):
        await ws.send_text(
            json.dumps(ErrorFrame(
                code="SESSION_LOCKED",
                message=f"Session {sid} is being processed by another request",
            ).to_dict())
        )
        return

    try:
        # 4. Receive PCM frames
        pcm_buffer = io.BytesIO()
        frames_received = 0
        bytes_received = 0

        while True:
            msg = await ws.receive()

            if "text" in msg and msg["text"]:
                # Could be EndFrame
                text_data = json.loads(msg["text"])
                if text_data.get("type") == "end":
                    break
                else:
                    await ws.send_text(
                        json.dumps(ErrorFrame(
                            code="UNEXPECTED_TEXT_FRAME",
                            message=f"Expected binary PCM or EndFrame, got: {text_data.get('type')}",
                        ).to_dict())
                    )
                    return

            if "bytes" in msg and msg["bytes"]:
                frame = decode_pcm_frame(msg["bytes"])
                if frame.frame_seq != frames_received:
                    await ws.send_text(
                        json.dumps(ErrorFrame(
                            code="FRAME_SEQ_GAP",
                            message=f"Expected frame_seq={frames_received}, got {frame.frame_seq}",
                        ).to_dict())
                    )
                    return
                pcm_buffer.write(frame.payload)
                frames_received += 1
                bytes_received += frame.payload_size

        # 5. Validate frame count (MUST match -- design doc hard constraint)
        if frames_received != start.total_frames:
            await ws.send_text(
                json.dumps(ErrorFrame(
                    code="FRAME_COUNT_MISMATCH",
                    message=(
                        f"Expected {start.total_frames} frames, "
                        f"received {frames_received}. Aborting."
                    ),
                ).to_dict())
            )
            return

        # 6. Write PCM to temp WAV
        pcm_data = pcm_buffer.getvalue()
        wav_path = _pcm_to_wav(
            pcm_data, start.sample_rate, start.channels, start.bit_depth
        )

        # 7. Process increment
        try:
            result = runtime.incremental_processor.process_increment_v2(
                session_id=sid,
                increment_id=inc_id,
                increment_index=start.increment_index,
                wav_path=wav_path,
                audio_start_ms=start.audio_start_ms,
                audio_end_ms=start.audio_end_ms,
                language=start.language,
                run_analysis=start.run_analysis,
            )
        finally:
            import os
            try:
                os.unlink(wav_path)
            except OSError:
                pass

        # 8. Atomic idempotent write to Redis (marking happens here, not before)
        was_written = redis_state.atomic_write_increment(
            session_id=sid,
            increment_id=inc_id,
            increment_index=start.increment_index,
            meta_updates={
                "last_increment": start.increment_index,
                "last_audio_end_ms": start.audio_end_ms,
            },
            speaker_profiles=result.get("speaker_profiles", {}),
            utterances=result.get("utterances", []),
            checkpoint=result.get("checkpoint"),
        )
        if not was_written:
            # Race condition: another request completed while we were processing.
            # Our result is discarded (the first writer wins).
            logger.warning(
                "Increment %s was written by another request (race), discarding",
                inc_id,
            )

        # 9. Send ResultFrame
        result_frame = ResultFrame(
            session_id=sid,
            increment_index=start.increment_index,
            utterances=result.get("utterances", []),
            speaker_profiles=result.get("speaker_profiles", []),
            checkpoint=result.get("checkpoint"),
            metrics={
                **result.get("metrics", {}),
                "frames_received": frames_received,
                "frames_expected": start.total_frames,
                "was_written": was_written,
            },
        )
        await ws.send_text(json.dumps(result_frame.to_dict()))

    finally:
        redis_state.release_session_lock(sid, lock_id)


def _pcm_to_wav(pcm_data: bytes, sr: int, channels: int, bit_depth: int) -> str:
    """Write raw PCM to a temporary WAV file. Returns path."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(tmp.name, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(bit_depth // 8)
        wf.setframerate(sr)
        wf.writeframes(pcm_data)
    return tmp.name
