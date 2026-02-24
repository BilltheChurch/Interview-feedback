# Report System Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the report system with dynamic dimensions (0-10 scoring), footnote-style evidence citations, Split View transcript panel, and tiered evidence sources.

**Architecture:** Changes span 4 layers: types_v2.ts (data model), Worker (evidence tier filtering + session config), inference (LLM prompt), Desktop (FeedbackView + SetupView + new components). Backward compatibility preserved for old reports.

**Tech Stack:** TypeScript, Cloudflare Workers, Python/FastAPI, React, Tailwind v4, @tanstack/react-virtual

**Design Doc:** `docs/plans/2026-02-24-report-redesign-design.md`

---

## Task 1: Data Model — Type Definitions

**Files:**
- Modify: `edge/worker/src/types_v2.ts`

**Step 1: Update DimensionFeedback interface**

Replace the existing `DimensionFeedback` interface (lines 140-145) with:

```typescript
export interface DimensionFeedback {
  dimension: string;                     // Free string, no longer a 5-value enum
  label_zh?: string;                     // Chinese display name, e.g. "逻辑推理"
  score: number;                         // 0-10, LLM-assigned
  score_rationale: string;               // 1-2 sentence scoring justification
  evidence_insufficient?: boolean;       // true if insufficient evidence to evaluate
  not_applicable?: boolean;              // true if LLM deems dimension irrelevant
  strengths: DimensionClaim[];           // 0-5 items
  risks: DimensionClaim[];               // 0-3 items
  actions: DimensionClaim[];             // 0-3 items
}
```

Note: keep the old type alias for backward compat:

```typescript
/** @deprecated Use string dimension keys instead */
export type LegacyDimensionName = "leadership" | "collaboration" | "logic" | "structure" | "initiative";
```

**Step 2: Add EvidenceItem source_tier**

Add to the existing `EvidenceItem` interface (after `source?` field at line 129):

```typescript
  source_tier?: 1 | 2 | 3;              // 1=candidate speech, 2=memo, 3=interviewer evaluative
  source_tier_label?: string;            // "面试者发言" | "面试官观察" | "辅助佐证"
```

**Step 3: Add dimension preset types**

Append after the `CaptionSource` type (end of file):

```typescript
// ── Dimension Presets ──────────────────────────────────────────────────

export interface DimensionPresetItem {
  key: string;                           // "logical_reasoning"
  label_zh: string;                      // "逻辑推理"
  label_en: string;                      // "Logical Reasoning"
  description: string;                   // LLM evaluation guidance
  weight: number;                        // default 1.0
}

export interface DimensionPresetTemplate {
  interview_type: string;                // "academic" | "technical" | "behavioral" | "group"
  label_zh: string;                      // "学术面试"
  dimensions: DimensionPresetItem[];
}

export interface SuggestedDimension {
  key: string;
  label_zh: string;
  reason: string;
  action: "add" | "replace" | "mark_not_applicable";
  replaces?: string;
}
```

**Step 4: Update OverallFeedback in ResultV2**

The current `overall` field in `ResultV2` is typed as `unknown` (line 208). Add a proper type:

```typescript
export interface OverallFeedback {
  /** New narrative format */
  narrative?: string;
  narrative_evidence_refs?: string[];
  key_findings?: Array<{
    type: "strength" | "risk" | "observation";
    text: string;
    evidence_refs: string[];
  }>;
  suggested_dimensions?: SuggestedDimension[];
  /** Legacy format (backward compat) */
  summary_sections?: Array<{
    topic: string;
    bullets: string[];
    evidence_ids: string[];
  }>;
  team_dynamics?: {
    highlights: string[];
    risks: string[];
  };
}
```

Update `ResultV2.overall` type from `unknown` to `OverallFeedback`.

**Step 5: Update SessionContextMeta**

Add to existing `SessionContextMeta` interface (lines 285-291):

```typescript
  interview_type?: string;               // "academic" | "technical" | "behavioral" | "group"
  dimension_presets?: DimensionPresetItem[];
```

**Step 6: Run typecheck**

Run: `cd edge/worker && npm run typecheck`
Expected: May show errors in files that depend on the old DimensionFeedback enum — note them for later tasks.

**Step 7: Commit**

```bash
git add edge/worker/src/types_v2.ts
git commit -m "feat(types): redesign dimension model with scoring and evidence tiers"
```

---

## Task 2: Dimension Preset Templates

**Files:**
- Create: `edge/worker/src/dimension-presets.ts`
- Create: `desktop/src/lib/dimensionPresets.ts`

**Step 1: Create Worker-side presets**

Create `edge/worker/src/dimension-presets.ts`:

