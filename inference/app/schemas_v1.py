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
