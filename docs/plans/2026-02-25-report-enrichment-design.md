# Report Enrichment & UX Improvements Design

**Goal:** 统一规划报告内容丰富化（7 个新板块）+ 基础修复（4 项）+ 导出扩展，打包成一个大版本。

**受众：** 面试官（自我改进）、候选人（面试反馈）、决策者（录用/录取决策）。支持企业面试和大学招生两种场景。

---

## Section 1: 修复与基础改进

### 1.1 Upcoming Meetings 日期分组

**现状：** HomeView 的 UpcomingMeetings 组件平铺显示所有会议，不区分日期。跨天会议（如次日 8:00）与当天会议混在一起。

**方案：**
- 复用 HistoryView 已有的日期分组模式（`getDateGroup()`）
- 按日历日分组：Today / Tomorrow / 具体日期
- 每组内按时间排序
- 日期标题用灰色小字 + 分隔线

**文件：** `desktop/src/views/HomeView.tsx` (UpcomingMeetings 组件, lines 250-389)

**数据：** useCalendar hook 已获取 3 天窗口数据，前端分组即可，无后端改动。

### 1.2 Re-generate 按钮恢复下拉

**现状：** FeedbackHeader 仅在 `captionSource === 'acs-teams'` 时显示 SplitButton（report-only + full），非 ACS 模式只显示普通 Button。

**方案：** 所有模式统一使用 SplitButton：
- 主按钮：**Re-generate Report**（report-only）
- 下拉选项：**Full Re-analysis**（full）

**文件：** `desktop/src/views/FeedbackView.tsx` (FeedbackHeader, lines 1525-1539)

### 1.3 导出功能扩展

**现有：** Copy Text、Export Markdown、Export DOCX（disabled）

**新增：**
- **Export PDF** — 使用 Electron `webContents.printToPDF()` API。可控制纸张大小，无需打印对话框。需在 main.js 增加 IPC handler，preload.js 暴露 `exportPDF()` 方法。
- **Export to Slack** — 通过 Slack Incoming Webhook 发送格式化消息。用户在 Settings 中配置 Webhook URL（存 safeStorage）。消息格式：session 名称 + 摘要 + 各人评分 + 推荐结论。
- **Enable Export DOCX** — 取消 disabled，使用 Worker 端 `audio-utils.ts` 已有的 DOCX 生成能力。

**文件：**
- `desktop/src/views/FeedbackView.tsx` (FeedbackHeader export buttons, lines 1504-1516)
- `desktop/main.js` (新增 printToPDF IPC handler)
- `desktop/preload.js` (暴露 exportPDF)
- `desktop/src/views/SettingsView.tsx` (新增 Slack Webhook URL 配置)

### 1.4 双击编辑

**范围：** Overview narrative、Key Findings text、每个 claim text、person summary、改进建议文本。

**方案：**
- 新建 `InlineEditable` wrapper 组件
- 双击文本 → 就地变为 `<textarea>` → 自动 focus + 选中
- 失焦或 Cmd+Enter 保存 → Esc 取消
- 更新 localStorage 中 `ifb_session_data_{id}.report` 字段
- 增加 `report.user_edits[]` 记录：`{ field_path, original_value, edited_value, edited_at }`
- 导出时使用编辑后的值
- Re-generate 时弹窗提醒 "重新生成将覆盖手动编辑内容"

**文件：**
- 新建 `desktop/src/components/ui/InlineEditable.tsx`
- 修改 FeedbackView.tsx 中所有文本展示区域包裹 InlineEditable

---

## Section 2: 新增报告板块

### 2.1 Decision Recommendation（录用/录取建议）

**位置：** Overview 区域顶部，Key Findings 之前。

**内容：**
- 结论标签：推荐(Recommend) / 待定(Tentative) / 不推荐(Not Recommend) — 绿/黄/红 badge
- 置信度：基于 evidence 充分程度
- 一句话理由
- 场景自适应：根据 session 配置切换措辞（Hire ↔ Admit）

**数据：** `/analysis/synthesize` 返回新增 `recommendation` 字段：
```json
{
  "decision": "recommend" | "tentative" | "not_recommend",
  "confidence": 0.85,
  "rationale": "基于候选人在逻辑思维(9分)和协作能力(8.5分)上的突出表现...",
  "context_type": "hiring" | "admission"
}
```

**组件：** `RecommendationBadge` — 新建

### 2.2 Question-by-Question Breakdown（逐题分析）

**位置：** Overview 和 Person sections 之间，独立 section。

**内容：** 将面试按"问答回合"拆分，每个回合：
- 面试官问题原文
- 候选人回答质量评级（A/B/C/D）
- 简短点评（1-2 句）
- 关联的维度标签

**数据：** `/analysis/synthesize` 返回新增 `question_analysis[]`：
```json
[
  {
    "question_text": "Tell me about yourself and your PM experience.",
    "answer_utterance_ids": ["u002"],
    "answer_quality": "B",
    "comment": "背景介绍清晰但缺乏亮点...",
    "related_dimensions": ["structure", "initiative"]
  }
]
```

**组件：** `QuestionBreakdownSection` — 新建

### 2.3 Communication Metrics（沟通数据）

**位置：** Person section 内，radar chart 下方，维度分析之前。

**内容（纯前端计算，无需 LLM）：**
- Speaking Time：候选人 vs 面试官说话时间占比（进度条可视化）
- Avg Response Length：平均回答时长（秒）
- Filler Words：填充词频率（um, uh, like, 就是, 然后），每分钟次数
- Response Latency：面试官问完到候选人开始回答的平均间隔（秒）
- Longest Pause：最长沉默时间