```typescript
import type { DimensionPresetTemplate } from "./types_v2";

export const DIMENSION_PRESETS: DimensionPresetTemplate[] = [
  {
    interview_type: "academic",
    label_zh: "学术面试",
    dimensions: [
      { key: "academic_motivation", label_zh: "学术动机", label_en: "Academic Motivation", description: "对目标项目/专业的理解深度、选择理由的逻辑性", weight: 1.0 },
      { key: "domain_knowledge", label_zh: "专业知识", label_en: "Domain Knowledge", description: "学科基础掌握程度、跨学科知识整合能力", weight: 1.0 },
      { key: "logical_reasoning", label_zh: "逻辑推理", label_en: "Logical Reasoning", description: "问题分析与推导能力、论证的严密性", weight: 1.0 },
      { key: "expression_structure", label_zh: "表达结构", label_en: "Expression & Structure", description: "回答的组织性、清晰度和说服力", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "提问意愿、探索精神、独立思考能力", weight: 1.0 },
    ],
  },
  {
    interview_type: "technical",
    label_zh: "技术面试",
    dimensions: [
      { key: "problem_analysis", label_zh: "问题分析", label_en: "Problem Analysis", description: "理解问题本质、拆解复杂需求的能力", weight: 1.0 },
      { key: "coding_ability", label_zh: "代码能力", label_en: "Coding Ability", description: "代码质量、算法选择、边界处理", weight: 1.0 },
      { key: "system_design", label_zh: "系统设计", label_en: "System Design", description: "架构思维、扩展性考虑、权衡取舍", weight: 1.0 },
      { key: "communication", label_zh: "沟通表达", label_en: "Communication", description: "技术方案阐述的清晰度、与面试官的互动质量", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "主动提问、考虑边界条件、探索优化方案", weight: 1.0 },
    ],
  },
  {
    interview_type: "behavioral",
    label_zh: "行为面试",
    dimensions: [
      { key: "leadership", label_zh: "领导力", label_en: "Leadership", description: "在团队情境中的引导能力、决策承担", weight: 1.0 },
      { key: "collaboration", label_zh: "协作能力", label_en: "Collaboration", description: "团队合作意识、冲突处理、支持他人", weight: 1.0 },
      { key: "resilience", label_zh: "抗压能力", label_en: "Resilience", description: "面对挫折的应对策略、情绪管理", weight: 1.0 },
      { key: "self_awareness", label_zh: "自我认知", label_en: "Self-Awareness", description: "对自身优劣势的认识、成长反思", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "超越基本要求的行动、独立解决问题", weight: 1.0 },
    ],
  },
  {
    interview_type: "group",
    label_zh: "小组面试",
    dimensions: [
      { key: "leadership", label_zh: "领导力", label_en: "Leadership", description: "议题推进、节奏把控、引导方向", weight: 1.0 },
      { key: "collaboration", label_zh: "协作能力", label_en: "Collaboration", description: "倾听、回应他人观点、建设性互动", weight: 1.0 },
      { key: "logical_reasoning", label_zh: "逻辑推理", label_en: "Logical Reasoning", description: "论证结构、数据运用、分析深度", weight: 1.0 },
      { key: "expression_structure", label_zh: "表达结构", label_en: "Expression & Structure", description: "发言组织性、重点突出、时间管理", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "首发发言、引入新视角、主动总结", weight: 1.0 },
    ],
  },
];

export function getPresetByType(interviewType: string): DimensionPresetTemplate | undefined {
  return DIMENSION_PRESETS.find((p) => p.interview_type === interviewType);
}
```

**Step 2: Create Desktop-side copy**

Create `desktop/src/lib/dimensionPresets.ts` — same content but with Desktop-compatible imports:

```typescript
export interface DimensionPresetItem {
  key: string;
  label_zh: string;
  label_en: string;
  description: string;
  weight: number;
}

export interface DimensionPresetTemplate {
  interview_type: string;
  label_zh: string;
  dimensions: DimensionPresetItem[];
}

// Same DIMENSION_PRESETS array and getPresetByType function as Worker version
```

**Step 3: Commit**

```bash
git add edge/worker/src/dimension-presets.ts desktop/src/lib/dimensionPresets.ts
git commit -m "feat: add dimension preset templates for interview types"
```

---

## Task 3: Evidence Tier Classification (Worker)

**Files:**
- Modify: `edge/worker/src/finalize_v2.ts` (buildEvidence function, ~line 904)
- Create: `edge/worker/tests/evidence-tier.test.ts`

**Step 1: Write evidence tier tests**

Create `edge/worker/tests/evidence-tier.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyTeacherUtterance } from "../src/finalize_v2";

describe("classifyTeacherUtterance", () => {
  it("returns tier_3 for evaluative utterances > 10 chars", () => {
    expect(classifyTeacherUtterance("你的分析框架很到位，逻辑清晰")).toBe(3);
    expect(classifyTeacherUtterance("That's an excellent point about the system")).toBe(3);
  });

  it("returns null for non-evaluative utterances", () => {
    expect(classifyTeacherUtterance("好的")).toBeNull();
    expect(classifyTeacherUtterance("That's correct")).toBeNull();
    expect(classifyTeacherUtterance("请继续")).toBeNull();
    expect(classifyTeacherUtterance("下一题")).toBeNull();
  });

  it("returns null for short evaluative utterances", () => {
    expect(classifyTeacherUtterance("很好")).toBeNull();  // < 10 chars
    expect(classifyTeacherUtterance("不错")).toBeNull();
  });
});
```

