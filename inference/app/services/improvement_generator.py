from __future__ import annotations

import logging
import time

from app.schemas import (
    ClaimBeforeAfter,
    ClaimImprovement,
    DimensionImprovement,
    ImprovementReport,
    ImprovementRequest,
    ImprovementResponse,
    OverallImprovement,
)
from app.services.dashscope_llm import DashScopeLLM

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是一位资深面试辅导专家。根据已完成的面试评价报告和转录文本，为候选人生成具体、可执行的改进建议。

## 输出规则

1. 所有建议说明和分析用中文
2. 示范回答(example_response)、推荐用词(suggested_wording)、before_after 中的 after 必须使用面试原始语言: {interview_language}
3. before_after 中的 before 必须直接引用转录中的真实原文（不要改写）
4. 每个维度必须给出一个具体的框架或方法论（如 STAR、PREP、金字塔原理、MECE 等）
5. 只对 category 为 "risk" 或 "action" 的 claim 生成改进建议，跳过 "strength"
6. before_after 只在转录中有明确的"可改进表达"时提供，否则设为 null
7. after 应该是对 before 的直接改写，保持自然口语风格，不要过于书面化
8. 每条建议必须针对本次面试的具体内容，不要泛泛而谈

## 输出格式

返回严格 JSON：
{{
  "overall": {{
    "summary": "综合改进方向（中文，2-3句）",
    "key_points": ["建议1", "建议2", "建议3"]
  }},
  "dimensions": [
    {{
      "dimension": "维度key",
      "advice": "改进方向（中文）",
      "framework": "推荐框架名称和简要说明（中文）",
      "example_response": "示范回答片段（面试语言）"
    }}
  ],
  "claims": [
    {{
      "claim_id": "claim的id",
      "advice": "具体改进建议（中文）",
      "suggested_wording": "推荐的表达方式（面试语言）",
      "before_after": {{
        "before": "转录原文",
        "after": "改进后表达（面试语言）"
      }}
    }}
  ]
}}"""

USER_PROMPT_TEMPLATE = """## 评价报告

{report_json}

## 转录文本（前50条发言）

{transcript_excerpt}

## 维度配置

{dimension_presets}

请根据以上评价报告，生成改进建议。"""


class ImprovementGenerator:
    def __init__(self, llm: DashScopeLLM) -> None:
        self._llm = llm

    def generate(self, req: ImprovementRequest) -> ImprovementResponse:
        start = time.monotonic()

        # Build transcript excerpt (first 50 utterances to fit context)
        transcript_lines = []
        for u in req.transcript[:50]:
            transcript_lines.append(f"[{u.speaker_name or 'Unknown'}] {u.text}")
        transcript_excerpt = "\n".join(transcript_lines) if transcript_lines else "(no transcript)"

        # Build dimension presets text
        dim_lines = []
        for d in req.dimension_presets:
            dim_lines.append(f"- {d.key} ({d.label_zh}): {d.description}")
        dim_text = "\n".join(dim_lines) if dim_lines else "(default dimensions)"

        system = SYSTEM_PROMPT.format(interview_language=req.interview_language)
        user = USER_PROMPT_TEMPLATE.format(
            report_json=req.report_json[:8000],
            transcript_excerpt=transcript_excerpt,
            dimension_presets=dim_text,
        )

        data = self._llm.generate_json(system_prompt=system, user_prompt=user)
        elapsed_ms = int((time.monotonic() - start) * 1000)

        improvements = self._parse_response(data)

        return ImprovementResponse(
            session_id=req.session_id,
            improvements=improvements,
            model=self._llm.model_name,
            elapsed_ms=elapsed_ms,
        )

    def _parse_response(self, data: dict) -> ImprovementReport:
        """Parse LLM JSON dict into ImprovementReport, with fallback."""
        try:
            overall = OverallImprovement(
                summary=data.get("overall", {}).get("summary", ""),
                key_points=data.get("overall", {}).get("key_points", []),
            )

            dimensions = []
            for d in data.get("dimensions", []):
                dimensions.append(DimensionImprovement(
                    dimension=d.get("dimension", ""),
                    advice=d.get("advice", ""),
                    framework=d.get("framework", ""),
                    example_response=d.get("example_response", ""),
                ))

            claims = []
            for c in data.get("claims", []):
                ba = c.get("before_after")
                before_after = None
                if ba and isinstance(ba, dict) and ba.get("before") and ba.get("after"):
                    before_after = ClaimBeforeAfter(before=ba["before"], after=ba["after"])
                claims.append(ClaimImprovement(
                    claim_id=c.get("claim_id", ""),
                    advice=c.get("advice", ""),
                    suggested_wording=c.get("suggested_wording", ""),
                    before_after=before_after,
                ))

            return ImprovementReport(overall=overall, dimensions=dimensions, claims=claims)

        except (KeyError, TypeError) as exc:
            logger.warning("Failed to parse improvement response: %s", exc)
            return ImprovementReport(
                overall=OverallImprovement(summary="改进建议生成失败，请重试。", key_points=[]),
                dimensions=[],
                claims=[],
            )
