from __future__ import annotations

from typing import Any, Literal, Optional

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
    config: dict[str, Any] = Field(default_factory=dict)
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


class DeviceInfo(BaseModel):
    sv_device: str = "cpu"
    whisper_device: str = "auto"
    pyannote_device: str = "auto"
    whisper_model_size: str = "large-v3"


class ModelStatus(BaseModel):
    """Status of a single ML model required by the inference service."""
    name: str
    required: bool = True
    exists: bool = False
    size_bytes: int = 0
    loaded: bool = False
    provider: str = ""
    path: str = ""


class ModelsStatusResponse(BaseModel):
    """Aggregate model readiness report."""
    all_ready: bool = False
    models: list[ModelStatus] = Field(default_factory=list)
    total_size_bytes: int = 0


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
    devices: DeviceInfo | None = None


class ErrorResponse(BaseModel):
    detail: str


class MemoAnchor(BaseModel):
    mode: Literal["time", "utterance"]
    time_range_ms: list[int] | None = None
    utterance_ids: list[str] | None = None

    @field_validator("time_range_ms")
    @classmethod
    def validate_time_range_ms(cls, value: list[int] | None):
        if value is None:
            return value
        if len(value) != 2:
            raise ValueError("time_range_ms must contain exactly 2 values")
        if value[0] < 0 or value[1] < value[0]:
            raise ValueError("time_range_ms must be non-negative and ordered")
        return value


class Memo(BaseModel):
    memo_id: str
    created_at_ms: int = Field(ge=0)
    author_role: Literal["teacher"] = "teacher"
    type: Literal["observation", "evidence", "question", "decision", "score"]
    tags: list[str] = Field(default_factory=list)
    text: str = Field(min_length=1, max_length=3000)
    anchors: MemoAnchor | None = None
    stage: str | None = None
    stage_index: int | None = None


class TranscriptUtterance(BaseModel):
    utterance_id: str
    stream_role: Literal["teacher", "students", "mixed"] = "students"
    speaker_name: str | None = None
    cluster_id: str | None = None
    decision: Literal["auto", "confirm", "unknown"] | None = None
    text: str = Field(min_length=1, max_length=6000)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    duration_ms: int = Field(ge=0)

    @field_validator("end_ms")
    @classmethod
    def validate_utterance_end(cls, value: int, info):
        start_ms = info.data.get("start_ms")
        if start_ms is not None and value <= start_ms:
            raise ValueError("utterance end_ms must be greater than start_ms")
        return value


class SpeakerStat(BaseModel):
    speaker_key: str
    speaker_name: str | None = None
    talk_time_ms: int = Field(default=0, ge=0)
    turns: int = Field(default=0, ge=0)
    silence_ms: int = Field(default=0, ge=0)
    interruptions: int = Field(default=0, ge=0)
    interrupted_by_others: int = Field(default=0, ge=0)


class AnalysisEvent(BaseModel):
    event_id: str
    event_type: Literal["support", "interrupt", "summary", "decision", "silence"]
    actor: str | None = None
    target: str | None = None
    time_range_ms: list[int] = Field(default_factory=list)
    utterance_ids: list[str] = Field(default_factory=list)
    quote: str | None = None
    confidence: float = Field(default=0.0, ge=0, le=1)
    rationale: str | None = None

    @field_validator("time_range_ms")
    @classmethod
    def validate_event_time_range(cls, value: list[int]):
        if len(value) != 2:
            raise ValueError("time_range_ms must contain exactly 2 values")
        if value[0] < 0 or value[1] < value[0]:
            raise ValueError("time_range_ms must be non-negative and ordered")
        return value


class AnalysisEventsRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    transcript: list[TranscriptUtterance]
    memos: list[Memo] = Field(default_factory=list)
    stats: list[SpeakerStat] = Field(default_factory=list)
    locale: str = "zh-CN"


class AnalysisEventsResponse(BaseModel):
    session_id: str
    events: list[AnalysisEvent]


