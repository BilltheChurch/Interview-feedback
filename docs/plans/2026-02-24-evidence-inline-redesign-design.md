# Evidence 内联化设计文档

> 日期: 2026-02-24
> 状态: 已批准

## 背景

当前 Evidence Timeline 作为独立 section 展示，与 Transcript 视觉上过于相似，用户无法一眼看出其价值。同时，Claim 角标 (FootnoteRef) 点击直接跳转 Transcript，与 Evidence 卡片形成两套独立系统回答同一个问题："这条评价的依据是什么？"

## 设计目标

将 Evidence 融入现有角标系统，变成 **一套系统、两层深度**：
- 浅层：角标展开看引用片段（快速审计）
- 深层：点"查看上下文"看完整对话（深度审计）

## 改动清单

### 修改

| 组件 | 当前行为 | 改后行为 |
|------|---------|---------|
| FootnoteRef (角标) | 点击 → 直接跳转 Transcript 高亮 | 点击 → 就地展开/收起 Evidence 引用卡片 |

### 新增

| 组件 | 说明 |
|------|------|
| InlineEvidenceCard | 角标下方内联展示：引用原文、说话人、时间戳、置信度、"查看上下文→"链接 |
| "查看上下文→"链接 | 点击 → 打开 Transcript Split View + 高亮（原角标的跳转功能移到这里） |

### 删除

| 组件 | 理由 |
|------|------|
| EvidenceTimeline section | 所有证据已内嵌在 Claim 角标里，独立 section 不再需要 |
| EvidenceCard 的 claimCount / dimensions 字段 | 上下文已明确是哪个 Claim 的证据，无需冗余展示 |

### 不动

- Radar Chart（雷达图）
- Person Card 整体结构
- Transcript Split View（触发方式从角标直接触发 → 从 Evidence 卡片内链接触发）
- Dimension 评分展示
- FootnoteList（保留，作为每个 Person Card 底部的快速索引）

## 交互流程

```
用户看报告
  → 看到维度评分 + Claim 文字 + 角标 ¹ ²
  → 觉得评分合理 → 继续往下看 (不点击)
  → 觉得评分有疑问 → 点角标 ¹
    → 角标下方展开引用卡片:
      ┌─────────────────────────────────┐
      │ "OK, actually, I used the嗯..." │
      │ 魏 · 08:57   85%   查看上下文 → │
      └─────────────────────────────────┘
    → 看到原文，觉得够了 → 点角标收起
    → 想看完整对话 → 点 "查看上下文→"
      → Transcript 侧栏打开 + 滚动到对应位置高亮
```

## 涉及文件

- `desktop/src/views/FeedbackView.tsx` — 主要改动：FootnoteRef 行为、删除 EvidenceTimeline、新增 InlineEvidenceCard
- `desktop/src/components/ui/FootnoteRef.tsx` — 添加 toggle 状态支持
- `desktop/src/hooks/useFootnotes.ts` — 可能需要扩展，提供 evidence 详细数据
- `desktop/src/components/TranscriptSection.tsx` — 不改（已有高亮支持）
