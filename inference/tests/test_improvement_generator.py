from __future__ import annotations

import pytest
from unittest.mock import MagicMock

from app.schemas import (
    ClaimImprovement,
    DimensionImprovement,
    DimensionPreset,
    ImprovementReport,
    ImprovementRequest,
    ImprovementResponse,
    OverallImprovement,
    TranscriptUtterance,
)
from app.services.improvement_generator import ImprovementGenerator


def _mock_llm_response() -> dict:
    return {
        "overall": {
            "summary": "候选人需要提升表达结构化能力",
            "key_points": ["加强 STAR 法则练习", "准备核心项目叙述"],
        },
        "dimensions": [
            {
                "dimension": "expression_structure",
                "advice": "建议使用 PREP 法则",
                "framework": "PREP: Point-Reason-Example-Point",
                "example_response": "I chose this program because...",
            }
        ],
        "claims": [
            {
                "claim_id": "c_001",
                "advice": "建议先说结论再展开",
                "suggested_wording": "I applied mathematical modeling to optimize...",
                "before_after": {
                    "before": "OK, actually, I used the mathematical model",
                    "after": "I applied mathematical modeling to optimize flavor profiles",
                },
            }
        ],
    }


def _make_request() -> ImprovementRequest:
    return ImprovementRequest(
        session_id="test_sess",
        report_json='{"per_person": [], "overall": {}}',
        transcript=[
            TranscriptUtterance(
                utterance_id="u1",
                speaker_name="Wei",
                text="OK, actually, I used the mathematical model",
                start_ms=0,
                end_ms=5000,
                duration_ms=5000,
            )
        ],
        interview_language="en",
        dimension_presets=[
            DimensionPreset(
                key="expression_structure",
                label_zh="表达结构",
                description="表达条理性",
            )
        ],
    )


class TestImprovementGenerator:
    def test_generate_returns_valid_response(self):
        llm = MagicMock()
        llm.generate_json.return_value = _mock_llm_response()
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        resp = gen.generate(_make_request())
        assert resp.session_id == "test_sess"
        assert resp.improvements.overall.summary
        assert len(resp.improvements.overall.key_points) == 2
        assert len(resp.improvements.dimensions) == 1
        assert resp.improvements.dimensions[0].dimension == "expression_structure"
        assert len(resp.improvements.claims) == 1
        assert resp.improvements.claims[0].before_after is not None

    def test_parse_handles_malformed_data(self):
        llm = MagicMock()
        # generate_json raises on invalid JSON, but _parse_response
        # handles malformed dict structures
        llm.generate_json.return_value = {"unexpected": "structure"}
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        resp = gen.generate(_make_request())
        # Should still produce a valid response (fallback or empty)
        assert resp.improvements.overall.summary == ""
        assert len(resp.improvements.dimensions) == 0

    def test_claim_without_before_after(self):
        data = {
            "overall": {"summary": "test", "key_points": []},
            "dimensions": [],
            "claims": [
                {"claim_id": "c1", "advice": "test advice", "suggested_wording": "try this"}
            ],
        }
        llm = MagicMock()
        llm.generate_json.return_value = data
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        resp = gen.generate(_make_request())
        assert resp.improvements.claims[0].before_after is None
        assert resp.improvements.claims[0].advice == "test advice"

    def test_prompt_includes_interview_language(self):
        llm = MagicMock()
        llm.generate_json.return_value = _mock_llm_response()
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        gen.generate(_make_request())
        call_args = llm.generate_json.call_args
        assert "en" in call_args.kwargs.get("system_prompt", "")

    def test_transcript_truncated_to_50(self):
        req = _make_request()
        # Add 60 utterances
        req.transcript = [
            TranscriptUtterance(
                utterance_id=f"u{i}",
                speaker_name="Wei",
                text=f"Utterance {i}",
                start_ms=i * 1000,
                end_ms=(i + 1) * 1000,
                duration_ms=1000,
            )
            for i in range(60)
        ]
        llm = MagicMock()
        llm.generate_json.return_value = _mock_llm_response()
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        gen.generate(req)
        call_args = llm.generate_json.call_args
        user_prompt = call_args.kwargs.get("user_prompt", "")
        # Should contain utterance 49 but not 50
        assert "Utterance 49" in user_prompt
        assert "Utterance 50" not in user_prompt