class EvidenceRef(BaseModel):
    evidence_id: str
    time_range_ms: list[int]
    utterance_ids: list[str] = Field(default_factory=list)
    speaker_key: str | None = None
    quote: str
    confidence: float = Field(default=0.0, ge=0, le=1)

    @field_validator("time_range_ms")
    @classmethod
    def validate_evidence_time_range(cls, value: list[int]):
        if len(value) != 2:
            raise ValueError("time_range_ms must contain exactly 2 values")
        if value[0] < 0 or value[1] < value[0]:
            raise ValueError("time_range_ms must be non-negative and ordered")
        return value


class DimensionClaim(BaseModel):
    claim_id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=3000)
    evidence_refs: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0, le=1)
    supporting_utterances: list[str] = Field(default_factory=list)

    @field_validator("evidence_refs")
    @classmethod
    def validate_evidence_refs(cls, value: list[str]):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]


class DimensionFeedback(BaseModel):
    dimension: str = Field(min_length=1, max_length=100)
    label_zh: str = Field(default="", max_length=100)
    score: float = Field(default=5.0, ge=0, le=10)
    score_rationale: str = Field(default="", max_length=1000)
    evidence_insufficient: bool = Field(default=False)
    not_applicable: bool = Field(default=False)
    strengths: list[DimensionClaim] = Field(default_factory=list)
    risks: list[DimensionClaim] = Field(default_factory=list)
    actions: list[DimensionClaim] = Field(default_factory=list)


class PersonSummary(BaseModel):
    strengths: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)


class PersonFeedbackItem(BaseModel):
    person_key: str = Field(min_length=1, max_length=200)
    display_name: str = Field(min_length=1, max_length=200)
    dimensions: list[DimensionFeedback] = Field(min_length=1)
    summary: PersonSummary = Field(default_factory=PersonSummary)


class SummarySection(BaseModel):
    topic: str = Field(min_length=1, max_length=120)
    bullets: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)


class TeamDynamics(BaseModel):
    highlights: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)


class KeyFinding(BaseModel):
    type: Literal["strength", "risk", "observation"] = "observation"
    text: str = Field(default="", max_length=1000)
    evidence_refs: list[str] = Field(default_factory=list)


class SuggestedDimension(BaseModel):
    key: str = Field(min_length=1, max_length=100)
    label_zh: str = Field(default="", max_length=100)
    reason: str = Field(default="", max_length=500)
    action: Literal["add", "replace", "mark_not_applicable"] = "add"
    replaces: str | None = None


class DimensionPreset(BaseModel):
    key: str = Field(min_length=1, max_length=100)
    label_zh: str = Field(default="", max_length=100)
    description: str = Field(default="", max_length=500)


class Recommendation(BaseModel):
    decision: str  # "recommend" | "tentative" | "not_recommend"
    confidence: float = Field(default=0.0, ge=0, le=1)
    rationale: str = ""
    context_type: str = "hiring"  # or "admission"


class QuestionAnalysis(BaseModel):
    question_text: str
    answer_utterance_ids: list[str] = Field(default_factory=list)
    answer_quality: str = ""  # A/B/C/D
    comment: str = ""
    related_dimensions: list[str] = Field(default_factory=list)
    # Enhanced analysis fields
    scoring_rationale: str = ""
    answer_highlights: list[str] = Field(default_factory=list)
    answer_weaknesses: list[str] = Field(default_factory=list)
    suggested_better_answer: str = ""


class InterviewQuality(BaseModel):
    coverage_ratio: float = Field(default=0.0, ge=0, le=1)
    follow_up_depth: int = Field(default=0, ge=0)
    structure_score: float = Field(default=0.0, ge=0, le=10)
    suggestions: str = ""


