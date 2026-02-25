# Evidence 内联化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Evidence 从独立 Timeline section 融入 Claim 角标系统，实现"点角标展开证据引用 → 点查看上下文跳转 Transcript"的两层审计交互。

**Architecture:** FootnoteRef 从直接跳转 Transcript 改为 toggle 展开内联 Evidence 卡片。卡片内提供"查看上下文"链接跳转 Transcript。删除 EvidenceTimeline 独立 section 及其导航入口。

**Tech Stack:** React, TypeScript, Tailwind v4, motion/react (AnimatePresence)

---

### Task 1: FootnoteRef 支持 toggle 展开状态

**Files:**
- Modify: `desktop/src/components/ui/FootnoteRef.tsx`

**Step 1: 修改 FootnoteRef 支持 expanded 状态**

将 FootnoteRef 从纯展示组件改为支持 `expanded` 视觉反馈：

```tsx
type FootnoteRefProps = {
  index: number;                     // 1-based
  expanded?: boolean;
  onClick?: () => void;
};

export function FootnoteRef({ index, expanded, onClick }: FootnoteRefProps) {
  return (
    <sup
      className={`cursor-pointer font-medium text-[10px] ml-0.5 transition-colors ${
        expanded ? 'text-white bg-accent rounded-full px-1' : 'text-accent hover:underline'
      }`}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      role="button"
      aria-label={`Footnote ${index}`}
      aria-expanded={expanded}
    >
      {index}
    </sup>
  );
}
```

**Step 2: 验证构建**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS (新增的 `expanded` prop 是可选的，不破坏现有调用)

---

### Task 2: 新增 InlineEvidenceCard 组件

**Files:**
- Create: `desktop/src/components/ui/InlineEvidenceCard.tsx`

**Step 1: 创建内联证据卡片组件**

```tsx
import { motion } from 'motion/react';
import { ExternalLink } from 'lucide-react';

type InlineEvidenceCardProps = {
  quote: string;
  speaker: string;
  timestamp: string;          // "08:57"
  confidence: number;         // 0-1
  onViewContext?: () => void;  // 点击"查看上下文" → 跳转 Transcript
};

export function InlineEvidenceCard({ quote, speaker, timestamp, confidence, onViewContext }: InlineEvidenceCardProps) {
  const pct = Math.round(confidence * 100);

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className="mt-1.5 ml-1 border-l-2 border-accent/30 pl-3 py-1.5">
        <p className="text-xs text-ink leading-relaxed italic">"{quote}"</p>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-secondary">
          <span>{speaker} · {timestamp}</span>
          <span className={pct >= 80 ? 'text-success' : pct >= 60 ? 'text-secondary' : 'text-warning'}>{pct}%</span>
          {onViewContext && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onViewContext(); }}
              className="inline-flex items-center gap-0.5 text-accent hover:underline cursor-pointer"
            >
              查看上下文
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
```

**Step 2: 验证构建**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

---

### Task 3: ClaimCard 集成内联展开

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` — ClaimCard 组件 (约 line 1664-1755)

**Step 1: ClaimCard 添加展开状态和 InlineEvidenceCard**

在 ClaimCard 中:

1. 添加 `useState` 管理当前展开的 evidence ID (`expandedRef`)
2. FootnoteRef 的 `onClick` 从直接调用 `onFootnoteClick` 改为 toggle `expandedRef`
3. 展开时在角标下方渲染 `InlineEvidenceCard`
4. InlineEvidenceCard 的 `onViewContext` 调用原来的 `onFootnoteClick`（跳转 Transcript）

修改 ClaimCard 函数签名，添加 `evidenceMap` prop 以获取 evidence 详细信息：

```tsx
function ClaimCard({
  claim,
  report,
  onEditClick,
  onEvidenceClick,
  onNeedsEvidenceClick,
  getFootnoteIndex,
  onFootnoteClick,
}: {
  claim: Claim;
  report: FeedbackReport;
  onEditClick: () => void;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onNeedsEvidenceClick: () => void;
  getFootnoteIndex?: (evidenceId: string) => number;
  onFootnoteClick?: (evidenceId: string) => void;
}) {
  const hasFootnotes = !!getFootnoteIndex;
  const [expandedRef, setExpandedRef] = useState<string | null>(null);

  return (
    <div className={`group border border-border border-l-4 ${CATEGORY_BORDER[claim.category]} rounded-[--radius-button] p-3 hover:bg-surface-hover transition-colors`}>
      <div className="flex items-start gap-2 mb-2">
        <p className="text-sm text-ink flex-1 leading-relaxed">
          {claim.text}
          {hasFootnotes && (claim.evidence_refs ?? []).map((refId) => {
            const idx = getFootnoteIndex(refId);
            if (idx === 0) return null;
            return (
              <FootnoteRef
                key={refId}
                index={idx}
                expanded={expandedRef === refId}
                onClick={() => setExpandedRef(expandedRef === refId ? null : refId)}
              />
            );
          })}
        </p>
        {/* ... ConfidenceBadge and edit button unchanged ... */}
      </div>

      {/* Inline evidence expansion */}
      <AnimatePresence>
        {expandedRef && (() => {
          const ev = getEvidenceById(report, expandedRef);
          if (!ev) return null;
          return (
            <InlineEvidenceCard
              key={expandedRef}
              quote={ev.text}
              speaker={ev.speaker}
              timestamp={formatTimestamp(ev.timestamp_ms)}
              confidence={ev.confidence}
              onViewContext={() => onFootnoteClick?.(expandedRef)}
            />
          );
        })()}
      </AnimatePresence>

      {/* ... rest of ClaimCard (Needs Evidence badge, legacy chips, weak indicator) unchanged ... */}
    </div>
  );
}
```

**Step 2: 添加必要的 import**

在 FeedbackView.tsx 顶部添加：
```tsx
import { InlineEvidenceCard } from '../components/ui/InlineEvidenceCard';
```

确保 `AnimatePresence` 已在现有 import 中（已在 line 3）。

**Step 3: 验证构建**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

**Step 4: 验证生产构建**

Run: `cd desktop && npx vite build`
Expected: PASS, built in ~8s

---

### Task 4: 删除 EvidenceTimeline section

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx`

