"""Tests for ReportGenerator.regenerate_claim — validation, filtering, success path."""

from __future__ import annotations

import json

import pytest

from app.exceptions import ValidationError
from app.schemas import (
    EvidenceRef,
    RegenerateClaimRequest,
)
from app.services.report_generator import ReportGenerator


class MockLLMForRegenerate:
    """Returns a valid regenerated claim JSON."""

    def __init__(self, text: str = "Regenerated claim text.", refs: list[str] | None = None):
        self._text = text
        self._refs = refs

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
        parsed_prompt = json.loads(user_prompt)
        refs = self._refs
        if refs is None:
            # Use the first allowed evidence ID from the prompt
            refs = parsed_prompt.get("allowed_evidence_ids", [])[:1]
        return {
            "text": self._text,
            "evidence_refs": refs,
        }


def _evidence() -> list[EvidenceRef]:
    return [
        EvidenceRef(
            evidence_id="e_001",
            time_range_ms=[0, 5000],
            utterance_ids=["u1"],
            speaker_key="Alice",
            quote="First piece of evidence.",
            confidence=0.9,
        ),
        EvidenceRef(
            evidence_id="e_002",
            time_range_ms=[5000, 10000],
            utterance_ids=["u2"],
            speaker_key="Alice",
            quote="Second piece of evidence.",
            confidence=0.85,
        ),
        EvidenceRef(
            evidence_id="e_003",
            time_range_ms=[10000, 15000],
            utterance_ids=["u3"],
            speaker_key="Bob",
            quote="Third piece of evidence.",
            confidence=0.8,
        ),
    ]


def _regen_request(
    allowed_ids: list[str] | None = None,
    evidence: list[EvidenceRef] | None = None,
) -> RegenerateClaimRequest:
    ev = evidence if evidence is not None else _evidence()
    return RegenerateClaimRequest(
        session_id="s-regen-test",
        person_key="Alice",
        display_name="Alice",
        dimension="leadership",
        claim_type="strengths",
        claim_id="c_Alice_leadership_strengths_01",
        claim_text="Original claim text.",
        text_hint="Make it more specific.",
        allowed_evidence_ids=allowed_ids if allowed_ids is not None else ["e_001", "e_002"],
        evidence=ev,
    )


# ── Successful regeneration ─────────────────────────────────────────────────


def test_regenerate_claim_success() -> None:
    """Happy path: LLM returns valid text and refs within allowed set."""
    gen = ReportGenerator(llm=MockLLMForRegenerate())
    req = _regen_request()
    result = gen.regenerate_claim(req)

    assert result.session_id == "s-regen-test"
    assert result.person_key == "Alice"
    assert result.dimension == "leadership"
    assert result.claim_type == "strengths"
    assert result.claim.text == "Regenerated claim text."
    assert len(result.claim.evidence_refs) >= 1
    assert all(ref in {"e_001", "e_002"} for ref in result.claim.evidence_refs)


def test_regenerate_claim_preserves_claim_id() -> None:
    gen = ReportGenerator(llm=MockLLMForRegenerate())
    req = _regen_request()
    result = gen.regenerate_claim(req)
    assert result.claim.claim_id == "c_Alice_leadership_strengths_01"


def test_regenerate_claim_confidence_varies_by_type() -> None:
    """Strengths get 0.8 confidence, non-strengths get 0.72."""
    gen = ReportGenerator(llm=MockLLMForRegenerate())

    req_strengths = _regen_request()
    req_strengths.claim_type = "strengths"
    result_s = gen.regenerate_claim(req_strengths)
    assert result_s.claim.confidence == 0.8

    req_risks = _regen_request()
    req_risks.claim_type = "risks"
    result_r = gen.regenerate_claim(req_risks)
    assert result_r.claim.confidence == 0.72


# ── Validation: empty allowed_evidence_ids ──────────────────────────────────


def test_regenerate_empty_allowed_evidence_ids_raises_error() -> None:
    """Pydantic should reject empty allowed_evidence_ids before it reaches
    the method, but the method also validates."""
    gen = ReportGenerator(llm=MockLLMForRegenerate())
    # Build request manually to bypass Pydantic validation
    from pydantic import ValidationError as PydanticValidationError

    with pytest.raises(PydanticValidationError):
        _regen_request(allowed_ids=[])