class OverallFeedback(BaseModel):
    # New v2 fields
    narrative: str = Field(default="", max_length=3000)
    narrative_evidence_refs: list[str] = Field(default_factory=list)
    key_findings: list[KeyFinding] = Field(default_factory=list)
    suggested_dimensions: list[SuggestedDimension] = Field(default_factory=list)
    # Enrichment fields (v3)
    recommendation: Optional[Recommendation] = None
    question_analysis: Optional[list[QuestionAnalysis]] = None
    interview_quality: Optional[InterviewQuality] = None
    # Legacy fields (kept for backward compatibility)
    summary_sections: list[SummarySection] = Field(default_factory=list)
    team_dynamics: TeamDynamics = Field(default_factory=TeamDynamics)


class AnalysisReportRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    transcript: list[TranscriptUtterance]
    memos: list[Memo] = Field(default_factory=list)
    stats: list[SpeakerStat] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    events: list[AnalysisEvent] = Field(default_factory=list)
    locale: str = "zh-CN"


class SynthesisContextMeta(BaseModel):
    rubric_used: bool = False
    free_notes_used: bool = False
    historical_sessions_count: int = 0
    name_bindings_count: int = 0
    stages_count: int = 0
    transcript_tokens_approx: int = 0
    transcript_truncated: bool = False


class ReportQualityMeta(BaseModel):
    generated_at: str
    build_ms: int = Field(default=0, ge=0)
    validation_ms: int = Field(default=0, ge=0)
    claim_count: int = Field(default=0, ge=0)
    invalid_claim_count: int = Field(default=0, ge=0)
    needs_evidence_count: int = Field(default=0, ge=0)
    report_source: Literal[
        "memo_first", "llm_enhanced", "llm_failed",
        "llm_synthesized", "llm_synthesized_truncated", "memo_first_fallback"
    ] | None = None
    report_model: str | None = None
    report_degraded: bool | None = None
    report_error: str | None = None
    synthesis_context: SynthesisContextMeta | None = None


class AnalysisReportResponse(BaseModel):
    session_id: str
    overall: OverallFeedback
    per_person: list[PersonFeedbackItem] = Field(default_factory=list, min_length=1)
    quality: ReportQualityMeta | None = None


class RegenerateClaimRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    person_key: str = Field(min_length=1, max_length=200)
    display_name: str | None = None
    dimension: str = Field(min_length=1, max_length=100)
    claim_type: Literal["strengths", "risks", "actions"]
    claim_id: str | None = None
    claim_text: str | None = None
    text_hint: str | None = None
    allowed_evidence_ids: list[str] = Field(min_length=1)
    evidence: list[EvidenceRef] = Field(min_length=1)
    transcript: list[TranscriptUtterance] = Field(default_factory=list)
    memos: list[Memo] = Field(default_factory=list)
    events: list[AnalysisEvent] = Field(default_factory=list)
    stats: list[SpeakerStat] = Field(default_factory=list)
    locale: str = "zh-CN"

    @field_validator("allowed_evidence_ids")
    @classmethod
    def validate_allowed_evidence_ids(cls, value: list[str]):
        refs = [item.strip() for item in value if isinstance(item, str) and item.strip()]
        if not refs:
            raise ValueError("allowed_evidence_ids must include at least one non-empty id")
        return refs


class RegenerateClaimResponse(BaseModel):
    session_id: str
    person_key: str
    dimension: str = Field(min_length=1, max_length=100)
    claim_type: Literal["strengths", "risks", "actions"]
    claim: DimensionClaim


class StageDescription(BaseModel):
    stage_index: int
    stage_name: str
    description: str | None = None


class RubricDimension(BaseModel):
    name: str
    description: str | None = None
    weight: float = 1.0


class RubricTemplate(BaseModel):
    template_name: str
    dimensions: list[RubricDimension]


class SessionContext(BaseModel):
    mode: Literal["1v1", "group"]
    interviewer_name: str | None = None
    position_title: str | None = None
    company_name: str | None = None
    interview_type: str | None = None
    stage_descriptions: list[StageDescription] = Field(default_factory=list)
    dimension_presets: list[DimensionPreset] = Field(default_factory=list)


class MemoSpeakerBinding(BaseModel):
    memo_id: str
    extracted_names: list[str]
    matched_speaker_keys: list[str]
    confidence: float