**数据：** 在 `normalizeApiReport()` 中从 transcript 实时计算，存入 `PersonFeedback.communicationMetrics`。

**组件：** `CommunicationMetrics` — 新建，使用进度条和小数字卡片布局

### 2.4 Candidate Comparison（候选人对比）— 仅群面模式

**位置：** Overview section 内，Key Findings 之后。

**内容：** 横向对比表格：
- 行 = 维度（领导力、协作等）
- 列 = 每个候选人
- 单元格 = 分数 + 颜色编码（红<4, 中性4-8, 绿≥8）
- 底部行 = 各人总体推荐结论

**数据：** 纯前端，从已有 `per_person[].dimensions[].score` 数据重组。仅 `mode='group'` 时显示。

**组件：** `CandidateComparison` — 新建

### 2.5 Follow-up Questions（追问建议）

**位置：** Person section 底部，summary 之后。

**内容：** 3-5 个建议追问方向：
- 推荐问题文本
- 目标：该问题想验证什么能力
- 关联的 gap/risk claim_id

**数据：** `/analysis/improvements` 返回新增 `follow_up_questions[]`：
```json
[
  {
    "question": "Can you describe a time when you proactively identified a strategic opportunity?",
    "purpose": "验证候选人在无明确指令下的战略主动性",
    "related_claim_id": "c_yixin_wei_initiative_03"
  }
]
```

**组件：** `FollowUpQuestions` — 新建

### 2.6 Interview Quality Score（面试质量评估）

**位置：** Overview section 底部，可折叠。

**内容：**
- 能力覆盖率：N/5 维度被有效探查（有对应 evidence 的维度数/总维度数）
- 追问深度：面试官追问次数 vs 候选人泛化回答次数
- 面试结构分（0-10）：是否有开场、是否按逻辑顺序、是否有收尾
- 1-2 句总结建议

**数据：** 混合来源：
- 覆盖率和追问统计：前端从 transcript + evidence 计算
- 结构评估：`/analysis/synthesize` 返回新增 `interview_quality` 字段

**组件：** `InterviewQualityCard` — 新建

### 2.7 Candidate Action Plan（候选人行动计划）

**位置：** Person section 最底部。

**内容：** 比现有改进建议更结构化的 30 天行动计划：
- 3-5 个具体步骤，每步包含：
  - 行动项描述
  - 关联的弱项 claim_id
  - 练习方式建议
  - 预期效果

**数据：** `/analysis/improvements` 返回新增 `action_plan[]`：
```json
[
  {
    "action": "用 STAR 框架重新准备 3 个冲突解决案例",
    "related_claim_id": "c_yixin_wei_collaboration_03",
    "practice_method": "录音自己的回答，检查是否有自我修正或犹豫",
    "expected_outcome": "回答更加果断，减少中途调整的频率"
  }
]
```

**组件：** `ActionPlanCard` — 新建

---

## Section 3: 技术架构

### 3.1 后端扩展（Inference Service）

**`/analysis/synthesize` 扩展输出：**
- `recommendation`: `{ decision, confidence, rationale, context_type }`
- `question_analysis[]`: `{ question_text, answer_utterance_ids, answer_quality, comment, related_dimensions }`
- `interview_quality`: `{ coverage_summary, structure_score, suggestions }`

**`/analysis/improvements` 扩展输出：**
- `follow_up_questions[]`: `{ question, purpose, related_claim_id }`
- `action_plan[]`: `{ action, related_claim_id, practice_method, expected_outcome }`

### 3.2 Worker 流程

Finalize pipeline 无需修改。synthesize 和 improvements 的返回 payload 增加新字段，Worker 原样透传存储到 R2。

### 3.3 前端数据流

```
ResultV2 (R2/localStorage)
  → normalizeApiReport() 扩展：
    - 解析 recommendation, questionAnalysis[], interviewQuality
    - 从 transcript 计算 communicationMetrics
  → FeedbackReport 类型扩展
  → 各新组件消费对应数据
```

### 3.4 新增/修改组件清单

| 组件 | 类型 | 位置 |
|------|------|------|
| DateGroupedMeetings | 修改 HomeView | Upcoming Meetings |
| RecommendationBadge | 新建 | Overview 顶部 |
| QuestionBreakdownSection | 新建 | Overview 和 Person 之间 |
| CommunicationMetrics | 新建 | Person section 内 |
| CandidateComparison | 新建 | Overview 内 (group only) |
| FollowUpQuestions | 新建 | Person section 底部 |
| InterviewQualityCard | 新建 | Overview 底部 |
| ActionPlanCard | 新建 | Person section 底部 |
| InlineEditable | 新建 | 通用双击编辑 wrapper |
| ExportPDF / ExportSlack | 新建 | FeedbackHeader |

### 3.5 数据持久化（双击编辑）

- 编辑后写回 localStorage `ifb_session_data_{id}.report`
- 增加 `report.user_edits[]`：`{ field_path, original_value, edited_value, edited_at }`
- 导出使用编辑后的值
- Re-generate 时提醒覆盖手动编辑

### 3.6 实施分批

**Batch 1（基础修复 + 纯前端功能）：**
- Upcoming Meetings 日期分组
- Re-generate 按钮恢复下拉
- 双击编辑（InlineEditable）
- Communication Metrics（纯前端计算）
- Candidate Comparison（纯前端重组）
- Export PDF

**Batch 2（LLM 驱动的新板块）：**
- Decision Recommendation
- Question-by-Question Breakdown
- Interview Quality Score
- Export DOCX 启用

**Batch 3（改进建议扩展）：**
- Follow-up Questions
- Candidate Action Plan
- Export to Slack
