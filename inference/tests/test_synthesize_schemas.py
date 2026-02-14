from app.schemas import (
    Memo,
    SynthesizeReportRequest,
    RubricDimension,
    RubricTemplate,
    SessionContext,
    StageDescription,
    MemoSpeakerBinding,
    HistoricalSummary,
    SynthesisContextMeta,
    ReportQualityMeta,
    TranscriptUtterance,
    SpeakerStat,
    EvidenceRef,
    AnalysisEvent,
)


def test_memo_accepts_stage_fields() -> None:
    memo = Memo(
        memo_id="m1",
        created_at_ms=1000,
        type="observation",
        tags=["leadership"],
        text="Alice showed strong leadership",
        stage="Q1: System Design",
        stage_index=1,
    )
    assert memo.stage == "Q1: System Design"
    assert memo.stage_index == 1


def test_memo_stage_fields_optional() -> None:
    memo = Memo(
        memo_id="m2",
        created_at_ms=2000,
        type="observation",
        tags=[],
        text="Good answer",
    )
    assert memo.stage is None
    assert memo.stage_index is None


def test_synthesize_request_minimal() -> None:
    req = SynthesizeReportRequest(
        session_id="s-test",
        transcript=[
            TranscriptUtterance(
                utterance_id="u1",
                stream_role="students",
                speaker_name="Alice",
                text="Hello world",
                start_ms=0,
                end_ms=3000,
                duration_ms=3000,
            )
        ],
        memos=[
            Memo(
                memo_id="m1",
                created_at_ms=1000,
                type="observation",
                tags=[],
                text="Good intro",
            )
        ],
        evidence=[
            EvidenceRef(
                evidence_id="e_000001",
                time_range_ms=[0, 3000],
                utterance_ids=["u1"],
                speaker_key="Alice",
                quote="Hello world",
                confidence=0.8,
            )
        ],
        stats=[
            SpeakerStat(
                speaker_key="Alice",
                speaker_name="Alice",
                talk_time_ms=3000,
                turns=1,
            )
        ],
        events=[],
    )
    assert req.session_id == "s-test"
    assert req.rubric is None
    assert req.session_context is None
    assert req.free_form_notes is None
    assert req.memo_speaker_bindings == []
    assert req.historical == []
    assert req.stages == []


def test_synthesize_request_with_full_context() -> None:
    req = SynthesizeReportRequest(
        session_id="s-full",
        transcript=[
            TranscriptUtterance(
                utterance_id="u1",
                stream_role="students",
                speaker_name="Alice",
                text="Let me explain the architecture",
                start_ms=0,
                end_ms=5000,
                duration_ms=5000,
            )
        ],
        memos=[
            Memo(
                memo_id="m1",
                created_at_ms=2000,
                type="observation",
                tags=["structure"],
                text="Alice\u7684\u67b6\u6784\u9610\u8ff0\u6e05\u6670",
                stage="Q1: System Design",
                stage_index=1,
            )
        ],
        evidence=[
            EvidenceRef(
                evidence_id="e_000001",
                time_range_ms=[0, 5000],
                utterance_ids=["u1"],
                speaker_key="Alice",
                quote="Let me explain the architecture",
                confidence=0.85,
            )
        ],
        stats=[
            SpeakerStat(
                speaker_key="Alice",
                speaker_name="Alice",
                talk_time_ms=5000,
                turns=1,
            )
        ],
        events=[],
        rubric=RubricTemplate(
            template_name="Technical Assessment",
            dimensions=[
                RubricDimension(name="System Design", weight=1.5),
                RubricDimension(name="Communication", description="Clarity of expression"),
            ],
        ),
        session_context=SessionContext(
            mode="1v1",
            interviewer_name="Bob",
            position_title="Senior Engineer",
            stage_descriptions=[
                StageDescription(stage_index=0, stage_name="Intro"),
                StageDescription(stage_index=1, stage_name="Q1: System Design"),
            ],
        ),
        free_form_notes="Candidate seemed confident overall.",
        memo_speaker_bindings=[
            MemoSpeakerBinding(
                memo_id="m1",
                extracted_names=["Alice"],
                matched_speaker_keys=["Alice"],
                confidence=1.0,
            )
        ],
        historical=[
            HistoricalSummary(
                session_id="s-prev",
                date="2026-02-10",
                summary="Previous interview showed solid fundamentals",
                strengths=["Clear communication"],
                risks=["Needs more depth in system design"],
            )
        ],
        stages=["Intro", "Q1: System Design", "Q2: Behavioral", "Wrap-up"],
    )
    assert req.rubric is not None
    assert len(req.rubric.dimensions) == 2
    assert req.session_context is not None
    assert req.session_context.mode == "1v1"
    assert req.free_form_notes == "Candidate seemed confident overall."
    assert len(req.memo_speaker_bindings) == 1
    assert len(req.historical) == 1
    assert len(req.stages) == 4


def test_report_quality_meta_new_sources() -> None:
    meta = ReportQualityMeta(
        generated_at="2026-02-14T12:00:00Z",
        report_source="llm_synthesized",
    )
    assert meta.report_source == "llm_synthesized"

    meta2 = ReportQualityMeta(
        generated_at="2026-02-14T12:00:00Z",
        report_source="llm_synthesized_truncated",
    )
    assert meta2.report_source == "llm_synthesized_truncated"

    meta3 = ReportQualityMeta(
        generated_at="2026-02-14T12:00:00Z",
        report_source="memo_first_fallback",
    )
    assert meta3.report_source == "memo_first_fallback"


def test_synthesis_context_meta() -> None:
    ctx = SynthesisContextMeta(
        rubric_used=True,
        free_notes_used=True,
        historical_sessions_count=2,
        name_bindings_count=3,
        stages_count=4,
        transcript_tokens_approx=4500,
        transcript_truncated=False,
    )
    assert ctx.rubric_used is True
    assert ctx.transcript_tokens_approx == 4500
