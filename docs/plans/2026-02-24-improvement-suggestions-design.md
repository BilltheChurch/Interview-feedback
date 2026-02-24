# 改进建议功能设计文档

> 日期: 2026-02-24
> 状态: 已批准

## 背景

当前报告只有评价分析，缺少改进建议、回答思路和推荐用词。用户需要在看完评价后，获得具体可执行的改进方向。

## 设计目标

在评价报告基础上，增加三层改进建议：
- **整体级别**：综合性改进方向
- **维度级别**：每个维度的改进框架 + 示范回答
- **Claim 级别**：每条 risk/action 的具体建议 + before/after 对比

## 架构：两阶段生成（方案 B）

```
finalize 流程:
  ... → report 阶段 → persist 阶段 → 通知桌面端（报告可用）
                    ↓
              improvements 阶段（异步，不阻塞）
                    ↓
              persist improvements → 通知桌面端（建议可用）
```

- 第一阶段：评价报告生成（现有流程不变）
- 第二阶段：以评价报告 + 转录为输入，单独 LLM 调用生成改进建议
- 不阻塞报告推送，桌面端先显示报告，建议后续 fade-in

## 数据模型

```typescript
interface OverallImprovement {
  summary: string;           // 综合改进方向（中文）
  key_points: string[];      // 3-5 条核心建议要点（中文）
}

interface DimensionImprovement {
  dimension: string;         // 维度 key
  advice: string;            // 改进方向（中文）
  framework: string;         // 推荐框架/方法论（中文）
  example_response: string;  // 示范回答（面试语言）
}

interface ClaimImprovement {
  claim_id: string;          // 对应 claim ID
  advice: string;            // 改进建议（中文）
  suggested_wording: string; // 推荐用词（面试语言）
  before_after?: {
    before: string;          // 原始表达（转录原文）
    after: string;           // 改进表达（面试语言）
  };
}

interface ImprovementReport {
  overall: OverallImprovement;
  dimensions: DimensionImprovement[];
  claims: ClaimImprovement[];
}
```

### 关键决策
- Claim 级别只针对 risk 和 action（strength 不需要改进建议）
- before_after 可选（只在有明确不良表达时提供）
- 建议说明用中文，示范回答/推荐用词用面试原始语言

## 后端：Inference 新端点

### `POST /analysis/improvements`

**输入：**
```json
{
  "session_id": "sess_xxx",
  "report": { ... },
  "transcript": [ ... ],
  "interview_language": "en",
  "dimension_presets": [ ... ]
}
```

**输出：**
```json
{
  "overall": { "summary": "...", "key_points": ["..."] },
  "dimensions": [{ "dimension": "...", "advice": "...", "framework": "...", "example_response": "..." }],
  "claims": [{ "claim_id": "...", "advice": "...", "suggested_wording": "...", "before_after": { "before": "...", "after": "..." } }]
}
```

### LLM Prompt 策略

System prompt 核心指令：
- 角色：资深面试辅导专家
- 所有建议说明用中文
- 示范回答、推荐用词、before/after 用面试原始语言
- 每个维度给出具体框架/方法论（STAR、PREP、金字塔原理等）
- Claim 级别只对 risk 和 action 生成建议
- before 必须引用转录真实原文
- after 保持自然口语风格
- 不泛泛而谈，必须针对本次面试具体内容

## Worker 集成

在 finalize_v2 的 report 阶段完成后，异步触发 improvements 阶段：
- 调用 inference `/analysis/improvements` 端点
- 结果存入 R2 结果对象的 `improvements` 字段
- 通过 WebSocket 通知桌面端改进建议已就绪
- 失败不影响评价报告

## 桌面端 UI

### 整体改进建议（OverallCard 底部）
- 浅蓝色背景卡片，Key Findings 下方
- 显示 summary + key_points 列表
- 默认展开

### 维度改进建议（DimensionSummaryRow 展开区域底部）
- 浅蓝色左边框，Claims 列表下方
- 显示 advice + framework + example_response
- 随维度展开显示

### Claim 改进建议（ClaimCard 底部，仅 risk/action）
- 内联在 Claim 卡片中
- advice + suggested_wording
- before_after：before 用暗红色/删除线，after 用绿色高亮

### 加载状态
- 报告先到：正常显示评价
- 建议加载中：各位置 skeleton 占位
- 建议到达：fade-in 动画

## 涉及文件

### Inference
- `inference/app/schemas.py` — 新增 ImprovementReport 等 schema
- `inference/app/services/improvement_generator.py` — 新建：LLM 调用 + prompt
- `inference/app/main.py` — 注册 `/analysis/improvements` 路由
- `inference/tests/test_improvement_generator.py` — 新建测试

### Worker
- `edge/worker/src/types_v2.ts` — 新增 ImprovementReport 类型
- `edge/worker/src/index.ts` — improvements 阶段触发 + WebSocket 通知
- `edge/worker/src/finalize_v2.ts` — 异步 improvements 调用

### Desktop
- `desktop/src/views/FeedbackView.tsx` — OverallCard、DimensionSummaryRow、ClaimCard 集成改进建议显示
- `desktop/src/types/desktop-api.d.ts` — 可能需要新类型
- `desktop/src/stores/sessionStore.ts` — improvements 状态管理

## 不改什么

- Radar Chart
- Transcript Split View
- FootnoteRef / InlineEvidenceCard
- 现有评价组件结构
