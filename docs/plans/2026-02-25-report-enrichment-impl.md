# Report Enrichment & UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现报告内容丰富化（7 个新板块）+ 基础修复（4 项）+ 导出扩展，分 3 个 Batch 共 13 个 Task。

**Architecture:** Batch 1 为纯前端改动（日期分组、SplitButton、InlineEditable、Communication Metrics、Candidate Comparison、Export PDF）。Batch 2 扩展 inference synthesize API 并新增前端板块（Recommendation、Question Breakdown、Interview Quality、DOCX）。Batch 3 扩展 improvements API 并新增 Follow-up Questions、Action Plan、Slack 导出。

**Tech Stack:** React + TypeScript + Tailwind v4, Electron IPC (printToPDF), FastAPI + DashScope LLM (qwen-flash), Zustand + localStorage

**Design Doc:** `docs/plans/2026-02-25-report-enrichment-design.md`

---

## Batch 1: 基础修复 + 纯前端功能

---

### Task 1: Upcoming Meetings 日期分组

**Files:**
- Modify: `desktop/src/views/HomeView.tsx:250-389`

**Step 1: Add date grouping helper**

在 `UpcomingMeetings` 组件上方添加 helper 函数（类似 HistoryView 的 `getDateGroup`，但面向未来日期）：

```typescript
function getMeetingDateGroup(isoTime: string): string {
  const date = new Date(isoTime);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(today);
  dayAfter.setDate(dayAfter.getDate() + 2);

  if (date >= today && date < tomorrow) return 'Today';
  if (date >= tomorrow && date < dayAfter) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function groupMeetingsByDate(meetings: CalendarMeeting[]): { label: string; meetings: CalendarMeeting[] }[] {
  const groups = new Map<string, CalendarMeeting[]>();
  const order: string[] = [];

  for (const m of meetings) {
    const label = getMeetingDateGroup(m.startTime);
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(m);
  }

  return order.map(label => ({ label, meetings: groups.get(label)! }));
}
```

**Step 2: Update meeting list rendering**

将 `UpcomingMeetings` 中的 `meetings.map(...)` 替换为按日期分组渲染：

```typescript
{/* 替换原来的 <ul className="space-y-2 ..."> */}
<div className="space-y-4 flex-1 min-h-0 overflow-y-auto">
  {groupMeetingsByDate(meetings).map((group) => (
    <div key={group.label}>
      <h4 className="text-xs font-medium text-ink-tertiary uppercase tracking-wide mb-1.5 px-1">
        {group.label}
      </h4>
      <ul className="space-y-2">
        {group.meetings.map((m) => (
          <li key={m.id} className="flex items-center justify-between border border-border rounded-[--radius-button] px-3 py-2">
            {/* ...existing meeting item rendering unchanged... */}
          </li>
        ))}
      </ul>
    </div>
  ))}
</div>
```

**Step 3: Build and verify**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: Build passes, no TypeScript errors.

**Step 4: Commit**

```bash
git add desktop/src/views/HomeView.tsx
git commit -m "feat(desktop): group upcoming meetings by date"
```

---

### Task 2: Re-generate 按钮恢复下拉

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx:1524-1539`

**Step 1: Replace conditional rendering with unified SplitButton**

将 lines 1525-1539 的条件分支替换为统一的 SplitButton：

```typescript
{/* 替换整个 captionSource === 'acs-teams' ? (...) : (...) 块 */}
<SplitButton
  options={[
    { label: 'Re-generate Report', value: 'report-only', icon: <RefreshCw className="w-3.5 h-3.5" /> },
    { label: 'Full Re-analysis', value: 'full', icon: <Layers className="w-3.5 h-3.5" /> },
  ]}
  onSelect={(v) => handleRegenerate(v as 'full' | 'report-only')}
  loading={regenerating}
/>
```

**Step 2: Build and verify**

Run: `cd desktop && npx tsc --noEmit && npx vite build`

**Step 3: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "fix(desktop): restore re-generate dropdown for all modes"
```

---

### Task 3: InlineEditable 双击编辑组件

**Files:**
- Create: `desktop/src/components/ui/InlineEditable.tsx`
- Create: `desktop/src/components/ui/InlineEditable.test.tsx`
- Modify: `desktop/src/views/FeedbackView.tsx` (OverallCard, ClaimCard, PersonSummary 等处包裹 InlineEditable)

**Step 1: Write test**

```typescript
// desktop/src/components/ui/InlineEditable.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InlineEditable } from './InlineEditable';

describe('InlineEditable', () => {
  it('renders text in display mode', () => {
    render(<InlineEditable value="hello" onSave={vi.fn()} />);
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('switches to textarea on double-click', () => {
    render(<InlineEditable value="hello" onSave={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('hello'));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('calls onSave on blur', () => {
    const onSave = vi.fn();
    render(<InlineEditable value="hello" onSave={onSave} />);
    fireEvent.doubleClick(screen.getByText('hello'));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'updated' } });
    fireEvent.blur(textarea);
    expect(onSave).toHaveBeenCalledWith('updated');
  });

  it('cancels on Escape', () => {
    const onSave = vi.fn();
    render(<InlineEditable value="hello" onSave={onSave} />);
    fireEvent.doubleClick(screen.getByText('hello'));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'changed' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('hello')).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd desktop && npx vitest run src/components/ui/InlineEditable.test.tsx`