**Step 2: Run test, verify fail**

Run: `cd edge/worker && npx vitest run tests/evidence-tier.test.ts`
Expected: FAIL — `classifyTeacherUtterance` not found

**Step 3: Implement tier classification**

In `edge/worker/src/finalize_v2.ts`, add before `buildEvidence`:

```typescript
const EVALUATIVE_KEYWORDS_ZH = ["很好", "不错", "到位", "准确", "优秀", "出色", "需要改进", "不太对", "有进步", "深入", "清晰", "有趣"];
const EVALUATIVE_KEYWORDS_EN = ["excellent", "good point", "impressive", "well done", "insightful", "needs improvement", "not quite", "interesting", "strong", "weak"];

/** Classify a teacher utterance: returns 3 (tier_3 evaluative) or null (exclude). */
export function classifyTeacherUtterance(text: string): 3 | null {
  if (text.length <= 10) return null;
  const lower = text.toLowerCase();
  const hasEval = EVALUATIVE_KEYWORDS_ZH.some((k) => lower.includes(k))
    || EVALUATIVE_KEYWORDS_EN.some((k) => lower.includes(k));
  return hasEval ? 3 : null;
}
```

**Step 4: Update buildEvidence to assign source_tier**

In the existing `buildEvidence` function, add `source_tier` to each EvidenceItem:
- Memo-based evidence → `source_tier: 2, source_tier_label: "面试官观察"`
- Transcript-based evidence from students stream → `source_tier: 1, source_tier_label: "面试者发言"`
- Transcript-based evidence from teacher stream (evaluative) → `source_tier: 3, source_tier_label: "辅助佐证"`

**Step 5: Run tests, verify pass**

Run: `cd edge/worker && npx vitest run`
Expected: All tests pass including new evidence-tier tests

**Step 6: Commit**

```bash
git add edge/worker/src/finalize_v2.ts edge/worker/tests/evidence-tier.test.ts
git commit -m "feat(worker): classify evidence by source tier (candidate/memo/interviewer)"
```

---

## Task 4: Session Config — Dimension Presets

**Files:**
- Modify: `edge/worker/src/index.ts` (session config handler + finalize payload)
- Modify: `desktop/src/types/desktop-api.d.ts`
- Modify: `desktop/main.js` (IPC handler)

**Step 1: Store dimension_presets in DO**

In `edge/worker/src/index.ts`, find the session config POST handler (route regex includes `config`). After existing config fields, add persistence:

```typescript
// Inside the config POST handler, after storing existing fields:
const dimensionPresets = payload.dimension_presets;
const interviewType = payload.interview_type;
if (dimensionPresets && Array.isArray(dimensionPresets)) {
  state.config.dimension_presets = dimensionPresets;
}
if (interviewType && typeof interviewType === "string") {
  state.config.interview_type = interviewType;
}
```

**Step 2: Pass dimension_presets to LLM synthesis**

In `runFinalizeV2Job`, when building the synthesis payload (the call to `invokeInferenceAnalysisReport`), include:

```typescript
session_context: {
  mode: state.config?.mode ?? "1v1",
  interviewer_name: state.config?.interviewer_name,
  position_title: state.config?.position_title,
  company_name: state.config?.company_name,
  interview_type: state.config?.interview_type,
  dimension_presets: state.config?.dimension_presets,
  stage_descriptions: state.config?.stages?.map((s, i) => ({ stage_index: i, stage_name: s })) ?? [],
},
```

**Step 3: Update Desktop types**

In `desktop/src/types/desktop-api.d.ts`, find the session config payload type and add:

```typescript
interview_type?: string;
dimension_presets?: Array<{
  key: string;
  label_zh: string;
  label_en: string;
  description: string;
  weight: number;
}>;
```

**Step 4: Run typechecks**

Run: `cd edge/worker && npm run typecheck && cd ../../desktop && npx tsc --noEmit`
Expected: Pass (fix any type errors from Task 1 dimension enum change)

**Step 5: Commit**

```bash
git add edge/worker/src/index.ts desktop/src/types/desktop-api.d.ts desktop/main.js
git commit -m "feat: persist dimension_presets in session config and pass to LLM"
```

---

## Task 5: LLM Prompt Redesign (Inference)

**Files:**
- Modify: `inference/app/services/report_synthesizer.py` (system prompt + output contract)
- Modify: `inference/tests/test_report_synthesizer.py`

**Step 1: Rewrite system prompt rules**

Replace the current 21 rules (lines ~319-354) with the redesigned rules. Key changes:

