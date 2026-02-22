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


def test_report_generation_person_with_no_evidence_does_not_crash() -> None:
    """Regression: person resolved by name but with zero evidence must not
    raise ValueError — the fallback report path must stay resilient."""
    generator = ReportGenerator(llm=MockLLM())
    req = AnalysisReportRequest(
        session_id="s-no-evidence",
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
                text="Alice summarized constraints",
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
            ),
            SpeakerStat(
                speaker_key="Tina",
                speaker_name="Tina",
                talk_time_ms=0,
                turns=0,
                interruptions=0,
                interrupted_by_others=0,
            ),
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
        events=[],
    )

    # Must not raise ValueError
    result = generator.generate(req)

    assert result.session_id == "s-no-evidence"
    assert len(result.per_person) == 2

    # Alice should have full dimensions with evidence
    alice = next(p for p in result.per_person if p.person_key == "Alice")
    assert len(alice.dimensions) == 5

    # Tina should be present but with empty dimensions (no cross-person
    # evidence contamination — Tina has no personal evidence so she must
    # NOT receive Alice's evidence as fallback).
    tina = next(p for p in result.per_person if p.person_key == "Tina")
    assert tina.display_name == "Tina"
    assert len(tina.dimensions) == 5
    for dimension in tina.dimensions:
        assert dimension.strengths == []
        assert dimension.risks == []
        assert dimension.actions == []


def test_fallback_refs_no_cross_person_contamination() -> None:
    """P0-3 regression: a person with no evidence must get empty refs,
    never another person's evidence refs (cross-person contamination)."""
    generator = ReportGenerator(llm=MockLLM())
    req = AnalysisReportRequest(
        session_id="s-contamination",
        transcript=[
            TranscriptUtterance(
                utterance_id="u1",
                stream_role="students",
                speaker_name="Alice",
                cluster_id="c1",
                text="I think we should focus on the customer.",
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
                tags=["collaboration"],
                text="Alice提出了以客户为中心的建议",
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
            ),
            SpeakerStat(
                speaker_key="Bob",
                speaker_name="Bob",
                talk_time_ms=0,
                turns=0,
                interruptions=0,
                interrupted_by_others=0,
            ),
        ],
        evidence=[
            EvidenceRef(
                evidence_id="e-alice-1",
                time_range_ms=[0, 3000],
                utterance_ids=["u1"],
                speaker_key="Alice",
                quote="I think we should focus on the customer.",
                confidence=0.8,
            )
        ],
        events=[],
    )

    result = generator.generate(req)

    alice = next(p for p in result.per_person if p.person_key == "Alice")
    bob = next(p for p in result.per_person if p.person_key == "Bob")

    # Alice should have evidence-backed claims
    assert len(alice.dimensions) == 5
    alice_all_refs = []
    for dim in alice.dimensions:
        for claim in [*dim.strengths, *dim.risks, *dim.actions]:
            alice_all_refs.extend(claim.evidence_refs)
    assert any(ref == "e-alice-1" for ref in alice_all_refs)

    # Bob must NOT reference any of Alice's evidence — this is the core assertion
    assert len(bob.dimensions) == 5
    bob_all_refs = []
    for dim in bob.dimensions:
        for claim in [*dim.strengths, *dim.risks, *dim.actions]:
            bob_all_refs.extend(claim.evidence_refs)
    assert bob_all_refs == [], (
        f"Bob should have no evidence refs, but got: {bob_all_refs}"
    )


def test_report_generation_all_persons_no_evidence() -> None:
    """Edge case: every person has zero evidence and evidence list is empty.
    Report should still complete without error."""
    generator = ReportGenerator(llm=MockLLM())
    req = AnalysisReportRequest(
        session_id="s-empty",
        transcript=[],
        memos=[],
        stats=[
            SpeakerStat(
                speaker_key="Tina",
                speaker_name="Tina",
                talk_time_ms=0,
                turns=0,
                interruptions=0,
                interrupted_by_others=0,
            ),
        ],
        evidence=[],
        events=[],
    )

    result = generator.generate(req)

    assert result.session_id == "s-empty"
    assert len(result.per_person) == 1
    tina = result.per_person[0]
    assert tina.person_key == "Tina"
    assert len(tina.dimensions) == 5
    for dimension in tina.dimensions:
        assert dimension.strengths == []
        assert dimension.risks == []
        assert dimension.actions == []
