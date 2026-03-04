"""V1 Incremental Pipeline schemas with explicit versioning.

All schemas include "v": 1 for contract stability.
Breaking changes require v2 with dual-version support for 1 release cycle.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# Strongly-typed sub-models for V1 responses
# ---------------------------------------------------------------------------


class UtteranceV1(BaseModel):
    """A single utterance in the V1 transcript."""
    id: str = ""
    text: str = ""
    speaker: str = ""
    speaker_name: str | None = None
    start_ms: int = 0
    end_ms: int = 0
    confidence: float = 1.0
    language: str = ""
    increment_index: int = -1
    recomputed: bool = False


class SpeakerProfileV1(BaseModel):
    """Speaker profile with embedding centroid."""
    speaker_id: str
    display_name: str | None = None
    centroid: list[float] = Field(default_factory=list)
    sample_count: int = 0
    total_speech_ms: int = 0


class SpeakerStatV1(BaseModel):
    """Per-speaker talk-time statistics."""
    speaker_key: str
    speaker_name: str = ""
    talk_time_ms: int = 0
    turns: int = 0


class ProcessChunkMetricsV1(BaseModel):
    """Metrics for a process-chunk response."""
    processing_ms: int = 0
    diarization_ms: int = 0
    transcription_ms: int = 0
    was_written: bool = True
    idempotent_reject: bool = False


class FinalizeMetricsV1(BaseModel):
    """Metrics for a finalize response."""
    redis_utterances: int = 0
    redis_checkpoints: int = 0
    redis_profiles: int = 0
    merged_speaker_count: int = 0
    finalize_ms: int = 0
    recompute_requested: int = 0
    recompute_succeeded: int = 0
    recompute_skipped: int = 0
    recompute_failed: int = 0


class R2AudioRef(BaseModel):
    """Reference to an audio chunk stored in R2/S3."""
    key: str
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


class RecomputeSegment(BaseModel):
    """Audio segment for low-confidence utterance recomputation."""
    utterance_id: str
    increment_index: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    original_confidence: float = Field(ge=0.0, le=1.0)
    stream_role: Literal["mixed", "teacher", "students"] = "mixed"
    audio_b64: str
    audio_format: Literal["wav", "pcm_s16le"] = "wav"

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


class ProcessChunkRequestV1(BaseModel):
    """V1 process-chunk request with correct field names."""
    v: Literal[1]
    session_id: str = Field(min_length=1, max_length=128)
    increment_id: str = Field(min_length=1, max_length=128)
    increment_index: int = Field(ge=0)
    audio_b64: str
    audio_start_ms: int = Field(ge=0)
    audio_end_ms: int = Field(ge=0)
    language: str = "auto"
    run_analysis: bool = True
    locale: str = "en-US"


class ProcessChunkResponseV1(BaseModel):
    """V1 process-chunk response with metrics."""
    v: Literal[1] = 1
    session_id: str
    increment_id: str
    increment_index: int
    utterances: list[UtteranceV1 | dict] = Field(default_factory=list)
    speaker_profiles: list[SpeakerProfileV1 | dict] = Field(default_factory=list)
    speaker_mapping: dict[str, str] = Field(default_factory=dict)
    checkpoint: dict | None = None
    speakers_detected: int = 0
    stable_speaker_map: bool = False
    metrics: dict[str, Any] = Field(default_factory=dict)


class FinalizeRequestV1(BaseModel):
    """V1 finalize request — uses R2 refs instead of re-transmitting PCM."""
    v: Literal[1]
    session_id: str = Field(min_length=1, max_length=128)
    r2_audio_refs: list[R2AudioRef] = Field(default_factory=list)
    total_audio_ms: int = Field(ge=0)
    locale: str = "en-US"
    memos: list[dict] = Field(default_factory=list)
    stats: list[dict] = Field(default_factory=list)
    evidence: list[dict] = Field(default_factory=list)
    session_context: dict | None = None
    name_aliases: dict[str, list[str]] = Field(default_factory=dict)
    recompute_segments: list[RecomputeSegment] = Field(
        default_factory=list,
        description="Low-confidence audio segments for ASR recomputation",
    )


class FinalizeResponseV1(BaseModel):
    """V1 finalize response with metrics for SLA tracking."""
    v: Literal[1] = 1
    session_id: str
    transcript: list[UtteranceV1 | dict]
    speaker_stats: list[SpeakerStatV1 | dict]
    report: dict | None = None
    total_increments: int
    total_audio_ms: int
    finalize_time_ms: int
    metrics: dict[str, Any] = Field(default_factory=dict)