1. Replace rule #7 "evaluate ALL 5 dimensions" with: "Use `session_context.dimension_presets` as the evaluation framework. For each preset dimension, assign a 0-10 score."
2. Add scoring scale definition (0-2 severe, 3-4 weak, 5-6 adequate, 7-8 good, 9-10 excellent)
3. Add rule: "claim.text MUST be pure natural language — do NOT embed [e_XXXXX] references in text"
4. Add rule: "Prioritize tier_1 evidence (candidate speech). tier_3 (interviewer evaluative) is supplementary only."
5. Add rule: "Generate `overall.narrative` as a cohesive paragraph anchored to `session_context.position_title`, not bullet lists."
6. Add rule: "If a preset dimension cannot be evaluated, set `not_applicable: true` and `score: 5`."
7. Add rule: "Output `suggested_dimensions` if the interview content suggests dimensions not in presets."
8. Replace rule #20 "2 summary_sections" with: "Generate `narrative` (2-4 sentences) + ≥3 `key_findings`."

**Step 2: Rewrite output_contract**

Replace the existing output_contract (lines ~446-468) with:

```python
"output_contract": {
    "overall": {
        "narrative": "string — cohesive 2-4 sentence paragraph, NO [e_XXXXX] references",
        "narrative_evidence_refs": ["e_XXXXX"],
        "key_findings": [
            {
                "type": "strength|risk|observation",
                "text": "string — pure text, no citations",
                "evidence_refs": ["e_XXXXX"]
            }
        ],
        "suggested_dimensions": [
            {
                "key": "string",
                "label_zh": "string",
                "reason": "string",
                "action": "add|replace|mark_not_applicable",
                "replaces": "string|null"
            }
        ]
    },
    "per_person": [
        {
            "person_key": "string",
            "display_name": "string",
            "dimensions": [
                {
                    "dimension": "string (from dimension_presets[].key)",
                    "label_zh": "string (from dimension_presets[].label_zh)",
                    "score": 8.5,
                    "score_rationale": "string — 1-2 sentences",
                    "evidence_insufficient": false,
                    "not_applicable": false,
                    "strengths": [
                        {
                            "claim_id": "c_{person}_{dim}_{nn}",
                            "text": "string — pure natural language, NO [e_XXXXX]",
                            "evidence_refs": ["e_XXXXX"],
                            "confidence": 0.85,
                            "supporting_utterances": ["utterance_id"]
                        }
                    ],
                    "risks": [...],
                    "actions": [...]
                }
            ],
            "summary": {
                "strengths": ["string"],
                "risks": ["string"],
                "actions": ["string"]
            }
        }
    ]
}
```

**Step 3: Update evidence_pack construction**

In the user prompt builder, include `source_tier` in each evidence item:

```python
"evidence_pack": [
    {
        "evidence_id": "e_000001",
        "speaker_key": "Alice",
        "source_tier": 1,  # 1=candidate, 2=memo, 3=interviewer evaluative
        "time_range_ms": [1000, 3000],
        "quote": "..."
    }
]
```

**Step 4: Add interview context anchoring**

Before the rules section in the system prompt, add:

```python
f"你正在为以下面试生成评估报告：\n"
f"- 面试类型: {session_context.get('interview_type', '未指定')}\n"
f"- 目标职位/项目: {session_context.get('position_title', '未指定')}"
f"{' @ ' + session_context['company_name'] if session_context.get('company_name') else ''}\n"
f"- 面试官: {session_context.get('interviewer_name', '未指定')}\n"
f"\n所有评价必须围绕候选人是否适合「{session_context.get('position_title', '该职位')}」展开。"
f"不要给出泛泛的能力评估——每个 claim 都要与目标职位/项目的具体要求关联。\n\n"
```

**Step 5: Add dimension_presets to user prompt**

Include the dimension definitions in the user prompt:

```python
if session_context.get("dimension_presets"):
    prompt += "evaluation_dimensions:\n"
    for dim in session_context["dimension_presets"]:
        prompt += f"  - key: {dim['key']}, label: {dim['label_zh']}, guidance: {dim['description']}\n"
```

**Step 6: Update response parsing**

In the response parser, handle the new fields:
- Extract `score`, `score_rationale`, `evidence_insufficient`, `not_applicable` from each dimension
- Extract `overall.narrative`, `narrative_evidence_refs`, `key_findings`, `suggested_dimensions`
- Fallback: if LLM returns old format (summary_sections), convert to new format

**Step 7: Update tests**

Update `inference/tests/test_report_synthesizer.py` to validate:
- New output contract fields
- Score range 0-10
- No `[e_XXXXX]` in claim text
- `suggested_dimensions` presence

**Step 8: Run tests**

Run: `cd inference && python -m pytest tests/test_report_synthesizer.py -v`
Expected: All tests pass

**Step 9: Commit**

```bash
git add inference/app/services/report_synthesizer.py inference/tests/test_report_synthesizer.py
git commit -m "feat(inference): redesign LLM prompt with dynamic dimensions and 0-10 scoring"
```

---

## Task 6: Frontend — Footnote Component

**Files:**
- Create: `desktop/src/components/ui/FootnoteRef.tsx`
- Create: `desktop/src/components/ui/FootnoteList.tsx`

**Step 1: Create FootnoteRef (superscript number)**

