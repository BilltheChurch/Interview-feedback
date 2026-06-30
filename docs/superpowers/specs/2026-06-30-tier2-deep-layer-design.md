# Tier2 深度复盘层 — 云端化设计

> Status: Approved (brainstorm 2026-06-30)
> 前置: Phase R 链路鲁棒化 + R1 双流验证通过 + Phase Q 小项(tier2/cache teacher 泄漏、B3 preferred-name)已落 main(da9e5b2)/部署(ef150fd3)。
> 路线图: `docs/plans/2026-06-29-cloud-pipeline-hardening-roadmap-design.md` Phase Q。

## 北极星

在已经「快且深」的 Tier1 之上，异步追加一个**深度复盘/培优层**，对群面复盘真正有用——每人深挖、跨人对比、可执行培优、面试官视角——**硬约束 ≤5min**，且**不拖慢 Tier1 首屏**、**不回归 Tier1 已有质量**。

## 已锁定的决策（brainstorm）

- **D1 · 内容 = 全部 4 类深度**：① 跨人横向对比/排名 ② 可执行培优建议 ③ 更深的单人挖掘 ④ 面试官视角总结。（用户全选）
- **D2 · 架构 = 两层**：Tier1 即时不变；Tier2 异步深度、≤5min。（不做单层加厚——4 类深度全塞 Tier1 会拖慢大会议首屏甚至超时）
- **D3 · 触发 = 自动 + 手动**：Tier1 finalize 成功后自动排 Tier2；同时提供手动重跑端点+按钮。
- **D4 · 增量叠加，不重算**：Tier2 在 Tier1 的 `ResultV2` 上**新增可选字段**，保留 Tier1 的 per_person 分数/claim 原样（避免重算引入回归）。
- **D5 · 跳过死音频段**：不再重转音频（Whisper+Pyannote 的 `/batch/process` 已随 inference 退役）。Tier1 的 Speechmatics 转写已是当前最佳输入。

## 现状（勘察 explore-tier2，2026-06-30）

**已具备、可直接复用的「水管」**：
- DO alarm 调度（`index.ts` alarm() + `finalize-orchestrator.ts` 的 `STORAGE_KEY_TIER2_ALARM_TAG` + `setAlarm`）。
- `Tier2Status` 状态机（`types_v2.ts`：idle/pending/…/succeeded/failed + progress/warnings）。
- `GET /v1/sessions/{id}/tier2-status` 端点（router + DO action）。
- Desktop 轮询（`useFeedbackData.ts` 每 5s，succeeded 时重取报告→`tier2_ready`/"Enhanced Report"；`useDraftFeedback` 同）。
- `synthesizeReportInWorker`（DashScope，已绕开死掉的 inference）+ `buildSynthesizePayload` + 证据/stats 管线（`tier2-processor.ts` 已 import）。
- R2 覆写 + D1 + DO 缓存更新（`tier2-processor.ts` 末段）。

**死的/缺的**：
- `runTier2Job` Stage 1–2（拉 R2 PCM → POST `TIER2_BATCH_ENDPOINT=/batch/process`）端点已删，必失败/超时 → 当前总是回退到 Tier1 转写。
- 当前 Tier2 用**与 Tier1 完全相同的参数**重合成 → **零新增内容**。
- `TIER2_AUTO_TRIGGER=false` → 从不自动跑；无手动触发端点。
- `ResultV2` 无 `cross_person_comparison`/`coaching_plan`/`interviewer_perspective` 字段。
- llm-synthesizer 已有 `overall.question_analysis`(每题 A/B/C/D+更优答案) 和 `overall.interview_quality`(覆盖/追问/结构/建议)——**面试官视角已有半成品**，可深化复用。

## 架构

