# 改进建议功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在评价报告基础上增加三层改进建议（整体/维度/Claim），通过两阶段 LLM 生成，异步推送到桌面端。

**Architecture:** Inference 新增 `/analysis/improvements` 端点 + ImprovementGenerator 服务。Worker 在 report persist 后异步触发 improvements 阶段。Desktop 在报告基础上异步加载并渲染改进建议。

**Tech Stack:** Python/FastAPI/Pydantic (inference), TypeScript/Cloudflare Workers (edge), React/TypeScript/Tailwind (desktop)

---

### Task 1: Inference — Schema 定义

**Files:**
- Modify: `inference/app/schemas.py`

**Step 1: 在 schemas.py 末尾添加改进建议相关类型**

在文件末尾（现有 `MergeCheckpointsRequest` 之后）添加：

```python
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


class ImprovementReport(BaseModel):
    overall: OverallImprovement
    dimensions: list[DimensionImprovement] = Field(default_factory=list)
    claims: list[ClaimImprovement] = Field(default_factory=list)


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
```

**Step 2: 验证构建**

Run: `cd inference && python -c "from app.schemas import ImprovementRequest, ImprovementResponse; print('OK')"`
Expected: OK

---

### Task 2: Inference — ImprovementGenerator 服务

**Files:**
- Create: `inference/app/services/improvement_generator.py`

**Step 1: 创建 ImprovementGenerator 类**

```python
from __future__ import annotations

import json
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

返回严格 JSON（不要 markdown 代码块）：
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
            transcript_lines.append(f"[{u.speaker}] {u.text}")
        transcript_excerpt = "\n".join(transcript_lines) if transcript_lines else "(no transcript)"

        # Build dimension presets text
        dim_lines = []
        for d in req.dimension_presets:
            dim_lines.append(f"- {d.key} ({d.label_zh}): {d.description}")
        dim_text = "\n".join(dim_lines) if dim_lines else "(default dimensions)"

        system = SYSTEM_PROMPT.format(interview_language=req.interview_language)
        user = USER_PROMPT_TEMPLATE.format(
            report_json=req.report_json[:8000],  # Truncate to avoid context overflow
            transcript_excerpt=transcript_excerpt,
            dimension_presets=dim_text,
        )

        raw = self._llm.chat(system_prompt=system, user_prompt=user)
        elapsed_ms = int((time.monotonic() - start) * 1000)

        improvements = self._parse_response(raw)

        return ImprovementResponse(
            session_id=req.session_id,
            improvements=improvements,
            model=self._llm.model_name,
            elapsed_ms=elapsed_ms,
        )

    def _parse_response(self, raw: str) -> ImprovementReport:
        """Parse LLM JSON response into ImprovementReport, with fallback."""
        try:
            # Strip markdown code fences if present
            text = raw.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

            data = json.loads(text)

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
                    from app.schemas import ClaimBeforeAfter
                    before_after = ClaimBeforeAfter(before=ba["before"], after=ba["after"])
                claims.append(ClaimImprovement(
                    claim_id=c.get("claim_id", ""),
                    advice=c.get("advice", ""),
                    suggested_wording=c.get("suggested_wording", ""),
                    before_after=before_after,
                ))

            return ImprovementReport(overall=overall, dimensions=dimensions, claims=claims)

        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            logger.warning("Failed to parse improvement response: %s", exc)
            return ImprovementReport(
                overall=OverallImprovement(summary="改进建议生成失败，请重试。", key_points=[]),
                dimensions=[],
                claims=[],
            )
```

**Step 2: 验证导入**

Run: `cd inference && python -c "from app.services.improvement_generator import ImprovementGenerator; print('OK')"`
Expected: OK

---

### Task 3: Inference — 注册路由 + Runtime

**Files:**
- Modify: `inference/app/main.py`
- Modify: `inference/app/runtime.py`

**Step 1: runtime.py 添加 ImprovementGenerator**

