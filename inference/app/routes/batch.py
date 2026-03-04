"""Tier 2 batch processing API endpoints.

Provides three endpoints for background audio re-processing:
  - POST /batch/transcribe  — Whisper batch transcription
  - POST /batch/diarize     — pyannote full-pipeline diarization
  - POST /batch/process     — Combined transcribe + diarize + merge
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.schemas import (
    MergedUtteranceOut as _SharedMergedUtteranceOut,
)
from app.schemas import (
    WordTimestampOut as _SharedWordTimestampOut,
)
from app.services.diarize_full import (
    DiarizeResult,
    SpeakerSegment,
)
from app.services.whisper_batch import (
    TranscriptResult,
)
from app.services.whisper_batch import (
    Utterance as WhisperUtterance,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/batch", tags=["batch"])

# ---------------------------------------------------------------------------
# Runtime-aware service accessors (DI via request.app.state.runtime)
# ---------------------------------------------------------------------------


def _get_diarizer_from_runtime(request: Request):
    """Get the diarizer from the app runtime (respects DIARIZATION_BACKEND config).

    Returns the runtime's incremental_processor diarizer which is configured
    based on DIARIZATION_BACKEND (pyannote or nemo) in config.py.
    """
    runtime = request.app.state.runtime
    return runtime.incremental_processor._diarizer


# ---------------------------------------------------------------------------
# Audio download helper
# ---------------------------------------------------------------------------

_MAX_AUDIO_DOWNLOAD_BYTES = 500 * 1024 * 1024  # 500 MB
_DOWNLOAD_TIMEOUT_S = 120


async def _resolve_audio(audio_url: str) -> str:
    """Download audio from URL to a temp file, or return local path if it exists.

    Supports:
      - Local file paths (within AUDIO_UPLOAD_DIR)
      - http:// / https:// remote URLs
      - data:audio/...;base64,... data URIs (used by Edge Worker Tier 2)

    Returns the path to the audio file on disk.
    """
    # Data URI — decode base64 inline audio (sent by Edge Worker Tier 2)
    if audio_url.startswith("data:"):
        import base64 as _b64

        # Format: data:<mime>;base64,<payload>
        try:
            header, payload = audio_url.split(",", 1)
        except ValueError:
            raise HTTPException(status_code=400, detail="Malformed data URI: missing comma separator")

        if ";base64" not in header:
            raise HTTPException(status_code=400, detail="Only base64-encoded data URIs are supported")

        # Determine file extension from MIME type
        mime = header.split(":")[1].split(";")[0] if ":" in header else ""
        ext_map = {
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/wave": ".wav",
            "audio/mp3": ".mp3",
            "audio/mpeg": ".mp3",
            "audio/flac": ".flac",
            "audio/ogg": ".ogg",
            "audio/pcm": ".pcm",
        }
        suffix = ext_map.get(mime, ".wav")

        try:
            raw = _b64.b64decode(payload)
        except Exception:
            raise HTTPException(status_code=400, detail="Failed to decode base64 audio data")

        if len(raw) > _MAX_AUDIO_DOWNLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Audio data too large")

        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        tmp.write(raw)
        tmp.close()
        return tmp.name

    # Local file path
    if not audio_url.startswith(("http://", "https://")):
        local_path = Path(audio_url).resolve()
        allowed_dir = Path(os.environ.get("AUDIO_UPLOAD_DIR", "/tmp/audio")).resolve()
        if not local_path.is_relative_to(allowed_dir):
            raise HTTPException(status_code=400, detail="Local file path not in allowed directory")
        if not local_path.exists():
            raise HTTPException(status_code=400, detail="Local audio file not found")
        return str(local_path)

    # Remote URL — download to temp file
    suffix = ".wav"
    if "." in audio_url.split("?")[0].split("/")[-1]:
        ext = "." + audio_url.split("?")[0].rsplit(".", 1)[-1]
        if ext in (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".pcm"):
            suffix = ext

    # Security: block internal/private network SSRF
    import ipaddress
    import socket
    from urllib.parse import urlparse
    parsed_url = urlparse(audio_url)
    if parsed_url.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http/https URLs allowed")
    hostname = parsed_url.hostname or ""

    def _is_private_hostname(h: str) -> bool:
        """Blocklist-based check for obviously private/internal hostnames."""
        if h in ("localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "::1", "[::1]"):
            return True
        if h.startswith(("10.", "192.168.")):
            return True
        parts = h.split(".")
        if len(parts) >= 2 and parts[0] == "172" and parts[1].isdigit():
            return 16 <= int(parts[1]) <= 31
        return False

    if _is_private_hostname(hostname):
        raise HTTPException(status_code=400, detail="Internal URLs not allowed")

    # DNS rebinding protection: resolve hostname and verify the IP is not private
    try:
        resolved_ips = socket.getaddrinfo(hostname, None)
        for _family, _type, _proto, _canonname, sockaddr in resolved_ips:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                raise HTTPException(status_code=400, detail="Internal URLs not allowed")
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="Could not resolve hostname")

    try:
        async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT_S) as client:
            resp = await client.get(audio_url)
            resp.raise_for_status()

            if len(resp.content) > _MAX_AUDIO_DOWNLOAD_BYTES:
                raise HTTPException(status_code=413, detail="Audio file too large")

            tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
            tmp.write(resp.content)
            tmp.close()
            return tmp.name
    except httpx.HTTPError as exc:
        logger.error("Failed to download audio from URL: %s", exc)
        raise HTTPException(status_code=502, detail="Failed to download audio")


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------


class BatchTranscribeRequest(BaseModel):
    audio_url: str = Field(description="URL or local path to audio file")
    language: str = Field(default="auto", description="Language code or 'auto'")
    model: str = Field(default="large-v3", description="Whisper model size")


# Re-export shared schemas (defined in app.schemas for cross-module use)
WordTimestampOut = _SharedWordTimestampOut
MergedUtteranceOut = _SharedMergedUtteranceOut


class UtteranceOut(BaseModel):
    id: str
    text: str
    start_ms: int
    end_ms: int
    words: list[WordTimestampOut] = Field(default_factory=list)
    language: str = ""
    confidence: float = 1.0


class BatchTranscribeResponse(BaseModel):
    utterances: list[UtteranceOut]
    language: str
    duration_ms: int
    processing_time_ms: int
    backend: str
    model: str


class BatchDiarizeRequest(BaseModel):
    audio_url: str = Field(description="URL or local path to audio file")
    num_speakers: int | None = Field(default=None, description="Exact speaker count hint")
    min_speakers: int | None = Field(default=None, description="Minimum speakers")
    max_speakers: int | None = Field(default=None, description="Maximum speakers")


class SpeakerSegmentOut(BaseModel):
    id: str
    speaker_id: str
    start_ms: int
    end_ms: int
    confidence: float = 1.0


class BatchDiarizeResponse(BaseModel):
    segments: list[SpeakerSegmentOut]
    embeddings: dict[str, list[float]]
    num_speakers: int
    duration_ms: int
    processing_time_ms: int
    global_clustering_done: bool = True


class BatchProcessRequest(BaseModel):
    audio_url: str = Field(description="URL or local path to audio file")
    num_speakers: int | None = Field(default=None, description="Speaker count hint")
    min_speakers: int | None = None
    max_speakers: int | None = None
    language: str = Field(default="auto", description="Language code or 'auto'")
    model: str = Field(default="large-v3", description="Whisper model size")


class SpeakerStatsOut(BaseModel):
    speaker_id: str
    total_duration_ms: int
    segment_count: int
    talk_ratio: float


class BatchProcessResponse(BaseModel):
    transcript: list[MergedUtteranceOut]
    speaker_stats: list[SpeakerStatsOut]
    language: str
    duration_ms: int
    transcription_time_ms: int
    diarization_time_ms: int
    total_processing_time_ms: int


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/transcribe", response_model=BatchTranscribeResponse)
async def batch_transcribe(req: BatchTranscribeRequest, request: Request) -> BatchTranscribeResponse:
    """Batch transcribe an audio file using the configured ASR backend."""
    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url

    try:
        asr = request.app.state.runtime.asr_backend
        result: TranscriptResult = await asyncio.to_thread(
            asr.transcribe, audio_path, language=req.language
        )

        utterances = [
            UtteranceOut(
                id=u.id,
                text=u.text,
                start_ms=u.start_ms,
                end_ms=u.end_ms,
                words=[
                    WordTimestampOut(
                        word=w.word, start_ms=w.start_ms, end_ms=w.end_ms, confidence=w.confidence
                    )
                    for w in u.words
                ],
                language=u.language,
                confidence=u.confidence,
            )
            for u in result.utterances
        ]

        return BatchTranscribeResponse(
            utterances=utterances,
            language=result.language,
            duration_ms=result.duration_ms,
            processing_time_ms=result.processing_time_ms,
            backend=result.backend,
            model=result.model_size,
        )
    finally:
        if is_temp:
            try:
                Path(audio_path).unlink(missing_ok=True)
            except OSError:
                pass


@router.post("/diarize", response_model=BatchDiarizeResponse)
async def batch_diarize(req: BatchDiarizeRequest, request: Request) -> BatchDiarizeResponse:
    """Batch diarize an audio file using the configured diarization backend."""
    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url

    try:
        diarizer = _get_diarizer_from_runtime(request)
        result: DiarizeResult = await asyncio.to_thread(
            diarizer.diarize,
            audio_path,
            num_speakers=req.num_speakers,
            min_speakers=req.min_speakers,
            max_speakers=req.max_speakers,
        )

        segments = [
            SpeakerSegmentOut(
                id=s.id,
                speaker_id=s.speaker_id,
                start_ms=s.start_ms,
                end_ms=s.end_ms,
                confidence=s.confidence,
            )
            for s in result.segments
        ]

        return BatchDiarizeResponse(
            segments=segments,
            embeddings=result.embeddings,
            num_speakers=result.num_speakers,
            duration_ms=result.duration_ms,
            processing_time_ms=result.processing_time_ms,
            global_clustering_done=result.global_clustering_done,
        )
    finally:
        if is_temp:
            try:
                Path(audio_path).unlink(missing_ok=True)
            except OSError:
                pass


@router.post("/process", response_model=BatchProcessResponse)
async def batch_process(req: BatchProcessRequest, request: Request) -> BatchProcessResponse:
    """Combined batch processing: transcribe + diarize + merge.

    Downloads the audio once, runs ASR transcription and pyannote
    diarization in parallel, then merges the results by aligning
    utterances to speaker segments.
    """
    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url

    try:
        asr = request.app.state.runtime.asr_backend
        diarizer = _get_diarizer_from_runtime(request)

        # Run transcription and diarization in parallel
        transcript_result, diarize_result = await asyncio.gather(
            asyncio.to_thread(asr.transcribe, audio_path, language=req.language),
            asyncio.to_thread(
                diarizer.diarize,
                audio_path,
                num_speakers=req.num_speakers,
                min_speakers=req.min_speakers,
                max_speakers=req.max_speakers,
            ),
        )

        # Merge: assign speakers to utterances by time overlap
        merged = _merge_transcript_diarization(transcript_result, diarize_result)

        # Compute speaker stats
        stats = _compute_speaker_stats(diarize_result)

        total_time = transcript_result.processing_time_ms + diarize_result.processing_time_ms

        return BatchProcessResponse(
            transcript=merged,
            speaker_stats=stats,
            language=transcript_result.language,
            duration_ms=max(transcript_result.duration_ms, diarize_result.duration_ms),
            transcription_time_ms=transcript_result.processing_time_ms,
            diarization_time_ms=diarize_result.processing_time_ms,
            total_processing_time_ms=total_time,
        )
    finally:
        if is_temp:
            try:
                Path(audio_path).unlink(missing_ok=True)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Merge logic
# ---------------------------------------------------------------------------


def _merge_transcript_diarization(
    transcript: TranscriptResult,
    diarization: DiarizeResult,
) -> list[MergedUtteranceOut]:
    """Assign a speaker to each utterance based on time overlap with diarization segments."""
    merged: list[MergedUtteranceOut] = []

    for utt in transcript.utterances:
        speaker = _find_best_speaker(utt, diarization.segments)
        merged.append(
            MergedUtteranceOut(
                id=utt.id,
                speaker=speaker,
                text=utt.text,
                start_ms=utt.start_ms,
                end_ms=utt.end_ms,
                words=[
                    WordTimestampOut(
                        word=w.word, start_ms=w.start_ms, end_ms=w.end_ms, confidence=w.confidence
                    )
                    for w in utt.words
                ],
                language=utt.language,
                confidence=utt.confidence,
            )
        )

    return merged


def _find_best_speaker(utterance: WhisperUtterance, segments: list[SpeakerSegment]) -> str:
    """Find the speaker with the most overlap for an utterance."""
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


def _compute_speaker_stats(diarization: DiarizeResult) -> list[SpeakerStatsOut]:
    """Compute per-speaker talk time statistics from diarization segments."""
    speaker_data: dict[str, dict] = {}

    for seg in diarization.segments:
        if seg.speaker_id not in speaker_data:
            speaker_data[seg.speaker_id] = {"total_duration_ms": 0, "segment_count": 0}
        speaker_data[seg.speaker_id]["total_duration_ms"] += seg.end_ms - seg.start_ms
        speaker_data[seg.speaker_id]["segment_count"] += 1

    total_duration = sum(d["total_duration_ms"] for d in speaker_data.values())

    stats = []
    for speaker_id, data in sorted(speaker_data.items()):
        ratio = data["total_duration_ms"] / total_duration if total_duration > 0 else 0.0
        stats.append(
            SpeakerStatsOut(
                speaker_id=speaker_id,
                total_duration_ms=data["total_duration_ms"],
                segment_count=data["segment_count"],
                talk_ratio=round(ratio, 4),
            )
        )

    return stats