```
Tier1 finalize 成功
   │  (D3 自动) tier2Enabled && tier2AutoTrigger → 写 Tier2Status=pending + setAlarm
   │  (D3 手动) POST /v1/sessions/{id}/tier2-trigger → 同上
   ▼
DO alarm() → runTier2Job(sessionId)            [≤5min 预算]
   │  1. 载入 Tier1 ResultV2 (R2)               ← 跳过死音频 batch (D5)
   │  2. 深度 LLM 调用 synthesizeDeepLayerInWorker (qwen3.7-plus, Tier2 专用 timeout)
   │       输入: Tier1 transcript + evidence + stats + per_person + roster + rubric
   │       输出: 4 类深度 (D1)  —— NO per_person
   │  3. 把深度字段【叠加】到 Tier1 ResultV2 (D4，per_person/overall/stats 逐字保留)
   │  4. 覆写 R2 + D1 + DO 缓存; Tier2Status=succeeded
   ▼
Desktop 轮询 tier2-status=succeeded → 重取 → 渲染深度区块 ("Enhanced Report")
```

### `runTier2Job` 改写（具体指令）
现有 `runTier2Job`（`tier2-processor.ts`）的 Stage 1–2（列 R2 PCM → 拼 WAV → POST `/batch/process`）**整段删除**（D5，端点已死）。新流程：
1. **载入 Tier1 result**：复用现有 Stage 3 的载入（`tier2-processor.ts:225-229` 已从 R2 读 `result_v2.json`）。若读不到 Tier1 result → Tier2Status=failed，**Tier1 报告原样不动**。
2. **深度调用**：`synthesizeDeepLayerInWorker(deepPayload, { timeoutMs: resolveTier2LlmTimeoutMs(env) })`。
3. **叠加**：`const tier2Result = { ...tier1Result, cross_person_comparison, coaching_plans, interviewer_perspective, tier2_meta }`。**不重建 per_person/overall/stats/evidence**（删除现有 Stage 4 的 stats 重算/buildSynthesizePayload/per_person 覆盖逻辑）。
4. 覆写 R2 + D1 + DO 缓存（复用现有末段）；Tier2Status=succeeded。

### 失败处理（不回归 Tier1，硬要求）
- 深度 LLM 调用失败/超时/输出不合 contract → **Tier2Status=failed，R2 里的 Tier1 ResultV2 保持原样不被覆写**（绝不能让 Tier2 失败损坏已有的 Tier1 报告）。Desktop 继续显示 Tier1 报告（轮询见到 failed 即停，不替换）。
- 部分字段缺失（如 LLM 只产出了 cross_person 没产出 coaching）→ 能叠加的叠加、缺的留空，记 warning，不算整体失败（深度字段都是 optional）。

### 输出 schema（`ResultV2` 新增可选字段，向后兼容）

```ts
// types_v2.ts — 均 optional，Tier1 不产出，Tier2 追加
interface ResultV2 {
  // …现有字段不变…
  cross_person_comparison?: CrossPersonComparison;   // D1①
  coaching_plans?: CoachingPlan[];                    // D1② 每人
  interviewer_perspective?: InterviewerPerspective;   // D1④
  // D1③ 更深单人挖掘 → 进 CoachingPlan.deep_analysis（避免再开一套 per_person）
  tier2_meta?: { generated_at: string; model: string; build_ms: number };
}

interface CrossPersonComparison {
  ranking: Array<{ person_key: string; display_name: string; rank: number; rationale: string; evidence_refs: string[] }>;
  by_dimension: Array<{ dimension: string; label_zh: string; ordered: string[]; note: string }>; // 每维度相对强弱
  summary: string;       // 横向总结(谁更适合/谁该淘汰，附理由)
}

interface CoachingPlan {
  person_key: string;
  display_name: string;
  deep_analysis: string;                 // D1③ 更深的行为模式/证据挖掘(3-5 句/维度)
  action_items: Array<{ area: string; suggestion: string; why: string; evidence_refs: string[] }>;
}

interface InterviewerPerspective {       // 深化已有 interview_quality + question_analysis
  decision_support: string;              // 录用建议+理由+风险
  key_moments: Array<{ time_ms: number; what: string; why_it_matters: string }>;
  follow_ups_missed: string[];           // 该追问没追问的点
  interview_quality_note: string;
}
```
（desktop `types.ts` 镜像同样的可选字段。）