在 runtime.py 中：
1. 添加 import: `from app.services.improvement_generator import ImprovementGenerator`
2. 在 AppRuntime dataclass 中添加字段: `improvement_generator: ImprovementGenerator`
3. 在 build_runtime 中实例化: `improvement_generator=ImprovementGenerator(llm=report_llm)`

**Step 2: main.py 注册路由**

在 main.py 中：
1. 添加 schema import: `ImprovementRequest, ImprovementResponse`
2. 在 `synthesize_report` 路由之后添加：

```python
@app.post("/analysis/improvements", response_model=ImprovementResponse)
async def generate_improvements(req: ImprovementRequest) -> ImprovementResponse:
    return await asyncio.to_thread(runtime.improvement_generator.generate, req)
```

**Step 3: 验证**

Run: `cd inference && python -c "from app.main import app; print('OK')"`
Expected: OK

---

### Task 4: Inference — 测试

**Files:**
- Create: `inference/tests/test_improvement_generator.py`

**Step 1: 编写测试**

```python
from __future__ import annotations

import json
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


def _mock_llm_response() -> str:
    return json.dumps({
        "overall": {
            "summary": "候选人需要提升表达结构化能力",
            "key_points": ["加强 STAR 法则练习", "准备核心项目叙述"]
        },
        "dimensions": [
            {
                "dimension": "expression_structure",
                "advice": "建议使用 PREP 法则",
                "framework": "PREP: Point-Reason-Example-Point",
                "example_response": "I chose this program because..."
            }
        ],
        "claims": [
            {
                "claim_id": "c_001",
                "advice": "建议先说结论再展开",
                "suggested_wording": "I applied mathematical modeling to optimize...",
                "before_after": {
                    "before": "OK, actually, I used the mathematical model",
                    "after": "I applied mathematical modeling to optimize flavor profiles"
                }
            }
        ]
    })


def _make_request() -> ImprovementRequest:
    return ImprovementRequest(
        session_id="test_sess",
        report_json='{"per_person": [], "overall": {}}',
        transcript=[
            TranscriptUtterance(
                utterance_id="u1",
                speaker="Wei",
                text="OK, actually, I used the mathematical model",
                start_ms=0,
                end_ms=5000,
                confidence=0.9
            )
        ],
        interview_language="en",
        dimension_presets=[
            DimensionPreset(key="expression_structure", label_zh="表达结构", description="表达条理性")
        ],
    )


class TestImprovementGenerator:
    def test_generate_returns_valid_response(self):
        llm = MagicMock()
        llm.chat.return_value = _mock_llm_response()
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

    def test_parse_handles_malformed_json(self):
        llm = MagicMock()
        llm.chat.return_value = "not valid json {"
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        resp = gen.generate(_make_request())
        assert resp.improvements.overall.summary  # Fallback message
        assert len(resp.improvements.dimensions) == 0

    def test_parse_strips_markdown_fences(self):
        llm = MagicMock()
        llm.chat.return_value = "```json\n" + _mock_llm_response() + "\n```"
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        resp = gen.generate(_make_request())
        assert len(resp.improvements.dimensions) == 1

    def test_claim_without_before_after(self):
        data = json.dumps({
            "overall": {"summary": "test", "key_points": []},
            "dimensions": [],
            "claims": [{"claim_id": "c1", "advice": "test advice", "suggested_wording": "try this"}]
        })
        llm = MagicMock()
        llm.chat.return_value = data
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        resp = gen.generate(_make_request())
        assert resp.improvements.claims[0].before_after is None
        assert resp.improvements.claims[0].advice == "test advice"

    def test_prompt_includes_interview_language(self):
        llm = MagicMock()
        llm.chat.return_value = _mock_llm_response()
        llm.model_name = "test-model"
        gen = ImprovementGenerator(llm=llm)
        gen.generate(_make_request())
        call_args = llm.chat.call_args
        assert "en" in call_args.kwargs.get("system_prompt", "") or "en" in str(call_args)
```