Expected: FAIL — module not found.

**Step 3: Implement InlineEditable**

```typescript
// desktop/src/components/ui/InlineEditable.tsx
import { useState, useRef, useEffect, useCallback } from 'react';

type Props = {
  value: string;
  onSave: (newValue: string) => void;
  as?: 'p' | 'span' | 'h2' | 'h3';
  className?: string;
  textareaClassName?: string;
  placeholder?: string;
};

export function InlineEditable({
  value,
  onSave,
  as: Tag = 'p',
  className = '',
  textareaClassName = '',
  placeholder = 'Double-click to edit...',
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
      // Auto-resize
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [editing]);

  const handleSave = useCallback(() => {
    setEditing(false);
    if (draft.trim() !== value.trim()) {
      onSave(draft.trim());
    }
  }, [draft, value, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setDraft(value);
      setEditing(false);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      handleSave();
    }
  }, [value, handleSave]);

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        role="textbox"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = e.target.scrollHeight + 'px';
        }}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        className={`w-full resize-none border border-accent/40 rounded px-2 py-1 text-sm text-ink bg-white focus:outline-none focus:ring-1 focus:ring-accent ${textareaClassName}`}
      />
    );
  }

  return (
    <Tag
      className={`cursor-text hover:bg-accent/5 rounded px-1 -mx-1 transition-colors ${className}`}
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
    >
      {value || <span className="text-ink-tertiary italic">{placeholder}</span>}
    </Tag>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `cd desktop && npx vitest run src/components/ui/InlineEditable.test.tsx`
Expected: 4 tests PASS.

**Step 5: Integrate into FeedbackView**

在 FeedbackView.tsx 中需要一个 helper 来保存编辑。在 FeedbackView 主组件中添加：

```typescript
// 在 FeedbackView 组件内，sessionData 附近
const handleInlineEdit = useCallback((fieldPath: string, newValue: string) => {
  if (!sessionId) return;
  try {
    const dataKey = `ifb_session_data_${sessionId}`;
    const stored = JSON.parse(localStorage.getItem(dataKey) || '{}');
    if (!stored.report) return;

    // Record user edit
    if (!stored.report.user_edits) stored.report.user_edits = [];
    stored.report.user_edits.push({
      field_path: fieldPath,
      edited_value: newValue,
      edited_at: new Date().toISOString(),
    });

    // Apply edit to the field path (supports dot notation like "overall.narrative")
    const keys = fieldPath.split('.');
    let obj = stored.report;
    for (let i = 0; i < keys.length - 1; i++) {
      obj = obj[keys[i]];
      if (!obj) return;
    }
    obj[keys[keys.length - 1]] = newValue;

    localStorage.setItem(dataKey, JSON.stringify(stored));

    // Re-normalize to update UI
    const normalized = normalizeApiReport(stored.report, {
      name: stored.sessionName,
      date: stored.date,
      durationMs: (stored.elapsedSeconds || 0) * 1000,
      mode: stored.mode,
      participants: stored.participants,
    });
    setApiReport(normalized);
  } catch (err) {
    console.warn('[InlineEdit] Failed to save:', err);
  }
}, [sessionId]);
```

然后在以下位置包裹 `InlineEditable`：

1. **OverallCard narrative** — `teamSummaryNarrative` text
2. **Key Findings** — 每个 finding.text
3. **Claim text** — 在 ClaimCard 或 DimensionSummaryRow 中每个 claim.text
4. **Person Summary** — strengths/risks/actions 文本

需要将 `handleInlineEdit` 通过 props 传递到子组件。

**Step 6: Build and verify**

Run: `cd desktop && npx tsc --noEmit && npx vite build && npx vitest run`
Expected: Build passes, all tests pass.

**Step 7: Commit**

```bash
git add desktop/src/components/ui/InlineEditable.tsx desktop/src/components/ui/InlineEditable.test.tsx desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): add inline editing for claims, summary, and key findings"
```

---

### Task 4: Communication Metrics 沟通数据

**Files:**
- Create: `desktop/src/components/CommunicationMetrics.tsx`
- Modify: `desktop/src/views/FeedbackView.tsx` (FeedbackReport 类型 + normalizeApiReport + PersonFeedbackCard)

**Step 1: Define metrics type and compute function**

在 FeedbackView.tsx 中扩展类型（PersonFeedback 附近）：

```typescript
type CommunicationMetricsData = {
  speakingTimeSec: number;
  totalSessionSec: number;
  speakingRatio: number; // 0-1
  avgResponseSec: number;
  fillerWordCount: number;
  fillerWordsPerMin: number;
  avgLatencySec: number;
  longestPauseSec: number;
  turnCount: number;
};
```

在 `normalizeApiReport` 末尾、返回前，为每个 person 计算 metrics：

```typescript
// Compute communication metrics per person from transcript
const FILLER_WORDS_EN = /\b(um|uh|like|you know|i mean|basically|actually|so yeah)\b/gi;
const FILLER_WORDS_ZH = /(就是|然后|那个|嗯|啊|对吧|这个)/g;

