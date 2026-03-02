"""V1 Incremental Pipeline schemas with explicit versioning.

All schemas include "v": 1 for contract stability.
Breaking changes require v2 with dual-version support for 1 release cycle.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = 1


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
    utterances: list[dict] = Field(default_factory=list)
    speaker_profiles: list[dict] = Field(default_factory=list)
    speaker_mapping: dict[str, str] = Field(default_factory=dict)
    checkpoint: dict | None = None
    speakers_detected: int = 0
    stable_speaker_map: bool = False
    metrics: dict = Field(default_factory=dict)


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
    transcript: list[dict]
    speaker_stats: list[dict]
    report: dict | None = None
    total_increments: int
    total_audio_ms: int
    finalize_time_ms: int
    metrics: dict = Field(default_factory=dict)