**Step 2: 运行测试**

Run: `cd inference && python -m pytest tests/test_improvement_generator.py -v`
Expected: 5 tests PASS

---

### Task 5: Worker — 类型定义 + 异步触发

**Files:**
- Modify: `edge/worker/src/types_v2.ts`
- Modify: `edge/worker/src/index.ts`

**Step 1: types_v2.ts 添加 ImprovementReport 类型**

在 types_v2.ts 末尾添加：

```typescript
export interface ClaimBeforeAfter {
  before: string;
  after: string;
}

export interface ClaimImprovement {
  claim_id: string;
  advice: string;
  suggested_wording: string;
  before_after: ClaimBeforeAfter | null;
}

export interface DimensionImprovement {
  dimension: string;
  advice: string;
  framework: string;
  example_response: string;
}

export interface OverallImprovement {
  summary: string;
  key_points: string[];
}

export interface ImprovementReport {
  overall: OverallImprovement;
  dimensions: DimensionImprovement[];
  claims: ClaimImprovement[];
}
```

**Step 2: ResultV2 添加 improvements 字段**

在 ResultV2 接口中添加可选字段：
```typescript
improvements?: ImprovementReport;
```

**Step 3: index.ts — 在 persist 阶段后异步触发 improvements**

在 finalize 流程的 persist 成功后（约 line 5959，`updateFinalizeV2Status` succeeded 之后），添加异步 improvements 触发：

```typescript
// ── Async: generate improvement suggestions (non-blocking) ──
this.triggerImprovementGeneration(sessionId, resultV2, transcript, jobId).catch(err => {
  logger.warn(`[${sessionId}] improvements generation failed (non-blocking): ${(err as Error).message}`);
});
```

**Step 4: index.ts — 添加 triggerImprovementGeneration 方法**

在 InterviewSession 类中添加新方法：

```typescript
private async triggerImprovementGeneration(
  sessionId: string,
  resultV2: ResultV2,
  transcript: TranscriptUtterance[],
  jobId: string
): Promise<void> {
  const inferenceBase = this.env.INFERENCE_BASE_URL || "http://127.0.0.1:8000";
  const apiKey = this.env.INFERENCE_API_KEY || "";

  const sessionContext = (await this.ctx.storage.get("session_context")) as SessionContextMeta | undefined;
  const dimensionPresets = sessionContext?.dimension_presets ?? [];
  const interviewLanguage = "en"; // TODO: detect from transcript

  const reportJson = JSON.stringify({
    overall: resultV2.overall,
    per_person: resultV2.per_person,
    evidence: resultV2.evidence,
  });

  const body = JSON.stringify({
    session_id: sessionId,
    report_json: reportJson,
    transcript: transcript.slice(0, 50).map(u => ({
      utterance_id: u.utterance_id,
      speaker: u.speaker,
      text: u.text,
      start_ms: u.start_ms,
      end_ms: u.end_ms,
      confidence: u.confidence ?? 0.9,
    })),
    interview_language: interviewLanguage,
    dimension_presets: dimensionPresets,
  });

  const resp = await fetch(`${inferenceBase}/analysis/improvements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    throw new Error(`improvements API returned ${resp.status}`);
  }

  const data = await resp.json() as { improvements: ImprovementReport };

  // Merge improvements into resultV2 and re-persist
  resultV2.improvements = data.improvements;
  const resultKey = resultObjectKeyV2(sessionId);
  await this.env.RESULT_BUCKET.put(resultKey, JSON.stringify(resultV2), {
    httpMetadata: { contentType: "application/json" },
  });

  // Update feedback cache
  const cache = await this.loadFeedbackCache(sessionId);
  if (cache.report) {
    (cache.report as any).improvements = data.improvements;
    await this.storeFeedbackCache(cache);
  }

  // Notify connected clients
  this.broadcastToClients({
    type: "improvements_ready",
    session_id: sessionId,
  });
}
```

**Step 5: 验证构建**

Run: `cd edge/worker && npm run typecheck`
Expected: PASS

---

### Task 6: Worker — GET endpoint 返回 improvements

**Files:**
- Modify: `edge/worker/src/index.ts`

**Step 1: 确保 GET /v1/sessions/:id/result 返回 improvements**

The existing result endpoint already returns the full ResultV2 JSON from R2, which now includes `improvements`. No code change needed — just verify by checking that the result object includes improvements after generation.

**Step 2: 添加独立的 improvements 重新生成触发**

在 session 路由中添加：

```typescript
// POST /v1/sessions/:id/improvements — trigger improvement generation
```

Find the route handler section and add a handler for `POST /v1/sessions/:id/improvements` that calls `triggerImprovementGeneration`.

**Step 3: 验证构建**

Run: `cd edge/worker && npm run typecheck`
Expected: PASS

---

### Task 7: Desktop — 类型 + 状态

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` — types section (lines 69-140)