### LLM 调用
- 模型 `qwen3.7-plus`，`enable_thinking:false`（沿用）。
- **这是一个 NEW、独立于 Tier1 的深度合成调用**（不复用 Tier1 的 `buildSynthesizePayload`/output_contract）。新增 `synthesizeDeepLayerInWorker(payload, { timeoutMs })`（在 `llm-synthesizer.ts`，与 `synthesizeReportInWorker` 并列），有**自己的 system prompt + output_contract**（见下），只产出 4 类深度字段。
- **per_person 绝不被这个调用触碰**：深度调用的 output_contract **不含 `per_person`**；Tier2 把 Tier1 的 `per_person`/`overall`/`stats` **逐字复制**到结果，只把 4 个深度字段叠加上去（D4）。
- **≤5min 的具体机制**：新增 `Env.TIER2_LLM_TIMEOUT_MS`（`config.ts` + `wrangler.jsonc`，默认 240000）；`synthesizeDeepLayerInWorker` 的 `timeoutMs` 参数从 `resolveTier2LlmTimeoutMs(env)` 取（不复用 Tier1 的 `INFERENCE_TIMEOUT_MS=120000`）。Tier1 路径的 timeout 不变。
- **先一次调用**产出 4 类深度（输入含 Tier1 全部 per_person + evidence + stats + transcript）。**若 R3 大会议(5-6人/30-60min)实测单调超 token/时间预算，再拆两调用**（cross-person+coaching / interviewer+deep）。深度调用用**独立的转写截断预算** `TIER2_TRANSCRIPT_MAX_TOKENS`（默认高于 Tier1 的 4000，如 12000；30-60min≈18k-36k transcript tokens，需更大窗口或分段）；deep 层 `max_tokens` 可调高。
- 证据引用沿用 Tier1 的 `sanitizeClaimEvidenceRefs`/`validateClaimEvidenceRefs` 门禁——深度字段里凡带 `evidence_refs` 的（ranking.rationale / action_items / key_moments）都要锚定真实 evidence id，无效 ref 剔除。

### 深度调用 output_contract（骨架，实现者据此细化 prompt）

```jsonc
// synthesizeDeepLayerInWorker 返回的 JSON envelope（NO per_person — 仅 4 类深度）
{
  "cross_person_comparison": {
    "ranking": [{ "person_key": "...", "display_name": "...", "rank": 1, "rationale": "...", "evidence_refs": ["e_..."] }],
    "by_dimension": [{ "dimension": "logic", "label_zh": "逻辑思维", "ordered": ["personA","personB"], "note": "..." }],
    "summary": "横向总结：谁更适合/谁该淘汰 + 理由"
  },
  "coaching_plans": [{
    "person_key": "...", "display_name": "...",
    "deep_analysis": "更深行为模式/证据挖掘(每维度 3-5 句)",
    "action_items": [{ "area": "<对齐 rubric dimension key>", "suggestion": "...", "why": "...", "evidence_refs": ["e_..."] }]
  }],
  "interviewer_perspective": {
    "decision_support": "录用建议+理由+风险",
    "key_moments": [{ "time_ms": 0, "what": "...", "why_it_matters": "...", "evidence_refs": ["e_..."] }],
    "follow_ups_missed": ["该追问没追问的点"],
    "interview_quality_note": "深化 overall.interview_quality"
  }
}
```
- prompt 输入打包：Tier1 的 `per_person`（含每维度 score/rationale/strengths/risks）+ `stats`（talk time/打断等）+ `evidence`（带 id+quote，供 refs 锚定）+ 截断后的 transcript + rubric dimension keys + roster/nameAliases + sessionContext。System prompt 要求：严格输出上述 JSON、`action_items.area` 必须取自给定 rubric dimension keys、所有 `evidence_refs` 必须是输入 evidence 的真实 id。

