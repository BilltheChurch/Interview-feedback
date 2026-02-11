from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class AudioPayload(BaseModel):
    content_b64: str = Field(description="Base64-encoded audio bytes")
    format: Literal["wav", "pcm_s16le", "mp3", "m4a", "ogg", "flac"] = "wav"
    sample_rate: int | None = Field(default=None, ge=8000, le=96000)
    channels: int | None = Field(default=None, ge=1, le=2)


class ExtractEmbeddingRequest(BaseModel):
    audio: AudioPayload


class ExtractEmbeddingResponse(BaseModel):
    model_id: str
    model_revision: str
    embedding_dim: int
    embedding: list[float]


class ScoreRequest(BaseModel):
    audio_a: AudioPayload
    audio_b: AudioPayload


class ScoreResponse(BaseModel):
    model_id: str
    model_revision: str
    score: float


class RosterEntry(BaseModel):
    name: str
    email: str | None = None


class ParticipantProfile(BaseModel):
    name: str
    email: str | None = None
    centroid: list[float]
    sample_count: int = Field(default=1, ge=1)
    sample_seconds: float = Field(default=0, ge=0)
    status: Literal["collecting", "ready"] = "collecting"


class BindingMeta(BaseModel):
    participant_name: str
    source: Literal["enrollment_match", "name_extract", "manual_map"]
    confidence: float = Field(default=0, ge=-1, le=1)
    locked: bool = False
    updated_at: str


class ClusterState(BaseModel):
    cluster_id: str
    centroid: list[float]
    sample_count: int = Field(default=1, ge=1)
    bound_name: str | None = None


class SessionState(BaseModel):
    clusters: list[ClusterState] = Field(default_factory=list)
    bindings: dict[str, str] = Field(default_factory=dict)
    roster: list[RosterEntry] | None = None
    config: dict[str, str | int | float | bool] = Field(default_factory=dict)
    participant_profiles: list[ParticipantProfile] = Field(default_factory=list)
    cluster_binding_meta: dict[str, BindingMeta] = Field(default_factory=dict)


class ResolveRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    audio: AudioPayload
    asr_text: str | None = Field(default=None, max_length=4000)
    state: SessionState = Field(default_factory=SessionState)


class ResolveEvidence(BaseModel):
    sv_score: float
    threshold_low: float
    threshold_high: float
    segment_count: int
    name_hit: str | None = None
    roster_hit: bool | None = None
    profile_top_name: str | None = None
    profile_top_score: float | None = None
    profile_margin: float | None = None
    binding_source: str | None = None
    reason: str | None = None


class ResolveResponse(BaseModel):
    session_id: str
    cluster_id: str
    speaker_name: str | None = None
    decision: Literal["auto", "confirm", "unknown"]
    evidence: ResolveEvidence
    updated_state: SessionState


class EnrollRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    participant_name: str = Field(min_length=1, max_length=128)
    audio: AudioPayload
    state: SessionState = Field(default_factory=SessionState)


class EnrollResponse(BaseModel):
    session_id: str
    participant_name: str
    embedding_dim: int
    sample_seconds: float
    profile_updated: bool
    updated_state: SessionState


class DiarizeRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    audio: AudioPayload


class SpeakerTrack(BaseModel):
    speaker_id: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)

    @field_validator("end_ms")
    @classmethod
    def validate_end_ms(cls, value: int, info):
        start_ms = info.data.get("start_ms")
        if start_ms is not None and value <= start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        return value


class DiarizeResponse(BaseModel):
    session_id: str
    tracks: list[SpeakerTrack]


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    app_name: str
    model_id: str
    model_revision: str
    embedding_dim: int | None
    sv_t_low: float
    sv_t_high: float
    max_request_body_bytes: int
    rate_limit_enabled: bool
    rate_limit_requests: int
    rate_limit_window_seconds: int
    segmenter_backend: Literal["vad", "diarization"]
    diarization_enabled: bool


class ErrorResponse(BaseModel):
    detail: str