class HistoricalSummary(BaseModel):
    session_id: str
    date: str
    summary: str
    strengths: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)


class SynthesizeReportRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    transcript: list[TranscriptUtterance]
    memos: list[Memo] = Field(default_factory=list)
    free_form_notes: str | None = None
    evidence: list[EvidenceRef] = Field(default_factory=list)
    stats: list[SpeakerStat] = Field(default_factory=list)
    events: list[AnalysisEvent] = Field(default_factory=list)
    rubric: RubricTemplate | None = None
    session_context: SessionContext | None = None
    memo_speaker_bindings: list[MemoSpeakerBinding] = Field(default_factory=list)
    historical: list[HistoricalSummary] = Field(default_factory=list)
    stages: list[str] = Field(default_factory=list)
    locale: str = "zh-CN"
    name_aliases: dict[str, list[str]] = Field(default_factory=dict)
    stats_observations: list[str] = Field(default_factory=list)


# ── Incremental Checkpoint Schemas ─────────────────────────────────────────


class CheckpointSpeakerNote(BaseModel):
    speaker_key: str
    observations: list[str] = Field(default_factory=list)


class CheckpointDimensionSignal(BaseModel):
    dimension: str = Field(min_length=1, max_length=100)
    speaker_key: str
    signal: Literal["positive", "negative", "neutral"]
    note: str = ""


class CheckpointRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    checkpoint_index: int = Field(ge=0)
    utterances: list[TranscriptUtterance]
    memos: list[Memo] = Field(default_factory=list)
    stats: list[SpeakerStat] = Field(default_factory=list)
    locale: str = "zh-CN"


class CheckpointResponse(BaseModel):
    session_id: str
    checkpoint_index: int
    timestamp_ms: int = Field(ge=0)
    summary: str = ""
    per_speaker_notes: list[CheckpointSpeakerNote] = Field(default_factory=list)
    dimension_signals: list[CheckpointDimensionSignal] = Field(default_factory=list)


class MergeCheckpointsRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    checkpoints: list[CheckpointResponse] = Field(min_length=1)
    final_stats: list[SpeakerStat] = Field(default_factory=list)
    final_memos: list[Memo] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    locale: str = "zh-CN"


# ── Improvement Suggestions Schemas ───────────────────────────────────────


class ClaimBeforeAfter(BaseModel):
    before: str = Field(description="Original expression from transcript")
    after: str = Field(description="Improved expression in interview language")


class ClaimImprovement(BaseModel):
    claim_id: str = Field(min_length=1, max_length=64)
    advice: str = Field(description="Improvement advice in Chinese")
    suggested_wording: str = Field(default="", description="Recommended wording in interview language")
    before_after: ClaimBeforeAfter | None = None


class DimensionImprovement(BaseModel):
    dimension: str = Field(min_length=1, max_length=100)
    advice: str = Field(description="Improvement direction in Chinese")
    framework: str = Field(default="", description="Recommended framework/methodology in Chinese")
    example_response: str = Field(default="", description="Example response in interview language")


class OverallImprovement(BaseModel):
    summary: str = Field(description="Overall improvement summary in Chinese")
    key_points: list[str] = Field(default_factory=list, description="3-5 key improvement points")


class FollowUpQuestion(BaseModel):
    question: str
    purpose: str = ""
    related_claim_id: str | None = None


class ActionPlanItem(BaseModel):
    action: str
    related_claim_id: str | None = None
    practice_method: str = ""
    expected_outcome: str = ""


class ImprovementReport(BaseModel):
    overall: OverallImprovement
    dimensions: list[DimensionImprovement] = Field(default_factory=list)
    claims: list[ClaimImprovement] = Field(default_factory=list)
    follow_up_questions: list[FollowUpQuestion] = Field(default_factory=list)
    action_plan: list[ActionPlanItem] = Field(default_factory=list)


class ImprovementRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    report_json: str = Field(description="Serialized AnalysisReportResponse JSON")
    transcript: list[TranscriptUtterance] = Field(default_factory=list)
    interview_language: str = Field(default="en", description="Language for example responses")
    dimension_presets: list[DimensionPreset] = Field(default_factory=list)


class ImprovementResponse(BaseModel):
    session_id: str
    improvements: ImprovementReport
    model: str = ""
    elapsed_ms: int = 0


# ── Shared Batch/Incremental Schemas ───────────────────────────────────────


class WordTimestampOut(BaseModel):
    word: str
    start_ms: int
    end_ms: int
    confidence: float = 1.0


class MergedUtteranceOut(BaseModel):
    id: str
    speaker: str
    text: str
    start_ms: int
    end_ms: int
    words: list[WordTimestampOut] = Field(default_factory=list)
    language: str = ""
    confidence: float = 1.0


# ── Incremental Processing Schemas ─────────────────────────────────────────


class SpeakerProfileOut(BaseModel):
    """Speaker profile tracked across incremental processing."""
    speaker_id: str
    centroid: list[float]
    total_speech_ms: int = Field(default=0, ge=0)
    first_seen_increment: int = Field(default=0, ge=0)
    display_name: str | None = None


class IncrementalProcessRequest(BaseModel):
    """Request to process a single audio increment."""
    session_id: str = Field(min_length=1, max_length=128)
    increment_index: int = Field(ge=0)
    audio_b64: str = Field(description="Base64-encoded audio (WAV)")
    audio_format: Literal["wav", "pcm_s16le"] = "wav"
    audio_start_ms: int = Field(ge=0)
    audio_end_ms: int = Field(gt=0)
    num_speakers: int | None = Field(default=None, ge=1, le=20)
    run_analysis: bool = True
    language: str = "auto"
    locale: str = "zh-CN"
    previous_speaker_profiles: list[SpeakerProfileOut] | None = None
    memos: list[Memo] = Field(default_factory=list)
    stats: list[SpeakerStat] = Field(default_factory=list)


class IncrementalProcessResponse(BaseModel):
    """Response from processing a single audio increment."""
    session_id: str
    increment_index: int
    utterances: list[MergedUtteranceOut] = Field(default_factory=list)
    speaker_profiles: list[SpeakerProfileOut] = Field(default_factory=list)
    speaker_mapping: dict[str, str] = Field(
        default_factory=dict,
        description="local_speaker_id → global_speaker_id mapping",
    )
    checkpoint: CheckpointResponse | None = None
    diarization_time_ms: int = Field(default=0, ge=0)
    transcription_time_ms: int = Field(default=0, ge=0)
    total_processing_time_ms: int = Field(default=0, ge=0)
    speakers_detected: int = Field(default=0, ge=0)
    stable_speaker_map: bool = False


class IncrementalFinalizeRequest(BaseModel):
    """Request to finalize incremental processing and generate report."""
    session_id: str = Field(min_length=1, max_length=128)
    final_audio_b64: str | None = Field(
        default=None, description="Base64-encoded final audio chunk (WAV), if any unprocessed audio remains"
    )
    final_audio_format: Literal["wav", "pcm_s16le"] = "wav"
    final_audio_start_ms: int = Field(default=0, ge=0)
    final_audio_end_ms: int = Field(default=0, ge=0)
    memos: list[Memo] = Field(default_factory=list)
    stats: list[SpeakerStat] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    session_context: SessionContext | None = None
    locale: str = "zh-CN"
    name_aliases: dict[str, list[str]] = Field(default_factory=dict)


class IncrementalFinalizeResponse(BaseModel):
    """Response from incremental finalization with full report."""
    session_id: str
    transcript: list[MergedUtteranceOut] = Field(default_factory=list)
    speaker_stats: list[SpeakerStat] = Field(default_factory=list)
    report: AnalysisReportResponse | None = None
    total_increments: int = Field(default=0, ge=0)
    total_audio_ms: int = Field(default=0, ge=0)
    finalize_time_ms: int = Field(default=0, ge=0)