### 触发（D3）
- **自动**：`wrangler.jsonc TIER2_AUTO_TRIGGER=true`；走现有 finalize 成功→排 alarm 路径（已存在，仅开开关）。
- **手动**：新增 `POST /v1/sessions/{id}/tier2-trigger`（鉴权同其他写端点）→ 写 Tier2Status=pending + setAlarm；幂等（若已在跑则返回当前状态）。Desktop FeedbackView 加「重新生成深度复盘」按钮（仅在 Tier1 ready 后可见）。

### Desktop 渲染
- `CandidateComparison.tsx` **已是可用组件但渲染的是 Tier1 per-person 分数表**（prop `persons: {person_name, dimensions}`），与新 `cross_person_comparison`（`ranking{rank,rationale,evidence_refs}` + `by_dimension{ordered[],note}`）shape 不同。**需改造**该组件接受 `CrossPersonComparison` shape（新增 prop 或新组件），而非「启用 stub」。
- FeedbackView 新增 coaching（每人 `coaching_plans`）+ interviewer-perspective 区块。
- 轮询/替换逻辑已就绪（`tier2_ready`→"Enhanced Report"）；只需渲染新字段 + 手动重跑按钮接 `tier2-trigger`。
- 渲染遵循现有 UI（liquid-glass）；不做 Phase X 级重设计。

## 复用 vs 新建

| 复用(已存在) | 新建/改 |
|---|---|
| DO alarm 调度、Tier2Status、tier2-status 端点、desktop 轮询、R2/D1/缓存持久化、synthesizeReportInWorker（作并列参考）、证据门禁 | `runTier2Job` 改（删 Stage1-2 / 加深度调用 / 叠加输出）；`synthesizeDeepLayerInWorker` + 深度 system prompt + output_contract；`ResultV2` 4 个可选字段（+ desktop `types.ts` 镜像）；`POST /tier2-trigger` 端点 + UI 按钮；改造 `CandidateComparison.tsx`；FeedbackView coaching/interviewer 区块；`config.ts` 加 `TIER2_LLM_TIMEOUT_MS`/`TIER2_TRANSCRIPT_MAX_TOKENS` 及 resolver |

**部署步骤（wrangler.jsonc）**：`TIER2_AUTO_TRIGGER` 由 `"false"`→`"true"`；新增 `TIER2_LLM_TIMEOUT_MS`（默认 `"240000"`）、`TIER2_TRANSCRIPT_MAX_TOKENS`（默认 `"12000"`）。

## 不做（YAGNI）
- 不重转音频（Whisper/Pyannote 已退役；Speechmatics 转写够用）。删/绕 `runTier2Job` 的 PCM batch 段，不再维护 `TIER2_BATCH_ENDPOINT`。
- 不重算 Tier1 的 per_person 分数（只叠加深度，避免回归）。
- 暂不拆多次 LLM 调用（先一次；R3 实测超预算再拆）。
- 不做 Phase X 级 UI 重设计（深度区块用现有组件风格）。

## 验证
- **单测**：深度 prompt 的 output_contract 解析/校验、证据引用门禁对深度 claim、叠加逻辑（深度字段加上、per_person 不变）、`tier2-trigger` 幂等、auto-trigger 排程。
- **集成/live**：R3（30-60min 真实长会）实测 Tier2 端到端用时是否 ≤5min；深度报告质量（4 类内容是否有用、证据是否真锚定）。≤5min 是硬门。

## 开放项（R3 数据驱动）
- 单次深度调用在 5-6 人/30-60min 下的 token/时间是否够（不够则拆两调用）。
- ≤5min 预算是否需要更快模型或并行调用。
- 深度字段的确切渲染样式（待 desktop 实现时定，遵循现有 UI）。