**Step 1: 添加改进建议类型**

在 FeedbackView.tsx 的类型定义区域添加：

```typescript
type ClaimBeforeAfter = {
  before: string;
  after: string;
};

type ClaimImprovement = {
  claim_id: string;
  advice: string;
  suggested_wording: string;
  before_after: ClaimBeforeAfter | null;
};

type DimensionImprovement = {
  dimension: string;
  advice: string;
  framework: string;
  example_response: string;
};

type OverallImprovement = {
  summary: string;
  key_points: string[];
};

type ImprovementReport = {
  overall: OverallImprovement;
  dimensions: DimensionImprovement[];
  claims: ClaimImprovement[];
};
```

**Step 2: FeedbackReport 类型添加 improvements**

在现有 `FeedbackReport` 类型中添加：
```typescript
improvements?: ImprovementReport;
```

**Step 3: normalizeApiReport 中提取 improvements**

在 `normalizeApiReport` 函数中，从 API 返回的 raw data 提取 `improvements` 字段并传入 FeedbackReport。

**Step 4: 验证构建**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

---

### Task 8: Desktop — OverallCard 整体改进建议 UI

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` — OverallCard

**Step 1: 在 OverallCard 中添加整体改进建议卡片**

在 Key Findings 之后、AI Dimension Suggestions 之前，添加：

```tsx
{/* Overall Improvement Suggestions */}
{report.improvements?.overall && (
  <div className="bg-blue-50/50 border border-blue-200/50 rounded-lg p-4 mt-4">
    <div className="flex items-center gap-2 mb-2">
      <Lightbulb className="w-4 h-4 text-blue-600" />
      <h3 className="text-sm font-semibold text-blue-900">改进建议</h3>
    </div>
    <p className="text-sm text-ink-secondary leading-relaxed mb-3">
      {report.improvements.overall.summary}
    </p>
    {report.improvements.overall.key_points.length > 0 && (
      <ul className="space-y-1.5">
        {report.improvements.overall.key_points.map((point, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-ink-secondary">
            <span className="text-blue-500 mt-0.5 shrink-0">•</span>
            {point}
          </li>
        ))}
      </ul>
    )}
  </div>
)}
```

Note: Import `Lightbulb` from lucide-react if not already imported.

**Step 2: 验证构建**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

---

### Task 9: Desktop — DimensionSummaryRow 维度改进建议

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` — DimensionSummaryRow

**Step 1: DimensionSummaryRow 接收 improvements prop**

添加 `dimensionImprovement?: DimensionImprovement` 到 props。

**Step 2: 在 Claims 列表下方渲染维度改进建议**

在 DimensionSummaryRow 展开区域（AnimatePresence 内），Claims 之后添加：