for (const person of persons) {
  const personUtterances = normalizedTranscript.filter(
    u => u.speaker_name === person.person_name
  );
  if (personUtterances.length === 0) continue;

  const speakingTimeSec = personUtterances.reduce(
    (sum, u) => sum + (u.end_ms - u.start_ms) / 1000, 0
  );
  const totalSessionSec = normalizedTranscript.length > 0
    ? (normalizedTranscript[normalizedTranscript.length - 1].end_ms - normalizedTranscript[0].start_ms) / 1000
    : 1;

  let fillerCount = 0;
  for (const u of personUtterances) {
    fillerCount += (u.text.match(FILLER_WORDS_EN) || []).length;
    fillerCount += (u.text.match(FILLER_WORDS_ZH) || []).length;
  }

  // Response latency: time between interviewer end and candidate start
  const latencies: number[] = [];
  for (let i = 1; i < normalizedTranscript.length; i++) {
    const prev = normalizedTranscript[i - 1];
    const curr = normalizedTranscript[i];
    if (curr.speaker_name === person.person_name && prev.speaker_name !== person.person_name) {
      latencies.push(Math.max(0, (curr.start_ms - prev.end_ms) / 1000));
    }
  }

  person.communicationMetrics = {
    speakingTimeSec: Math.round(speakingTimeSec),
    totalSessionSec: Math.round(totalSessionSec),
    speakingRatio: speakingTimeSec / totalSessionSec,
    avgResponseSec: personUtterances.length > 0
      ? Math.round(speakingTimeSec / personUtterances.length)
      : 0,
    fillerWordCount: fillerCount,
    fillerWordsPerMin: speakingTimeSec > 0
      ? Math.round((fillerCount / speakingTimeSec) * 60 * 10) / 10
      : 0,
    avgLatencySec: latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length * 10) / 10
      : 0,
    longestPauseSec: latencies.length > 0 ? Math.round(Math.max(...latencies) * 10) / 10 : 0,
    turnCount: personUtterances.length,
  };
}
```

**Step 2: Create CommunicationMetrics component**

```typescript
// desktop/src/components/CommunicationMetrics.tsx
import { MessageSquare, Clock, AlertTriangle, Zap, Hash } from 'lucide-react';

type Props = {
  metrics: {
    speakingTimeSec: number;
    totalSessionSec: number;
    speakingRatio: number;
    avgResponseSec: number;
    fillerWordCount: number;
    fillerWordsPerMin: number;
    avgLatencySec: number;
    longestPauseSec: number;
    turnCount: number;
  };
};