**Step 1: 删除 Evidence section 渲染（约 line 3661-3671）**

删除整个 `<section id="evidence">` 块：

```tsx
// DELETE THIS:
{/* ── Evidence section ── */}
<section id="evidence" data-section className="pb-6">
  <SectionStickyHeader icon={MessageSquare} title="Evidence Timeline" />
  <motion.div variants={fadeInUp} custom={report.persons.length + 3}>
    <EvidenceTimeline ... />
  </motion.div>
</section>
```

**Step 2: 删除 section nav 中的 Evidence 入口（约 line 2701）**

将:
```tsx
    { id: 'evidence', label: 'Evidence' },
```
删除。

**Step 3: 删除 EvidenceTimeline 组件函数（约 line 1941-2077）**

删除整个 `function EvidenceTimeline(...)` 及其内部逻辑。

**Step 4: 删除 EvidenceCard 组件函数（约 line 1900-1939）**

删除整个 `function EvidenceCard(...)` 。

**Step 5: 清理未使用的导入和变量**

- 检查是否有因删除 EvidenceTimeline/EvidenceCard 而变成未使用的 import（如 `Select` 等）
- 删除 `handleTimelineEvidenceClick` 如果不再有引用

**Step 6: 验证构建**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

---

### Task 5: 清理 OverallCard 角标行为

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` — OverallCard (约 line 1442-1530)

**Step 1: OverallCard 的 FootnoteRef 也改为 toggle 展开**

OverallCard 中 narrative 和 Key Findings 的 FootnoteRef 也应该改成 toggle 展开，而非直接跳转。

添加 `expandedOverallRef` state，复用与 ClaimCard 相同的模式：

1. `const [expandedOverallRef, setExpandedOverallRef] = useState<string | null>(null);`
2. narrative 区域的 FootnoteRef onClick → toggle expandedOverallRef
3. 展开时在 FootnoteRef 后方渲染 InlineEvidenceCard
4. InlineEvidenceCard 的 onViewContext → 调用 onFootnoteClick

注意：OverallCard 使用的是 `overallEvidenceMap`（基于 report events），不是 report.evidence。需要从 overallEvidenceMap 获取 quote/speaker/timestamp。

**Step 2: 验证构建**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

---

### Task 6: 验证 + 提交

**Step 1: 完整 TypeScript 检查**

Run: `cd desktop && npx tsc --noEmit`
Expected: 0 errors

**Step 2: 生产构建**

Run: `cd desktop && npx vite build`
Expected: PASS

**Step 3: 运行测试**

Run: `cd desktop && npx vitest run`
Expected: All tests pass

**Step 4: 提交**

```bash
git add desktop/src/components/ui/FootnoteRef.tsx \
       desktop/src/components/ui/InlineEvidenceCard.tsx \
       desktop/src/views/FeedbackView.tsx
git commit -m "refactor(desktop): inline evidence into claim footnotes, remove EvidenceTimeline"
```