```tsx
type FootnoteRefProps = {
  index: number;                     // 1-based
  onClick?: () => void;
};

export function FootnoteRef({ index, onClick }: FootnoteRefProps) {
  return (
    <sup
      className="cursor-pointer text-accent hover:underline font-medium text-[10px] ml-0.5"
      onClick={onClick}
      role="button"
      aria-label={`Footnote ${index}`}
    >
      {index}
    </sup>
  );
}
```

**Step 2: Create FootnoteList (bottom section)**

```tsx
type FootnoteEntry = {
  index: number;
  timestamp: string;                 // "02:20"
  speaker: string;
  quote: string;                     // max 80 chars
  evidenceId: string;
  onClick?: () => void;              // Jump to transcript
};

type FootnoteListProps = {
  entries: FootnoteEntry[];
  onFootnoteClick?: (evidenceId: string) => void;
};

export function FootnoteList({ entries, onFootnoteClick }: FootnoteListProps) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-4 pt-3 border-t border-border/50 space-y-1.5">
      {entries.map((e) => (
        <div
          key={e.index}
          className="flex gap-2 text-xs text-secondary cursor-pointer hover:text-ink transition-colors"
          onClick={() => onFootnoteClick?.(e.evidenceId)}
        >
          <span className="text-accent font-medium shrink-0">{e.index}</span>
          <span className="text-secondary/60">[{e.timestamp}]</span>
          <span className="font-medium">{e.speaker}:</span>
          <span className="truncate italic">"{e.quote}"</span>
        </div>
      ))}
    </div>
  );
}
```

**Step 3: Create useFootnotes hook**

```tsx
// desktop/src/hooks/useFootnotes.ts
export function useFootnotes(evidenceRefs: string[], evidenceMap: Map<string, EvidenceItem>) {
  // Maps evidence_refs to sequential footnote numbers within a section
  // Returns { footnoteEntries, getFootnoteIndex(evidenceId) }
}
```

**Step 4: Commit**

```bash
git add desktop/src/components/ui/FootnoteRef.tsx desktop/src/components/ui/FootnoteList.tsx desktop/src/hooks/useFootnotes.ts
git commit -m "feat(ui): add footnote reference and list components"
```

---

## Task 7: Frontend — CompetencyRadar Redesign

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` (CompetencyRadar component, ~lines 2048-2167)

**Step 1: Update CompetencyRadar props and scoring**

```tsx
function CompetencyRadar({
  dimensions,
}: {
  dimensions: DimensionFeedback[];
}) {
  // Filter out not_applicable dimensions
  const activeDims = dimensions.filter((d) => !d.not_applicable);
  if (activeDims.length < 3) return null;

  const n = activeDims.length;
  const cx = 90, cy = 90, r = 70;
  const maxScore = 10;

  // Score comes directly from dimension.score (0-10)
  const scores = activeDims.map((d) => d.score / maxScore);  // normalize to 0-1

  // Grid rings at 2.5, 5.0, 7.5, 10
  const gridLevels = [0.25, 0.5, 0.75, 1.0];

  // ... SVG rendering with:
  // - Dynamic number of axes (3-6)
  // - Axis labels: "{label_zh} {score}" (e.g. "逻辑推理 8.5")
  // - Low score (<4) labels in risk color
  // - Grid ring labels: "2.5", "5.0", "7.5", "10"
}
```

**Step 2: Run typecheck and build**

Run: `cd desktop && npx tsc --noEmit && npx vite build`

**Step 3: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "feat(ui): radar chart with dynamic axes and 0-10 LLM scoring"
```

---

## Task 8: Frontend — Split View Layout

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` (main layout)
- Modify: `desktop/src/components/TranscriptSection.tsx` (add highlight + scroll-to support)

**Step 1: Add Split View wrapper**

Wrap the FeedbackView main content in a flex container:

```tsx
<div className="flex h-full">
  {/* Main content area */}
  <div className={`flex-1 overflow-y-auto ${transcriptOpen ? 'w-[60%]' : 'w-full'} transition-all`}>
    {/* Existing section nav + content */}
  </div>

  {/* Transcript sidebar */}
  {transcriptOpen && (
    <div className="w-[40%] border-l border-border flex flex-col">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <span className="text-sm font-medium">Transcript</span>
        <button onClick={() => setTranscriptOpen(false)}>
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>
      <TranscriptSection
        transcript={report.transcript}
        evidenceMap={report.utteranceEvidenceMap}
        onEvidenceBadgeClick={handleEvidenceClick}
        scrollToUtteranceId={scrollToUtteranceId}
        highlightedUtteranceIds={highlightedUtteranceIds}
      />
    </div>
  )}
</div>
```

**Step 2: Add transcript toggle button**

In the header area, add a toggle:

```tsx
<button
  onClick={() => setTranscriptOpen(!transcriptOpen)}
  className="flex items-center gap-1.5 text-sm text-secondary hover:text-ink"
>
  <PanelRight className="w-4 h-4" />
  Transcript
