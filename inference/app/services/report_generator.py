from __future__ import annotations

import json
from dataclasses import dataclass

from app.schemas import (
    AnalysisReportRequest,
    AnalysisReportResponse,
    OverallFeedback,
    PersonFeedback,
    ScorecardItem,
    SpeakerStat,
)
from app.services.dashscope_llm import DashScopeLLM


DIMENSIONS: tuple[str, ...] = (
    "leadership",
    "collaboration",
    "logic",
    "structure",
    "initiative",
)


@dataclass(slots=True)
class ReportGenerator:
    llm: DashScopeLLM

    @staticmethod
    def _stat_by_key(stats: list[SpeakerStat]) -> dict[str, SpeakerStat]:
        return {item.speaker_key: item for item in stats}

    @staticmethod
    def _default_score_from_stats(stat: SpeakerStat, dimension: str) -> int:
        base = 3
        if stat.turns >= 8:
            base += 1
        if stat.interruptions >= 3 and dimension in {"collaboration", "structure"}:
            base -= 1
        if stat.talk_time_ms <= 20_000 and dimension in {"initiative", "leadership"}:
            base -= 1
        return max(1, min(5, base))

    def _ensure_scorecard(
        self,
        *,
        raw_items: list[dict],
        stat: SpeakerStat,
        fallback_evidence_ids: list[str],
    ) -> list[ScorecardItem]:
        parsed: dict[str, ScorecardItem] = {}
        for raw in raw_items:
            try:
                item = ScorecardItem(**raw)
            except Exception:
                continue
            parsed[item.dimension] = item

        for dimension in DIMENSIONS:
            if dimension in parsed:
                continue
            parsed[dimension] = ScorecardItem(
                dimension=dimension,  # type: ignore[arg-type]
                score=self._default_score_from_stats(stat, dimension),
                rationale="基于发言时长、轮次与互动统计自动补全评分维度。",
                evidence_ids=fallback_evidence_ids[:2],
            )

        return [parsed[dimension] for dimension in DIMENSIONS]

    def _build_prompt(self, req: AnalysisReportRequest) -> tuple[str, str]:
        system_prompt = (
            "你是严谨的群面教练。输出必须是严格 JSON。"
            "语言：中文为主，证据 quote 保留英文原话。"
            "每位候选人必须包含5维评分：leadership/collaboration/logic/structure/initiative，分值1-5。"
            "结论必须基于 transcript、events、memos、evidence，避免臆测。"
        )
        payload = {
            "session_id": req.session_id,
            "stats": [item.model_dump() for item in req.stats],
            "memos": [item.model_dump() for item in req.memos],
            "events": [item.model_dump() for item in req.events],
            "evidence": [item.model_dump() for item in req.evidence],
            "transcript": [item.model_dump() for item in req.transcript[-200:]],
            "output_contract": {
                "overall": {
                    "summary_sections": [
                        {"topic": "Q1", "bullets": ["..."], "evidence_ids": ["..."]},
                        {"topic": "Q2", "bullets": ["..."], "evidence_ids": ["..."]},
                    ],
                    "team_dynamics": {
                        "highlights": ["..."],
                        "risks": ["..."],
                    },
                },
                "per_person": [
                    {
                        "person_key": "...",
                        "display_name": "...",
                        "scorecard": [
                            {
                                "dimension": "leadership",
                                "score": 4,
                                "rationale": "...",
                                "evidence_ids": ["..."],
                            }
                        ],
                        "strengths": ["..."],
                        "risks": ["..."],
                        "next_actions": ["..."],
                    }
                ],
            },
        }
        user_prompt = (
            "基于以下输入生成报告 JSON，不要输出 markdown。"
            "如果证据不足，明确写出 evidence_ids 为空并在rationale说明。\n"
            + json.dumps(payload, ensure_ascii=False)
        )
        return system_prompt, user_prompt

    def generate(self, req: AnalysisReportRequest) -> AnalysisReportResponse:
        system_prompt, user_prompt = self._build_prompt(req)
        raw = self.llm.generate_json(system_prompt=system_prompt, user_prompt=user_prompt)

        overall = OverallFeedback(**raw.get("overall", {}))
        stat_by_key = self._stat_by_key(req.stats)
        per_person: list[PersonFeedback] = []

        raw_people = raw.get("per_person", [])
        if not isinstance(raw_people, list):
            raw_people = []

        by_key: dict[str, dict] = {}
        for item in raw_people:
            if not isinstance(item, dict):
                continue
            person_key = str(item.get("person_key", "")).strip()
            if not person_key:
                continue
            by_key[person_key] = item

        for speaker_key, stat in stat_by_key.items():
            person_raw = by_key.get(speaker_key, {})
            display_name = str(person_raw.get("display_name", "")).strip() or (stat.speaker_name or speaker_key)
            scorecard = self._ensure_scorecard(
                raw_items=person_raw.get("scorecard", []) if isinstance(person_raw, dict) else [],
                stat=stat,
                fallback_evidence_ids=[item.evidence_id for item in req.evidence if item.speaker_key == speaker_key],
            )
            strengths = person_raw.get("strengths", []) if isinstance(person_raw, dict) else []
            risks = person_raw.get("risks", []) if isinstance(person_raw, dict) else []
            next_actions = person_raw.get("next_actions", []) if isinstance(person_raw, dict) else []

            per_person.append(
                PersonFeedback(
                    person_key=speaker_key,
                    display_name=display_name,
                    scorecard=scorecard,
                    strengths=[str(item) for item in strengths][:6],
                    risks=[str(item) for item in risks][:6],
                    next_actions=[str(item) for item in next_actions][:6],
                    stats=stat,
                )
            )

        return AnalysisReportResponse(
            session_id=req.session_id,
            overall=overall,
            per_person=per_person,
        )