```tsx
{dimensionImprovement && (
  <div className="border-l-2 border-blue-300 bg-blue-50/30 rounded-r-lg p-3 ml-6 mt-2">
    <p className="text-sm text-ink-secondary leading-relaxed mb-2">
      {dimensionImprovement.advice}
    </p>
    {dimensionImprovement.framework && (
      <p className="text-xs text-blue-700 font-medium mb-2">
        推荐框架: {dimensionImprovement.framework}
      </p>
    )}
    {dimensionImprovement.example_response && (
      <div className="bg-white/60 rounded p-2 mt-1">
        <p className="text-xs text-secondary mb-1">示范回答:</p>
        <p className="text-sm text-ink italic leading-relaxed">
          "{dimensionImprovement.example_response}"
        </p>
      </div>
    )}
  </div>
)}
```

**Step 3: PersonFeedbackCard 传递 dimensionImprovement**

在 PersonFeedbackCard 中，遍历 dimensions 时查找匹配的 improvement：

```tsx
const dimImprovement = report.improvements?.dimensions.find(
  di => di.dimension === dim.dimension
);
```

传递给 DimensionSummaryRow: `dimensionImprovement={dimImprovement}`

**Step 4: 验证构建**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

---

### Task 10: Desktop — ClaimCard Claim 级别改进建议

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` — ClaimCard

**Step 1: ClaimCard 接收 improvement prop**

添加 `improvement?: ClaimImprovement` 到 ClaimCard props。

**Step 2: 在 Claim 卡片底部渲染改进建议**

在 ClaimCard 中，weak indicator 之后添加：

```tsx
{/* Claim improvement suggestion (only for risk/action) */}
{improvement && (
  <div className="border-t border-border/50 pt-2 mt-2">
    <p className="text-xs text-blue-700 font-medium mb-1">改进建议</p>
    <p className="text-sm text-ink-secondary leading-relaxed">{improvement.advice}</p>
    {improvement.suggested_wording && (
      <p className="text-sm text-ink italic mt-1">"{improvement.suggested_wording}"</p>
    )}
    {improvement.before_after && (
      <div className="mt-2 space-y-1">
        <div className="flex items-start gap-2">
          <span className="text-xs text-red-400 font-medium shrink-0 mt-0.5">Before</span>
          <p className="text-xs text-red-400/80 line-through">{improvement.before_after.before}</p>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-xs text-emerald-600 font-medium shrink-0 mt-0.5">After</span>
          <p className="text-xs text-emerald-700">{improvement.before_after.after}</p>
        </div>
      </div>
    )}
  </div>
)}
```

**Step 3: DimensionSummaryRow 传递 claim improvement**

在 DimensionSummaryRow 的 ClaimCard 渲染中，查找匹配：

```tsx
const claimImprovement = report.improvements?.claims.find(
  ci => ci.claim_id === claim.id
);
```

传递: `improvement={claimImprovement}`

**Step 4: 验证构建**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

---

### Task 11: 全量验证 + 提交

**Step 1: Inference 测试**

Run: `cd inference && python -m pytest tests/ -v`
Expected: All tests PASS

**Step 2: Worker 类型检查**

Run: `cd edge/worker && npm run typecheck`
Expected: PASS

**Step 3: Desktop 构建**

Run: `cd desktop && npx tsc --noEmit && npx vite build && npx vitest run`
Expected: All PASS

**Step 4: 提交**

```bash
git add inference/app/schemas.py \
       inference/app/services/improvement_generator.py \
       inference/app/runtime.py \
       inference/app/main.py \
       inference/tests/test_improvement_generator.py \
       edge/worker/src/types_v2.ts \
       edge/worker/src/index.ts \
       desktop/src/views/FeedbackView.tsx
git commit -m "feat: add improvement suggestions (two-stage LLM generation)"
```

**Step 5: 部署**

```bash
cd edge/worker && npm run deploy
cd ../desktop && npx vite build
```