</button>
```

**Step 3: Add highlight support to TranscriptSection**

Add `highlightedUtteranceIds?: Set<string>` prop to TranscriptSection. When an utterance_id is in the set, apply accent left-border styling.

**Step 4: Wire footnote click → transcript scroll**

When a footnote is clicked:
1. Find the evidence → get its `utterance_ids`
2. Set `scrollToUtteranceId` state
3. Set `highlightedUtteranceIds` state
4. Open transcript panel if closed

**Step 5: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx desktop/src/components/TranscriptSection.tsx
git commit -m "feat(ui): Split View layout with Transcript sidebar and footnote linking"
```

---

## Task 9: Frontend — normalizeApiReport + Team Summary

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` (normalizeApiReport, Team Summary rendering)

**Step 1: Update normalizeApiReport for new data model**

Handle both old and new formats:

```typescript
function normalizeApiReport(raw: any, sessionMeta?: any): FeedbackReport {
  // ... existing participant extraction ...

  // Team Summary — handle new narrative format
  let teamSummary = '';
  let teamSummaryEvidenceRefs: string[] = [];
  const overall = raw.overall;
  if (overall?.narrative) {
    // New format
    teamSummary = overall.narrative;
    teamSummaryEvidenceRefs = overall.narrative_evidence_refs ?? [];
  } else if (overall?.summary_sections) {
    // Legacy format — flatten bullets
    teamSummary = overall.summary_sections.map(s => s.bullets?.join(' ')).join('\n\n');
  }

  // Key findings
  const keyFindings = overall?.key_findings ?? [];
  const suggestedDimensions = overall?.suggested_dimensions ?? [];

  // Dimensions — handle score field
  // For each person's dimensions, use score directly (fallback to ratio calc for old data)
  const persons = (raw.per_person ?? []).map(p => ({
    ...p,
    dimensions: (p.dimensions ?? []).map(d => ({
      ...d,
      score: d.score ?? calculateLegacyScore(d),  // fallback for old reports
      score_rationale: d.score_rationale ?? '',
      label_zh: d.label_zh ?? legacyDimensionLabel(d.dimension),
    })),
  }));

  // ... rest of normalization ...
}

function calculateLegacyScore(dim: any): number {
  const total = (dim.strengths?.length ?? 0) + (dim.risks?.length ?? 0) + (dim.actions?.length ?? 0);
  if (total === 0) return 5;
  const strengthRatio = (dim.strengths?.length ?? 0) / total;
  return Math.round(strengthRatio * 10 * 10) / 10;  // 0-10 scale
}

function legacyDimensionLabel(dimension: string): string {
  const map: Record<string, string> = {
    leadership: '领导力', collaboration: '协作能力', logic: '逻辑推理',
    structure: '表达结构', initiative: '主动性',
  };
  return map[dimension] ?? dimension;
}
```

**Step 2: Render Team Summary with footnotes**

Replace the existing summary rendering with narrative + footnotes:

```tsx
{/* Team Summary Section */}
<div className="prose prose-sm max-w-none">
  <p className="text-ink leading-relaxed">
    {renderTextWithFootnotes(teamSummary, teamSummaryEvidenceRefs, evidenceMap, onFootnoteClick)}
  </p>
  <FootnoteList entries={footnoteEntries} onFootnoteClick={handleFootnoteClick} />
</div>
```

**Step 3: Add interview metadata header**

```tsx
<div className="flex items-center gap-3 text-xs text-secondary mb-4">
  <span>{report.date}</span>
  <span>·</span>
  <span>{report.durationLabel}</span>
  {report.interviewType && <><span>·</span><span>{report.interviewTypeLabel}</span></>}
  {report.positionTitle && <><span>·</span><span>目标: {report.positionTitle}</span></>}
</div>
```

**Step 4: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "feat(ui): team summary with narrative format and footnote citations"
```

---