def test_regenerate_whitespace_only_allowed_ids_raises_error() -> None:
    """allowed_evidence_ids with only whitespace strings should fail."""
    gen = ReportGenerator(llm=MockLLMForRegenerate())
    # Pydantic field_validator strips and filters, so [" ", ""] → [] → error
    from pydantic import ValidationError as PydanticValidationError

    with pytest.raises(PydanticValidationError):
        _regen_request(allowed_ids=["  ", ""])


# ── Validation: allowed ids not in evidence ─────────────────────────────────


def test_regenerate_missing_evidence_raises_error() -> None:
    """If allowed_evidence_ids reference IDs not in the evidence payload, error."""
    gen = ReportGenerator(llm=MockLLMForRegenerate())
    req = _regen_request(
        allowed_ids=["e_001", "e_999"],  # e_999 doesn't exist in evidence
    )
    with pytest.raises(ValidationError, match="not found in evidence"):
        gen.regenerate_claim(req)


# ── Evidence ref filtering ──────────────────────────────────────────────────


def test_regenerate_filters_refs_outside_allowed_set() -> None:
    """LLM may return evidence_refs outside the allowed set — those must
    be filtered out, keeping only valid refs."""
    # LLM returns e_001 (allowed) + e_003 (not in allowed set)
    gen = ReportGenerator(
        llm=MockLLMForRegenerate(refs=["e_001", "e_003", "e_002"])
    )
    req = _regen_request(allowed_ids=["e_001", "e_002"])
    result = gen.regenerate_claim(req)
    # e_003 should be filtered out
    assert "e_003" not in result.claim.evidence_refs
    assert "e_001" in result.claim.evidence_refs
    assert "e_002" in result.claim.evidence_refs


def test_regenerate_all_refs_outside_allowed_raises_error() -> None:
    """If LLM returns ONLY refs outside the allowed set, error."""
    gen = ReportGenerator(
        llm=MockLLMForRegenerate(refs=["e_999", "e_998"])
    )
    req = _regen_request(allowed_ids=["e_001", "e_002"])
    with pytest.raises(ValidationError, match="no valid evidence refs"):
        gen.regenerate_claim(req)


def test_regenerate_deduplicates_refs() -> None:
    """Duplicate evidence_refs from LLM should be deduplicated."""
    gen = ReportGenerator(
        llm=MockLLMForRegenerate(refs=["e_001", "e_001", "e_002", "e_002"])
    )
    req = _regen_request(allowed_ids=["e_001", "e_002"])
    result = gen.regenerate_claim(req)
    assert result.claim.evidence_refs == ["e_001", "e_002"]


def test_regenerate_caps_refs_at_three() -> None:
    """evidence_refs should be capped at 3."""
    gen = ReportGenerator(
        llm=MockLLMForRegenerate(refs=["e_001", "e_002", "e_003"])
    )
    req = _regen_request(
        allowed_ids=["e_001", "e_002", "e_003"],
    )
    result = gen.regenerate_claim(req)
    assert len(result.claim.evidence_refs) <= 3


# ── LLM failure modes ──────────────────────────────────────────────────────


def test_regenerate_empty_text_raises_error() -> None:
    """LLM returning empty text should raise ValidationError."""
    gen = ReportGenerator(llm=MockLLMForRegenerate(text=""))
    req = _regen_request()
    with pytest.raises(ValidationError, match="empty text"):
        gen.regenerate_claim(req)


class LLMReturningNoRefs:
    def generate_json(self, *, system_prompt: str, user_prompt: str) -> dict:
        return {"text": "Some claim", "evidence_refs": "not a list"}


def test_regenerate_non_list_refs_raises_error() -> None:
    """evidence_refs not being a list should raise ValidationError."""
    gen = ReportGenerator(llm=LLMReturningNoRefs())
    req = _regen_request()
    with pytest.raises(ValidationError, match="missing evidence_refs"):
        gen.regenerate_claim(req)