function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function CommunicationMetrics({ metrics }: Props) {
  const items = [
    {
      icon: MessageSquare,
      label: 'Speaking Time',
      value: formatSeconds(metrics.speakingTimeSec),
      detail: `${Math.round(metrics.speakingRatio * 100)}% of session`,
      bar: metrics.speakingRatio,
    },
    {
      icon: Clock,
      label: 'Avg Response',
      value: formatSeconds(metrics.avgResponseSec),
      detail: `${metrics.turnCount} turns total`,
    },
    {
      icon: AlertTriangle,
      label: 'Filler Words',
      value: `${metrics.fillerWordCount}`,
      detail: `${metrics.fillerWordsPerMin}/min`,
    },
    {
      icon: Zap,
      label: 'Response Latency',
      value: `${metrics.avgLatencySec}s avg`,
      detail: `${metrics.longestPauseSec}s longest`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 my-3">
      {items.map((item) => (
        <div key={item.label} className="flex items-start gap-2.5 p-2.5 rounded-[--radius-button] bg-surface border border-border/50">
          <item.icon className="w-4 h-4 text-ink-tertiary shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-ink-tertiary">{item.label}</p>
            <p className="text-sm font-semibold text-ink">{item.value}</p>
            <p className="text-xs text-ink-tertiary">{item.detail}</p>
            {item.bar !== undefined && (
              <div className="mt-1 h-1.5 bg-border/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all"
                  style={{ width: `${Math.round(item.bar * 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

**Step 3: Add to PersonFeedbackCard**

在 PersonFeedbackCard 中，radar chart 下方、dimensions 上方插入：

```typescript
{/* Communication Metrics */}
{person.communicationMetrics && (
  <CommunicationMetrics metrics={person.communicationMetrics} />
)}
```

**Step 4: Update PersonFeedback type**

```typescript
// 在 PersonFeedback 类型中添加
type PersonFeedback = {
  // ...existing fields...
  communicationMetrics?: CommunicationMetricsData;
};
```

**Step 5: Build and verify**

Run: `cd desktop && npx tsc --noEmit && npx vite build`

**Step 6: Commit**

```bash
git add desktop/src/components/CommunicationMetrics.tsx desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): add communication metrics per person (speaking time, filler words, latency)"
```

---

### Task 5: Candidate Comparison 候选人对比表（group only）

**Files:**
- Create: `desktop/src/components/CandidateComparison.tsx`
- Modify: `desktop/src/views/FeedbackView.tsx` (OverallCard 添加对比表)

**Step 1: Create CandidateComparison component**

```typescript
// desktop/src/components/CandidateComparison.tsx
type Props = {
  persons: Array<{
    person_name: string;
    dimensions: Array<{
      dimension: string;
      label_zh?: string;
      score?: number;
    }>;
  }>;
};

function scoreColor(score: number | undefined): string {
  if (score === undefined) return 'text-ink-tertiary bg-surface';
  if (score >= 8) return 'text-emerald-700 bg-emerald-50';
  if (score >= 4) return 'text-ink bg-surface';
  return 'text-red-700 bg-red-50';
}

export function CandidateComparison({ persons }: Props) {
  if (persons.length < 2) return null;

  // Collect all unique dimensions
  const dimensions = persons[0].dimensions.map(d => ({
    key: d.dimension,
    label: d.label_zh || d.dimension,
  }));

  return (
    <div className="my-4">
      <h3 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
        Candidate Comparison
      </h3>
      <div className="overflow-x-auto border border-border rounded-[--radius-card]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface">
              <th className="text-left px-3 py-2 text-xs font-medium text-ink-secondary border-b border-border">
                Dimension
              </th>
              {persons.map(p => (
                <th key={p.person_name} className="text-center px-3 py-2 text-xs font-medium text-ink-secondary border-b border-border">
                  {p.person_name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dimensions.map(dim => (
              <tr key={dim.key} className="border-b border-border/50">
                <td className="px-3 py-2 text-xs text-ink-secondary">{dim.label}</td>
                {persons.map(p => {
                  const d = p.dimensions.find(pd => pd.dimension === dim.key);
                  const score = d?.score;
                  return (
                    <td key={p.person_name} className="text-center px-3 py-1.5">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${scoreColor(score)}`}>
                        {score !== undefined ? score.toFixed(1) : '—'}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

**Step 2: Add to OverallCard (group mode only)**

在 OverallCard 中，Key Findings 区域之后：

```typescript
{/* Candidate Comparison — group mode only */}
{report.mode === 'group' && report.persons.length >= 2 && (
  <CandidateComparison persons={report.persons} />
)}
```

**Step 3: Build and commit**

```bash
cd desktop && npx tsc --noEmit && npx vite build
git add desktop/src/components/CandidateComparison.tsx desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): add candidate comparison table for group interviews"
```

---

### Task 6: Export PDF

**Files:**
- Modify: `desktop/main.js` (新增 IPC handler)
- Modify: `desktop/preload.js` (暴露 exportPDF)
- Modify: `desktop/src/views/FeedbackView.tsx` (FeedbackHeader 添加 Export PDF 按钮)

**Step 1: Add IPC handler in main.js**

在 main.js 中已有的 ipcMain.handle 区域添加：

```javascript
ipcMain.handle('export:printToPDF', async () => {
  if (!mainWindow) throw new Error('No main window');
  const pdfData = await mainWindow.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
  });
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export PDF',
    defaultPath: 'feedback-report.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (filePath) {
    fs.writeFileSync(filePath, pdfData);
    return { success: true, path: filePath };
  }
  return { success: false };
});
```

**Step 2: Expose in preload.js**

```javascript
// 在 contextBridge.exposeInMainWorld('desktopAPI', { ... }) 中添加：
exportPDF: () => ipcRenderer.invoke('export:printToPDF'),
```

**Step 3: Add type declaration**

在 `desktop/src/types/desktop-api.d.ts` 中添加：

```typescript
exportPDF: () => Promise<{ success: boolean; path?: string }>;
```

**Step 4: Add Export PDF button in FeedbackHeader**

在 Export Markdown 按钮之后、Export DOCX 之前添加：

```typescript
<Button variant="secondary" size="sm" onClick={async () => {
  try {
    const result = await window.desktopAPI.exportPDF();
    if (result.success) {
      // Show success toast or feedback
    }
  } catch (err) {
    console.warn('PDF export failed:', err);
  }
}} className="transition-all duration-200">
  <FileText className="w-3.5 h-3.5" />
  Export PDF
</Button>
```

**Step 5: Build and verify**

Run: `cd desktop && npx tsc --noEmit && npx vite build`

**Step 6: Commit**

```bash
git add desktop/main.js desktop/preload.js desktop/src/views/FeedbackView.tsx desktop/src/types/desktop-api.d.ts
git commit -m "feat(desktop): add Export PDF via Electron printToPDF"
```

---

## Batch 2: LLM 驱动的新板块

---

### Task 7: 扩展 Inference synthesize API

**Files:**
- Modify: `inference/app/schemas.py` (新增 response 字段)
- Modify: `inference/app/services/report_synthesizer.py` (扩展 system prompt)

**Step 1: Add new schema fields**

在 `inference/app/schemas.py` 中添加新的 response 类型：

```python
class Recommendation(BaseModel):
    decision: str  # "recommend" | "tentative" | "not_recommend"
    confidence: float
    rationale: str
    context_type: str = "hiring"  # or "admission"

class QuestionAnalysis(BaseModel):
    question_text: str
    answer_utterance_ids: list[str] = []
    answer_quality: str  # A/B/C/D
    comment: str
    related_dimensions: list[str] = []

class InterviewQuality(BaseModel):
    coverage_ratio: float  # 0-1
    follow_up_depth: int
    structure_score: float  # 0-10
    suggestions: str
```

扩展 `AnalysisReportResponse`（或 synthesize response）的 overall 部分，添加可选字段：

```python
# 在 OverallFeedback 或返回结构中添加
recommendation: Optional[Recommendation] = None
question_analysis: Optional[list[QuestionAnalysis]] = None
interview_quality: Optional[InterviewQuality] = None
```

**Step 2: Extend synthesize system prompt**

在 `report_synthesizer.py` 的 system prompt 中添加新输出字段要求：

```
## 额外输出字段（在 overall 中）

"recommendation": {{
  "decision": "recommend" / "tentative" / "not_recommend",
  "confidence": 0.0-1.0,
  "rationale": "一句话推荐理由（中文）",
  "context_type": "hiring"
}},
"question_analysis": [
  {{
    "question_text": "面试官的原始问题",
    "answer_utterance_ids": ["回答的utterance id列表"],
    "answer_quality": "A/B/C/D",
    "comment": "回答质量简评（中文，1-2句）",
    "related_dimensions": ["关联的维度key"]
  }}
],
"interview_quality": {{
  "coverage_ratio": 被有效探查的维度数/总维度数,
  "follow_up_depth": 面试官有效追问次数,
  "structure_score": 0-10,
  "suggestions": "对面试官的建议（中文，1-2句）"
}}
```

**Step 3: Parse new fields in synthesizer response handler**

确保 `_parse_llm_response()` 方法能从 LLM JSON 输出中提取新字段，附加到返回结果。

**Step 4: Test**

Run: `cd inference && python -m pytest tests/ -v`
Expected: All existing tests pass. May need to update snapshot tests if any.

**Step 5: Commit**

```bash
git add inference/app/schemas.py inference/app/services/report_synthesizer.py
git commit -m "feat(inference): extend synthesize API with recommendation, question analysis, interview quality"
```

---

### Task 8: 前端 — RecommendationBadge + QuestionBreakdownSection

**Files:**
- Create: `desktop/src/components/RecommendationBadge.tsx`
- Create: `desktop/src/components/QuestionBreakdownSection.tsx`
- Modify: `desktop/src/views/FeedbackView.tsx` (类型扩展 + normalizeApiReport + 渲染位置)

**Step 1: Extend FeedbackReport type**

```typescript
type Recommendation = {
  decision: 'recommend' | 'tentative' | 'not_recommend';
  confidence: number;
  rationale: string;
  context_type: 'hiring' | 'admission';
};

type QuestionAnalysisItem = {
  question_text: string;
  answer_utterance_ids: string[];
  answer_quality: 'A' | 'B' | 'C' | 'D';
  comment: string;
  related_dimensions: string[];
};

// 在 OverallFeedback 类型中添加
recommendation?: Recommendation;
questionAnalysis?: QuestionAnalysisItem[];
```

**Step 2: Update normalizeApiReport**

```typescript
// 在 normalizeApiReport 中解析新字段
const recommendation = raw.overall?.recommendation || raw.recommendation || undefined;
const questionAnalysis = Array.isArray(raw.overall?.question_analysis)
  ? raw.overall.question_analysis
  : Array.isArray(raw.question_analysis)
    ? raw.question_analysis
    : undefined;
```

**Step 3: Create RecommendationBadge**

```typescript
// desktop/src/components/RecommendationBadge.tsx
import { ThumbsUp, ThumbsDown, HelpCircle } from 'lucide-react';

const CONFIG = {
  recommend: { label: '推荐录用', icon: ThumbsUp, bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  tentative: { label: '待定', icon: HelpCircle, bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
  not_recommend: { label: '不推荐', icon: ThumbsDown, bg: 'bg-red-50 border-red-200', text: 'text-red-700' },
};

type Props = {
  recommendation: { decision: string; confidence: number; rationale: string; context_type: string };
};

export function RecommendationBadge({ recommendation: rec }: Props) {
  const config = CONFIG[rec.decision as keyof typeof CONFIG] || CONFIG.tentative;
  const Icon = config.icon;

  return (
    <div className={`flex items-start gap-3 p-4 rounded-[--radius-card] border ${config.bg} mb-4`}>
      <Icon className={`w-5 h-5 ${config.text} shrink-0 mt-0.5`} />
      <div>
        <div className="flex items-center gap-2">
          <span className={`text-sm font-semibold ${config.text}`}>{config.label}</span>
          <span className="text-xs text-ink-tertiary">({Math.round(rec.confidence * 100)}% confidence)</span>
        </div>
        <p className="text-sm text-ink-secondary mt-1">{rec.rationale}</p>
      </div>
    </div>
  );
}
```

**Step 4: Create QuestionBreakdownSection**

```typescript
// desktop/src/components/QuestionBreakdownSection.tsx
import { Chip } from './ui/Chip';

const QUALITY_CONFIG = {
  A: { label: 'A', color: 'bg-emerald-100 text-emerald-700' },
  B: { label: 'B', color: 'bg-blue-100 text-blue-700' },
  C: { label: 'C', color: 'bg-amber-100 text-amber-700' },
  D: { label: 'D', color: 'bg-red-100 text-red-700' },
};

type Props = {
  questions: Array<{
    question_text: string;
    answer_quality: string;
    comment: string;
    related_dimensions: string[];
  }>;
};

export function QuestionBreakdownSection({ questions }: Props) {
  return (
    <div className="space-y-3">
      {questions.map((q, i) => {
        const quality = QUALITY_CONFIG[q.answer_quality as keyof typeof QUALITY_CONFIG] || QUALITY_CONFIG.C;
        return (
          <div key={i} className="border border-border rounded-[--radius-card] p-3">
            <div className="flex items-start gap-2">
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${quality.color} shrink-0`}>
                {quality.label}
              </span>
              <div>
                <p className="text-sm font-medium text-ink">{q.question_text}</p>
                <p className="text-xs text-ink-secondary mt-1">{q.comment}</p>
                {q.related_dimensions.length > 0 && (
                  <div className="flex gap-1 mt-1.5">
                    {q.related_dimensions.map(d => (
                      <Chip key={d} className="text-[10px]">{d}</Chip>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

**Step 5: Wire into FeedbackView rendering**

OverallCard 中 Key Findings 之前插入 RecommendationBadge：

```typescript
{report.overall.recommendation && (
  <RecommendationBadge recommendation={report.overall.recommendation} />
)}
```

在 Overview section 和 Person sections 之间新增 Question Breakdown section：

```typescript
{/* ── Question Breakdown section ── */}
{report.overall.questionAnalysis && report.overall.questionAnalysis.length > 0 && (
  <section id="questions" data-section className="pb-4">
    <SectionStickyHeader icon={HelpCircle} title="Question-by-Question Analysis" />
    <motion.div variants={fadeInUp} custom={2.5}>
      <Card className="p-5">
        <QuestionBreakdownSection questions={report.overall.questionAnalysis} />
      </Card>
    </motion.div>
  </section>
)}
```

**Step 6: Build and commit**

```bash
cd desktop && npx tsc --noEmit && npx vite build
git add desktop/src/components/RecommendationBadge.tsx desktop/src/components/QuestionBreakdownSection.tsx desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): add recommendation badge and question-by-question breakdown"
```

---

### Task 9: 前端 — InterviewQualityCard

**Files:**
- Create: `desktop/src/components/InterviewQualityCard.tsx`
- Modify: `desktop/src/views/FeedbackView.tsx` (OverallCard 添加)

**Step 1: Create InterviewQualityCard**

```typescript
// desktop/src/components/InterviewQualityCard.tsx
import { useState } from 'react';
import { ChevronDown, ChevronRight, Target, MessageSquare, Layers, Lightbulb } from 'lucide-react';

type Props = {
  quality: {
    coverage_ratio: number;
    follow_up_depth: number;
    structure_score: number;
    suggestions: string;
  };
};

export function InterviewQualityCard({ quality }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-4 border border-border/50 rounded-[--radius-card] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-hover transition-colors cursor-pointer"
      >
        {open ? <ChevronDown className="w-4 h-4 text-ink-tertiary" /> : <ChevronRight className="w-4 h-4 text-ink-tertiary" />}
        <Target className="w-4 h-4 text-ink-secondary" />
        <span className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">Interview Quality</span>
        <span className="ml-auto text-xs text-ink-tertiary">{quality.structure_score.toFixed(1)}/10</span>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 space-y-2 border-t border-border/50">
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-2 bg-surface rounded">
              <p className="text-xs text-ink-tertiary">Coverage</p>
              <p className="text-sm font-semibold text-ink">{Math.round(quality.coverage_ratio * 100)}%</p>
            </div>
            <div className="text-center p-2 bg-surface rounded">
              <p className="text-xs text-ink-tertiary">Follow-ups</p>
              <p className="text-sm font-semibold text-ink">{quality.follow_up_depth}</p>
            </div>
            <div className="text-center p-2 bg-surface rounded">
              <p className="text-xs text-ink-tertiary">Structure</p>
              <p className="text-sm font-semibold text-ink">{quality.structure_score.toFixed(1)}</p>
            </div>
          </div>
          <div className="flex items-start gap-2 text-xs text-ink-secondary">
            <Lightbulb className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
            <span>{quality.suggestions}</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Wire into OverallCard**

在 OverallCard 底部添加：

```typescript
{report.overall.interviewQuality && (
  <InterviewQualityCard quality={report.overall.interviewQuality} />
)}
```

**Step 3: Build and commit**

```bash
cd desktop && npx tsc --noEmit && npx vite build
git add desktop/src/components/InterviewQualityCard.tsx desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): add collapsible interview quality card"
```

---

### Task 10: Enable Export DOCX

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` (FeedbackHeader, remove disabled + add handler)

**Step 1: Enable DOCX button and add handler**

Replace the disabled DOCX button (line ~1513-1516) with functional version:

```typescript
<Button variant="secondary" size="sm" onClick={handleExportDOCX} className="transition-all duration-200">
  <Download className="w-3.5 h-3.5" />
  Export DOCX
</Button>
```

Add handler in FeedbackHeader (use existing exportFeedback IPC which calls Worker's DOCX generation):

```typescript
const handleExportDOCX = async () => {
  try {
    if (!sessionId || !sessionData?.baseApiUrl) return;
    const result = await window.desktopAPI.exportFeedback({
      sessionId,
      baseUrl: sessionData.baseApiUrl,
      format: 'docx',
    });
    if (result?.url) {
      window.open(result.url, '_blank');
    }
  } catch (err) {
    console.warn('DOCX export failed:', err);
  }
};
```

**Note:** If Worker DOCX generation is not yet wired, this can be implemented as a client-side generation using the same markdown content + a library like `docx` (npm package). Evaluate at implementation time.

**Step 2: Build and commit**

```bash
cd desktop && npx tsc --noEmit && npx vite build
git add desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): enable DOCX export"
```

---

## Batch 3: 改进建议扩展

---

### Task 11: 扩展 Inference improvements API

**Files:**
- Modify: `inference/app/schemas.py` (新增 response 字段)
- Modify: `inference/app/services/improvement_generator.py` (扩展 prompt)

**Step 1: Add new schema fields**

```python
class FollowUpQuestion(BaseModel):
    question: str
    purpose: str
    related_claim_id: str | None = None

class ActionPlanItem(BaseModel):
    action: str
    related_claim_id: str | None = None
    practice_method: str
    expected_outcome: str

# 在 ImprovementReport 中添加
follow_up_questions: list[FollowUpQuestion] = []
action_plan: list[ActionPlanItem] = []
```

**Step 2: Extend improvement generator prompt**

在 SYSTEM_PROMPT 的输出格式中添加：

```
"follow_up_questions": [
  {{
    "question": "推荐追问的英文问题",
    "purpose": "该问题想验证什么（中文）",
    "related_claim_id": "关联的risk/action claim id"
  }}
],
"action_plan": [
  {{
    "action": "具体行动项（中文）",
    "related_claim_id": "关联的risk/action claim id",
    "practice_method": "练习方式（中文）",
    "expected_outcome": "预期效果（中文）"
  }}
]
```

**Step 3: Test**

Run: `cd inference && python -m pytest tests/ -v`

**Step 4: Commit**

```bash
git add inference/app/schemas.py inference/app/services/improvement_generator.py
git commit -m "feat(inference): extend improvements API with follow-up questions and action plan"
```

---

### Task 12: 前端 — FollowUpQuestions + ActionPlanCard

**Files:**
- Create: `desktop/src/components/FollowUpQuestions.tsx`
- Create: `desktop/src/components/ActionPlanCard.tsx`
- Modify: `desktop/src/views/FeedbackView.tsx` (PersonFeedbackCard 添加)

**Step 1: Create FollowUpQuestions**

```typescript
// desktop/src/components/FollowUpQuestions.tsx
import { HelpCircle } from 'lucide-react';

type Props = {
  questions: Array<{
    question: string;
    purpose: string;
    related_claim_id?: string;
  }>;
};

export function FollowUpQuestions({ questions }: Props) {
  if (questions.length === 0) return null;

  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
        Suggested Follow-up Questions
      </h4>
      <div className="space-y-2">
        {questions.map((q, i) => (
          <div key={i} className="flex items-start gap-2 p-2.5 border border-border/50 rounded-[--radius-button] bg-blue-50/30">
            <HelpCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-ink font-medium">{q.question}</p>
              <p className="text-xs text-ink-tertiary mt-0.5">{q.purpose}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Create ActionPlanCard**

```typescript
// desktop/src/components/ActionPlanCard.tsx
import { Target, ArrowRight } from 'lucide-react';

type Props = {
  items: Array<{
    action: string;
    practice_method: string;
    expected_outcome: string;
    related_claim_id?: string;
  }>;
};

export function ActionPlanCard({ items }: Props) {
  if (items.length === 0) return null;

  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
        30-Day Action Plan
      </h4>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="border border-border rounded-[--radius-card] p-3">
            <div className="flex items-start gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white text-xs font-bold shrink-0">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-ink">{item.action}</p>
                <div className="mt-1.5 flex items-start gap-1.5 text-xs text-ink-secondary">
                  <Target className="w-3.5 h-3.5 shrink-0 mt-0.5 text-accent" />
                  <span>{item.practice_method}</span>
                </div>
                <div className="mt-1 flex items-start gap-1.5 text-xs text-ink-tertiary">
                  <ArrowRight className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{item.expected_outcome}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Step 3: Wire into PersonFeedbackCard**

在 PersonSummary 之后、FootnoteList 之前添加：

```typescript
{/* Follow-up Questions */}
{report.improvements?.follow_up_questions && (
  <FollowUpQuestions questions={report.improvements.follow_up_questions} />
)}

{/* Action Plan */}
{report.improvements?.action_plan && (
  <ActionPlanCard items={report.improvements.action_plan} />
)}
```

**Step 4: Update ImprovementReport type**

```typescript
type ImprovementReport = {
  overall: OverallImprovement;
  dimensions: DimensionImprovement[];
  claims: ClaimImprovement[];
  follow_up_questions?: Array<{ question: string; purpose: string; related_claim_id?: string }>;
  action_plan?: Array<{ action: string; related_claim_id?: string; practice_method: string; expected_outcome: string }>;
};
```

**Step 5: Build and commit**

```bash
cd desktop && npx tsc --noEmit && npx vite build
git add desktop/src/components/FollowUpQuestions.tsx desktop/src/components/ActionPlanCard.tsx desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): add follow-up questions and 30-day action plan"
```

---

### Task 13: Export to Slack

**Files:**
- Modify: `desktop/src/views/SettingsView.tsx` (添加 Slack Webhook URL 配置)
- Modify: `desktop/src/views/FeedbackView.tsx` (FeedbackHeader 添加 Export to Slack 按钮)

**Step 1: Add Slack Webhook config in Settings**

在 SettingsView.tsx 中添加新的 section：

```typescript
{/* Slack Integration */}
<Card className="p-5">
  <h3 className="text-sm font-semibold text-ink mb-3">Slack Integration</h3>
  <label className="text-xs text-ink-secondary">Incoming Webhook URL</label>
  <input
    type="url"
    placeholder="https://hooks.slack.com/services/..."
    value={slackWebhookUrl}
    onChange={(e) => setSlackWebhookUrl(e.target.value)}
    onBlur={() => localStorage.setItem('ifb_slack_webhook', slackWebhookUrl)}
    className="mt-1 w-full px-3 py-1.5 text-sm border border-border rounded-[--radius-button] bg-white"
  />
  <p className="text-xs text-ink-tertiary mt-1">
    Create a Slack app with Incoming Webhooks enabled and paste the URL here.
  </p>
</Card>
```

**Step 2: Add Export to Slack button and handler in FeedbackHeader**

```typescript
const handleExportSlack = async () => {
  const webhookUrl = localStorage.getItem('ifb_slack_webhook');
  if (!webhookUrl) {
    alert('Please configure Slack Webhook URL in Settings first.');
    return;
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📋 ${report.session_name}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Date:* ${report.date} | *Duration:* ${report.durationLabel || '—'} | *Mode:* ${report.mode}` } },
  ];

  // Add recommendation if available
  if (report.overall.recommendation) {
    const rec = report.overall.recommendation;
    const emoji = rec.decision === 'recommend' ? '✅' : rec.decision === 'tentative' ? '⚠️' : '❌';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${rec.decision.toUpperCase()}* — ${rec.rationale}` } });
  }

  // Add per-person scores
  for (const person of report.persons) {
    const scores = person.dimensions.map(d => `${d.label_zh || d.dimension}: ${d.score ?? '—'}`).join(' | ');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${person.person_name}:* ${scores}` } });
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });
  } catch (err) {
    console.warn('Slack export failed:', err);
  }
};
```

Button:

```typescript
<Button variant="secondary" size="sm" onClick={handleExportSlack} className="transition-all duration-200">
  <MessageSquare className="w-3.5 h-3.5" />
  Share to Slack
</Button>
```

**Step 3: Build and commit**

```bash
cd desktop && npx tsc --noEmit && npx vite build
git add desktop/src/views/SettingsView.tsx desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): add Slack export via Incoming Webhook"
```

---

## Verification Checklist

After all tasks complete:

```bash
# Full build check
cd desktop && npx tsc --noEmit && npx vite build && npx vitest run

# Inference tests
cd inference && python -m pytest tests/ -v

# Manual testing
# 1. Open app, verify Upcoming Meetings grouped by date
# 2. Open Wei Yixin session, verify:
#    - Re-generate shows SplitButton dropdown
#    - Double-click any claim text to edit
#    - Communication Metrics visible per person
#    - Export PDF saves file
# 3. Group interview session:
#    - Candidate Comparison table visible
# 4. After backend deployed:
#    - Recommendation badge at top
#    - Question breakdown section
#    - Interview Quality collapsible
#    - Follow-up questions in person section
#    - Action plan at bottom
#    - Slack export working
```
