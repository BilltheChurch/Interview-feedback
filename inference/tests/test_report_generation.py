from app.schemas import (
    AnalysisEvent,
    AnalysisReportRequest,
    EvidenceRef,
    Memo,
    MemoAnchor,
    SpeakerStat,
    TranscriptUtterance,
)
from app.services.report_generator import ReportGenerator


class MockLLM:
    def generate_json(self, *, system_prompt: str, user_prompt: str):  # noqa: ARG002
        return {}


def test_report_generation_fills_all_dimensions_with_evidence_refs() -> None:
    generator = ReportGenerator(llm=MockLLM())
    req = AnalysisReportRequest(
        session_id="s-report",
        transcript=[
            TranscriptUtterance(
                utterance_id="u1",
                stream_role="students",
                speaker_name="Alice",
                cluster_id="c1",
                text="Let me summarize the constraints.",
                start_ms=0,
                end_ms=3000,
                duration_ms=3000,
                decision="auto",
            )
        ],
        memos=[
            Memo(
                memo_id="m1",
                created_at_ms=1000,
                type="observation",
                tags=["structure"],
                text="Alice总结了约束",
                anchors=MemoAnchor(mode="utterance", utterance_ids=["u1"]),
            )
        ],
        stats=[
            SpeakerStat(
                speaker_key="Alice",
                speaker_name="Alice",
                talk_time_ms=3000,
                turns=1,
                interruptions=0,
                interrupted_by_others=0,
            )
        ],
        evidence=[
            EvidenceRef(
                evidence_id="e1",
                time_range_ms=[0, 3000],
                utterance_ids=["u1"],
                speaker_key="Alice",
                quote="Let me summarize the constraints.",
                confidence=0.8,
            )
        ],
        events=[
            AnalysisEvent(
                event_id="ev1",
                event_type="summary",
                actor="Alice",
                target=None,
                time_range_ms=[0, 3000],
                utterance_ids=["u1"],
                quote="Let me summarize the constraints.",
                confidence=0.8,
            )
        ],
    )

    result = generator.generate(req)

    assert result.session_id == "s-report"
    assert len(result.per_person) == 1
    person = result.per_person[0]
    assert person.person_key == "Alice"
    assert len(person.dimensions) == 5
    assert {item.dimension for item in person.dimensions} == {
        "leadership",
        "collaboration",
        "logic",
        "structure",
        "initiative",
    }
    for dimension in person.dimensions:
        assert len(dimension.strengths) >= 1
        assert len(dimension.risks) >= 1
        assert len(dimension.actions) >= 1
        for claim in [*dimension.strengths, *dimension.risks, *dimension.actions]:
            assert claim.evidence_refs
    assert result.quality is not None
    assert result.quality.claim_count >= 15
    assert result.quality.needs_evidence_count == 0
