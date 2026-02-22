"""Tier 2 batch processing API endpoints.

Provides three endpoints for background audio re-processing:
  - POST /batch/transcribe  — Whisper batch transcription
  - POST /batch/diarize     — pyannote full-pipeline diarization
  - POST /batch/process     — Combined transcribe + diarize + merge
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import get_settings
from app.services.whisper_batch import (
    WhisperBatchTranscriber,
    TranscriptResult,
    Utterance as WhisperUtterance,
    WordTimestamp as WhisperWord,
)
from app.services.diarize_full import (
    PyannoteFullDiarizer,
    DiarizeResult,
    SpeakerSegment,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/batch", tags=["batch"])

# ---------------------------------------------------------------------------
# Lazy service singletons (initialized on first request)
# ---------------------------------------------------------------------------

_whisper: WhisperBatchTranscriber | None = None
_diarizer: PyannoteFullDiarizer | None = None


def _get_whisper() -> WhisperBatchTranscriber:
    global _whisper
    if _whisper is None:
        settings = get_settings()
        _whisper = WhisperBatchTranscriber(
            model_size=settings.whisper_model_size,
            device=settings.whisper_device,
        )
    return _whisper


def _get_diarizer() -> PyannoteFullDiarizer:
    global _diarizer
    if _diarizer is None:
        settings = get_settings()
        _diarizer = PyannoteFullDiarizer(
            device=settings.pyannote_device,
            hf_token=settings.hf_token,
            model_id=settings.pyannote_model_id,
            embedding_model_id=settings.pyannote_embedding_model_id,
        )
    return _diarizer


# ---------------------------------------------------------------------------
# Audio download helper
# ---------------------------------------------------------------------------

_MAX_AUDIO_DOWNLOAD_BYTES = 500 * 1024 * 1024  # 500 MB
_DOWNLOAD_TIMEOUT_S = 120


async def _resolve_audio(audio_url: str) -> str:
    """Download audio from URL to a temp file, or return local path if it exists.

    Returns the path to the audio file on disk.
    """
    # Local file path
    if not audio_url.startswith(("http://", "https://")):
        if not Path(audio_url).exists():
            raise HTTPException(status_code=400, detail=f"Local audio file not found: {audio_url}")
        return audio_url

    # Remote URL — download to temp file
    suffix = ".wav"
    if "." in audio_url.split("?")[0].split("/")[-1]:
        ext = "." + audio_url.split("?")[0].rsplit(".", 1)[-1]
        if ext in (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".pcm"):
            suffix = ext

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
        raise HTTPException(status_code=502, detail=f"Failed to download audio: {exc}")


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------


class BatchTranscribeRequest(BaseModel):
    audio_url: str = Field(description="URL or local path to audio file")
    language: str = Field(default="auto", description="Language code or 'auto'")
    model: str = Field(default="large-v3", description="Whisper model size")


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


class MergedUtteranceOut(BaseModel):
    id: str
    speaker: str
    text: str
    start_ms: int
    end_ms: int
    words: list[WordTimestampOut] = Field(default_factory=list)
    language: str = ""
    confidence: float = 1.0


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
async def batch_transcribe(req: BatchTranscribeRequest) -> BatchTranscribeResponse:
    """Batch transcribe an audio file using Whisper."""
    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url

    try:
        whisper = _get_whisper()
        result: TranscriptResult = await asyncio.to_thread(
            whisper.transcribe, audio_path, language=req.language
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
async def batch_diarize(req: BatchDiarizeRequest) -> BatchDiarizeResponse:
    """Batch diarize an audio file using pyannote.audio full pipeline."""
    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url

    try:
        diarizer = _get_diarizer()
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
async def batch_process(req: BatchProcessRequest) -> BatchProcessResponse:
    """Combined batch processing: transcribe + diarize + merge.

    Downloads the audio once, runs Whisper transcription and pyannote
    diarization in parallel, then merges the results by aligning
    utterances to speaker segments.
    """
    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url

    try:
        whisper = _get_whisper()
        diarizer = _get_diarizer()

        # Run transcription and diarization in parallel
        transcript_result, diarize_result = await asyncio.gather(
            asyncio.to_thread(whisper.transcribe, audio_path, language=req.language),
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