## Task 10: Frontend — Evidence Section Redesign

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` (Evidence section)

**Step 1: Create EvidenceCard component**

```tsx
function EvidenceCard({ evidence, claimCount, dimensions, onTimestampClick }: {
  evidence: EvidenceItem;
  claimCount: number;
  dimensions: string[];  // dimension labels that reference this evidence
  onTimestampClick: (evidenceId: string) => void;
}) {
  const tierConfig = {
    1: { color: 'bg-emerald-50 border-emerald-200', icon: '🟢', label: '面试者发言' },
    2: { color: 'bg-blue-50 border-blue-200', icon: '🔵', label: '面试官观察' },
    3: { color: 'bg-gray-50 border-gray-200', icon: '⚪', label: '辅助佐证' },
  }[evidence.source_tier ?? 1];

  return (
    <div className={`rounded-lg border p-3 ${tierConfig.color}`}>
      <div className="flex items-center gap-2 text-xs text-secondary mb-1.5">
        <span>{tierConfig.icon} {tierConfig.label}</span>
      </div>
      <p className="text-sm text-ink leading-relaxed">"{evidence.quote}"</p>
      <div className="flex items-center gap-3 mt-2 text-xs text-secondary">
        <span
          className="cursor-pointer hover:text-accent"
          onClick={() => onTimestampClick(evidence.evidence_id)}
        >
          {evidence.speaker?.display_name ?? '?'} · {formatTimestamp(evidence.time_range_ms?.[0])}
        </span>
        <span>被引用 {claimCount} 次</span>
        {dimensions.length > 0 && (
          <span>关联: {dimensions.join(', ')}</span>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Add tier filtering and sorting**

```tsx
const [tierFilter, setTierFilter] = useState<'all' | 1 | 2 | 3>('all');
const [sortBy, setSortBy] = useState<'time' | 'citations' | 'dimension'>('time');

// Filter: tier_3 collapsed by default
const filteredEvidence = evidence
  .filter(e => tierFilter === 'all' ? (e.source_tier !== 3 || showTier3) : e.source_tier === tierFilter)
  .sort(/* by sortBy */);
```

**Step 3: Limit display with "show more"**

```tsx
const TIER_LIMITS = { 1: 30, 2: Infinity, 3: 10 };
// Show limited items with "显示更多" button
```

**Step 4: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "feat(ui): evidence section with tier-based cards and filtering"
```

---

## Task 11: Frontend — Claim Rendering with Footnotes

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` (claim card rendering, ~lines 1453-1476)

**Step 1: Replace EvidenceChip with FootnoteRef in claims**

Current code renders `EvidenceChip` for each `evidence_ref`. Replace with `FootnoteRef`:

```tsx
{/* Before: EvidenceChip per evidence_ref */}
{/* After: Footnote superscripts */}
<p className="text-sm text-ink leading-relaxed">
  {claim.text}
  {claim.evidence_refs.map((refId, i) => (
    <FootnoteRef
      key={refId}
      index={sectionFootnoteIndex(refId)}
      onClick={() => handleFootnoteClick(refId)}
    />
  ))}
</p>
```

**Step 2: Add score display to dimension headers**

```tsx
<div className="flex items-center gap-2">
  <DimensionIcon dimension={dim.dimension} />
  <span className="font-medium">{dim.label_zh ?? dim.dimension}</span>
  <span className={`text-sm font-mono ${dim.score < 4 ? 'text-risk' : dim.score >= 8 ? 'text-accent' : 'text-secondary'}`}>
    {dim.score.toFixed(1)}
  </span>
  {dim.not_applicable && <span className="text-xs text-secondary/50">不适用</span>}
</div>
<p className="text-xs text-secondary mt-0.5">{dim.score_rationale}</p>
```

**Step 3: Add FootnoteList at bottom of each person section**

Each person's section collects all footnote entries from their claims and renders a `FootnoteList` at the bottom.

**Step 4: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "feat(ui): replace evidence chips with footnote references in claims"
```

---

## Task 12: Frontend — SetupView Dimension Config

**Files:**
- Modify: `desktop/src/views/SetupView.tsx`

**Step 1: Add interview type selector**

In Step 2 (or a new step between current steps), add:

```tsx
<div className="space-y-3">
  <Label>面试类型</Label>
  <div className="flex gap-2">
    {DIMENSION_PRESETS.map((preset) => (
      <button
        key={preset.interview_type}
        className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
          interviewType === preset.interview_type
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-border text-secondary hover:border-accent/50'
        }`}
        onClick={() => {
          setInterviewType(preset.interview_type);
          setDimensionPresets(preset.dimensions);
        }}
      >
        {preset.label_zh}
      </button>
    ))}
  </div>
</div>
```

**Step 2: Add dimension list with edit capability**

```tsx
<div className="space-y-2 mt-4">
  <Label>评估维度 <span className="text-secondary text-xs">(3-6 个)</span></Label>
  {dimensionPresets.map((dim, i) => (
    <div key={dim.key} className="flex items-center gap-2 p-2 rounded-lg bg-surface border border-border">
      <CheckSquare className="w-4 h-4 text-accent" />
      <span className="text-sm font-medium">{dim.label_zh}</span>
      <span className="text-xs text-secondary flex-1">{dim.description}</span>
      <button onClick={() => removeDimension(i)}>
        <X className="w-3.5 h-3.5 text-secondary hover:text-risk" />
      </button>
    </div>
  ))}
  {dimensionPresets.length < 6 && (
    <button onClick={openAddDimensionDialog} className="text-xs text-accent hover:underline">
      + 添加维度
    </button>
  )}
</div>
```

**Step 3: Include in session config payload**

When starting the session, include `interview_type` and `dimension_presets` in the config POST.

**Step 4: Commit**

```bash
git add desktop/src/views/SetupView.tsx
git commit -m "feat(ui): interview type selector with dimension preset configuration"
```

---

## Task 13: Frontend — LLM Dimension Suggestion UI

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx`

**Step 1: Add suggestion banner**

When `report.suggestedDimensions` is non-empty, show a banner in the Summary section:

```tsx
{suggestedDimensions.length > 0 && (
  <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 mt-4">
    <div className="flex items-center gap-2 text-sm font-medium text-accent mb-2">
      <Lightbulb className="w-4 h-4" />
      AI 建议
    </div>
    <div className="space-y-1.5">
      {suggestedDimensions.map((s) => (
        <p key={s.key} className="text-sm text-ink">
          • {s.action === 'add' ? '新增' : s.action === 'mark_not_applicable' ? '标记不适用' : '替换'}
          「{s.label_zh}」— {s.reason}
        </p>
      ))}
    </div>
    <div className="flex gap-2 mt-3">
      <button
        className="px-3 py-1 rounded-md bg-accent text-white text-xs"
        onClick={handleAcceptSuggestions}
      >
        接受建议
      </button>
      <button
        className="px-3 py-1 rounded-md border border-border text-xs text-secondary"
        onClick={() => setSuggestedDimensions([])}
      >
        保持原维度
      </button>
    </div>
  </div>
)}
```

**Step 2: Implement handleAcceptSuggestions**

When accepted: update session config with adjusted dimensions, trigger report-only re-generate.

**Step 3: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "feat(ui): LLM dimension suggestion banner with accept/reject"
```

---

## Task 14: Backward Compatibility + Legacy Rendering

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx`

**Step 1: Add legacy detection in normalizeApiReport**

```typescript
// Detect old vs new format
const isLegacyFormat = raw.per_person?.[0]?.dimensions?.[0]?.score === undefined;
```

**Step 2: Strip [e_XXXXX] from legacy text**

For old reports where claim.text contains `[e_XXXXX]`:

```typescript
function stripInlineEvidenceRefs(text: string): { cleanText: string; extractedRefs: string[] } {
  const refs: string[] = [];
  const clean = text.replace(/\[e_\d+\]/g, (match) => {
    refs.push(match.slice(1, -1));  // "e_000921"
    return '';
  });
  return { cleanText: clean.trim(), extractedRefs: refs };
}
```

Apply this during normalization for legacy claims. Merge extracted refs into `evidence_refs`.

**Step 3: Legacy radar chart fallback**

In CompetencyRadar, if `score` is undefined, fallback to strength-ratio calculation.

**Step 4: Legacy overall fallback**

If `overall.narrative` is undefined but `summary_sections` exists, render as bullet list (current behavior).

**Step 5: Run full test suite**

Run: `cd desktop && npx vitest run && npx tsc --noEmit && npx vite build`
Expected: All 65+ tests pass, build succeeds

**Step 6: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "feat(ui): backward compatibility for legacy report format"
```

---

## Task 15: Integration Test + Smoke Test

**Files:**
- Modify: `scripts/smoke_caption_session.mjs` (extend with dimension checks)
- Run: Full test suites

**Step 1: Update smoke test**

Add checks for new fields in the smoke test:

```javascript
// After getting report:
console.log(`    dimensions[0].score = ${report.per_person[0]?.dimensions[0]?.score}`);
console.log(`    dimensions[0].label_zh = ${report.per_person[0]?.dimensions[0]?.label_zh}`);
console.log(`    overall.narrative length = ${report.overall?.narrative?.length || 0}`);
console.log(`    suggested_dimensions = ${report.overall?.suggested_dimensions?.length || 0}`);
```

**Step 2: Run full test suites**

```bash
cd edge/worker && npx vitest run          # 282+ tests
cd desktop && npx vitest run              # 65+ tests
cd inference && python -m pytest tests/ -v # 95+ tests
cd desktop && npx tsc --noEmit            # TypeScript check
cd desktop && npx vite build              # Production build
```

**Step 3: Run smoke test**

```bash
WORKER_API_KEY=... node scripts/smoke_caption_session.mjs
```

Verify: All 7 steps pass, new fields present in report.

**Step 4: Commit**

```bash
git add scripts/smoke_caption_session.mjs
git commit -m "test: extend smoke test with dimension score and narrative checks"
```

---

## Task Dependency Graph

```
Task 1 (types) ─────┬──→ Task 3 (evidence tier)
                     ├──→ Task 4 (session config)
                     ├──→ Task 7 (radar chart)
                     ├──→ Task 9 (normalizeApiReport)
                     └──→ Task 14 (backward compat)

Task 2 (presets) ───┬──→ Task 4 (session config)
                    └──→ Task 12 (setup view)

Task 5 (LLM prompt) ← depends on Task 1, Task 3

Task 6 (footnote) ──┬──→ Task 9 (team summary)
                     ├──→ Task 10 (evidence section)
                     └──→ Task 11 (claim rendering)

Task 8 (split view) ← depends on existing TranscriptSection

Task 13 (suggestion UI) ← depends on Task 5, Task 9

Task 15 (integration) ← depends on all above
```

**Suggested parallel batches:**

| Batch | Tasks | Agents |
|-------|-------|--------|
| 1 | Task 1 (types), Task 2 (presets), Task 6 (footnote) | 3 parallel |
| 2 | Task 3 (evidence tier), Task 5 (LLM prompt), Task 7 (radar), Task 8 (split view) | 4 parallel |
| 3 | Task 4 (session config), Task 9 (summary), Task 10 (evidence), Task 11 (claims) | 4 parallel |
| 4 | Task 12 (setup), Task 13 (suggestions), Task 14 (backward compat) | 3 parallel |
| 5 | Task 15 (integration) | 1 |
