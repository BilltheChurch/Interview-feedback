# Backend Intelligence Upgrade — Design Document

> Created: 2026-02-14
> Status: **APPROVED**
> Architecture: **Approach A — LLM-Core Synthesis**

---

## 1. Overview

Upgrade the backend report generation pipeline from keyword-based memo-first with optional LLM polish to a full **LLM-core synthesis engine** with deep evidence citations, name extraction, stage segmentation, and enriched context. Also add a **Demo Meeting onboarding experience**.

### Goals
1. LLM becomes the **core** of report generation (not optional polish)
2. Each claim gets **3-5 supporting utterances** with inline citations
3. Memos are **cross-referenced with transcript** for deeper insights
4. Reports are **segmented by interview stage**
5. Names mentioned in memos are **automatically matched** to enrolled speakers
6. Quality gates are **enforced** (no unsupported claims in production)
7. Demo Meeting bundle enables first-time user onboarding

### Non-Goals
- Video recording/playback (future phase)
- ATS/HR system integrations (future phase)
- Multi-language LLM support beyond zh-CN/en (future phase)

---

## 2. Architecture: LLM-Core Synthesis

### Current Pipeline (Before)
```
Worker: finalize
  → buildEvidence(1 memo = 1 evidence)
  → buildMemoFirstReport(keyword matching → dimension assignment)
  → POST /analysis/report (optional LLM polish — rewrites text only)
  → validate → persist
```

### New Pipeline (After)
```
Worker: finalize
  → extractMemoNames(regex + roster matching)         [NEW]
  → buildMultiEvidence(3-5 utterances per memo)       [ENHANCED]
  → addStageMetadata(group memos by stage)             [NEW]
  → collectEnrichedContext(rubric, notes, history)     [NEW]
  → POST /analysis/synthesize                          [NEW ENDPOINT]
      ← LLM-synthesized report with deep citations
  → validateReport(enforce evidence + quality gates)   [ENHANCED]
  → persist to R2

Fallback: If LLM fails → existing buildMemoFirstReport() as reliable backup
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Worker (Edge)** | Data preparation: evidence building, name extraction, stage grouping, context collection, quality validation, persistence |
| **Inference (Python)** | LLM synthesis: cross-referencing memos × transcript, claim generation with deep citations, dimension evaluation against rubric |
| **Desktop (Electron)** | Passes stage data, free-form notes, rubric template, session metadata via route state and API calls |

---

## 3. New API Contract

### 3.1 New Inference Endpoint: `POST /analysis/synthesize`

#### Request Schema

```python
class StageDescription(BaseModel):
    stage_index: int
    stage_name: str                          # e.g., "Q1: System Design"
    description: str | None = None

class RubricDimension(BaseModel):
    name: str                                # e.g., "System Design"
    description: str | None = None
    weight: float = 1.0

class RubricTemplate(BaseModel):
    template_name: str                       # e.g., "Technical Assessment"
    dimensions: list[RubricDimension]

class SessionContext(BaseModel):
    mode: Literal["1v1", "group"]
    interviewer_name: str | None = None
    position_title: str | None = None
    company_name: str | None = None
    stage_descriptions: list[StageDescription] = []

class MemoSpeakerBinding(BaseModel):
    memo_id: str
    extracted_names: list[str]               # names found in memo text
    matched_speaker_keys: list[str]          # resolved to enrolled speakers
    confidence: float

class HistoricalSummary(BaseModel):
    session_id: str
    date: str
    summary: str
    strengths: list[str]
    risks: list[str]

class SynthesizeReportRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    transcript: list[TranscriptUtterance]
    memos: list[Memo]                        # now includes stage/stage_index fields
    free_form_notes: str | None = None       # raw RichNoteEditor text content
    evidence: list[EvidenceRef]              # multi-utterance evidence (3-5 per memo)
    stats: list[SpeakerStat]
    events: list[AnalysisEvent]

    # Enriched context
    rubric: RubricTemplate | None = None
    session_context: SessionContext | None = None
    memo_speaker_bindings: list[MemoSpeakerBinding] = []
    historical: list[HistoricalSummary] = []

    stages: list[str] = []                   # ordered stage names
    locale: str = "zh-CN"
```

#### Response Schema

Reuses existing `AnalysisReportResponse` structure with enhanced `ReportQualityMeta`:

```python
class ReportQualityMeta(BaseModel):
    # ... existing fields ...
    report_source: Literal["memo_first", "llm_enhanced", "llm_failed",
                           "llm_synthesized", "llm_synthesized_truncated",
                           "memo_first_fallback"] | None = None
    synthesis_context: SynthesisContextMeta | None = None

class SynthesisContextMeta(BaseModel):
    rubric_used: bool = False
    free_notes_used: bool = False
    historical_sessions_count: int = 0
    name_bindings_count: int = 0
    stages_count: int = 0
    transcript_tokens_approx: int = 0
    transcript_truncated: bool = False
```

### 3.2 Enhanced Worker Endpoint: `POST /v1/sessions/:id/finalize`

No external API change. Internal finalization pipeline adds new steps before calling Inference.

### 3.3 Memo Schema Extension

```typescript
// types_v2.ts — MemoItem
export interface MemoItem {
  memo_id: string;
  created_at_ms: number;
  author_role: "teacher";
  type: MemoType;
  tags: string[];
  text: string;
  anchors?: MemoAnchor;
  stage?: string;           // NEW: "Intro", "Q1: System Design", etc.
  stage_index?: number;     // NEW: 0, 1, 2, ...
}
```

---

## 4. Worker-Side Enhancements

### 4.1 Multi-Evidence Building

Replace `buildEvidence()` (1:1 mapping) with `buildMultiEvidence()` (3-5 per memo):

**Algorithm**:
For each memo:
1. Find utterances within ±15s of memo timestamp (temporal proximity)
2. If memo has name binding → prioritize that speaker's utterances
3. Score each candidate utterance:
   ```
   score = 0.4 * keyword_overlap(memo.text, utterance.text)
         + 0.3 * temporal_proximity(memo.created_at_ms, utterance.start_ms)
         + 0.2 * speaker_match(memo_binding, utterance.speaker_name)
         + 0.1 * stage_match(memo.stage, utterance_stage)
   ```
4. Take top 5 scoring utterances as evidence
5. Include explicitly anchored utterances (if any)

**Keyword overlap**: Simple token intersection — split both texts into words, count shared words / total memo words. Supports Chinese (split by character bigrams) and English (split by whitespace).

### 4.2 Memo Name Extraction

New function `extractMemoNames()`:

**Algorithm**:
1. **English names**: Regex `\b[A-Z][a-z]{1,15}\b` — match capitalized words
2. **Chinese names**: Regex `[\u4e00-\u9fff]{2,3}` — match 2-3 character sequences
3. **Filter**: Remove common non-name words (interview terms, dimension names, etc.)
4. **Match against roster**: Fuzzy match extracted names against `knownSpeakers` list
   - Exact match: confidence 1.0
   - Substring match ("Alice" in "Alice Wang"): confidence 0.8
   - No match: confidence 0.3 (keep as potential unregistered name)

### 4.3 Stage Metadata Collection

```typescript
function addStageMetadata(
  memos: MemoItem[],
  stages: string[]
): MemoItem[] {
  // Memos already have stage/stage_index from desktop (added in Phase 5.2C)
  // This function validates and fills gaps:
  // - If memo has stage but no stage_index → derive from stages array
  // - If memo has no stage → assign based on timestamp vs stage boundaries
  return enrichedMemos;
}
```

### 4.4 Context Collection

```typescript
function collectEnrichedContext(params: {
  sessionState: SessionDurableObject;
  memos: MemoItem[];
  transcript: TranscriptItem[];
}): EnrichedContext {
  // 1. Rubric: read from session config (set during setup)
  // 2. Free-form notes: read from session state
  // 3. Historical: query R2 history index for same participant names
  // 4. Session metadata: read from config (mode, interviewer, position)
  return { rubric, freeFormNotes, historical, sessionContext };
}
```

### 4.5 Quality Gate Enforcement

Currently defined but not enforced. New behavior:

```typescript
function enforceQualityGates(report: ResultV2): {
  passed: boolean;
  failures: string[];
  tentative: boolean;
} {
  const failures: string[] = [];

  // Gate 1: No claims without evidence
  if (report.quality.needs_evidence_count > 0) {
    failures.push(`${report.quality.needs_evidence_count} claims lack evidence`);
  }

  // Gate 2: Unknown speaker ratio
  if (report.trace.unknown_ratio > 0.10) {
    failures.push(`unknown_ratio ${(report.trace.unknown_ratio * 100).toFixed(1)}% > 10%`);
  }

  // Gate 3: Minimum evidence per claim
  for (const person of report.per_person) {
    for (const dim of person.dimensions) {
      for (const claim of [...dim.strengths, ...dim.risks, ...dim.actions]) {
        if (claim.evidence_refs.length < 1) {
          failures.push(`claim ${claim.claim_id} has 0 evidence refs`);
        }
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    tentative: failures.length > 0
  };
}
```

---

## 5. Inference-Side: LLM Synthesis Engine

### 5.1 New `ReportSynthesizer` Class

Located in `inference/app/services/report_synthesizer.py`:

```python
class ReportSynthesizer:
    """LLM-core report generation with deep citations."""

    def __init__(self, llm: DashScopeLLM):
        self.llm = llm

    def synthesize(self, req: SynthesizeReportRequest) -> AnalysisReportResponse:
        """Main entry point. LLM synthesizes report from full context."""
        # 1. Build prompts
        # 2. Call LLM
        # 3. Parse structured response
        # 4. Validate evidence refs
        # 5. Return report

    def _build_system_prompt(self, req: SynthesizeReportRequest) -> str:
        """Core prompt engineering — Perplexity-style synthesis."""

    def _build_user_prompt(self, req: SynthesizeReportRequest) -> str:
        """Pack all context into structured JSON for LLM."""

    def _truncate_transcript(self, transcript, max_tokens=6000) -> tuple[list, bool]:
        """Truncate transcript if too long, keeping most recent + highest-signal segments."""

    def _validate_llm_output(self, parsed: dict, evidence_ids: set[str]) -> bool:
        """Ensure all evidence_refs in LLM output are valid."""
```

### 5.2 LLM Prompt Design (Perplexity-Inspired)

**System prompt** (core instruction):
```
You are an expert interview analyst generating structured feedback reports.

CRITICAL RULES:
1. Every claim MUST cite 2-5 evidence references using [e_XXXXXX] format
2. DO NOT invent evidence IDs — only use IDs from the evidence_pack
3. Cross-reference the interviewer's memos with the actual transcript
4. If a memo says "Alice showed good leadership" — find the specific transcript
   moment where Alice demonstrated leadership and cite it
5. If memo observations conflict with transcript evidence, flag the discrepancy
6. Evaluate each person against ALL dimensions in the rubric
7. Group observations by interview stage when stage data is available
8. Use the free-form notes as additional context but prioritize structured memos
9. If historical data is provided, note improvements or regressions

OUTPUT FORMAT: Strict JSON matching the output_contract.
LANGUAGE: {locale} — use professional, concise language.
```

**User prompt structure**:
```json
{
  "task": "synthesize_report",
  "session_id": "...",
  "session_context": { "mode": "group", "position_title": "..." },
  "rubric": { "template_name": "...", "dimensions": [...] },
  "transcript_segments": [ ... top-signal segments ...],
  "memos_with_bindings": [ ... memos + name bindings ...],
  "free_form_notes": "...",
  "evidence_pack": [ { "evidence_id": "e_000001", "quote": "...", "speaker_key": "..." } ],
  "stats": [ ... speaker statistics ...],
  "events": [ ... interaction events ...],
  "stages": ["Intro", "Q1: System Design", "Q2: Behavioral", "Wrap-up"],
  "historical": [ ... past session summaries ...],
  "output_contract": {
    "overall": { "summary_sections": [...], "team_dynamics": {...} },
    "per_person": [
      {
        "person_key": "string",
        "display_name": "string",
        "dimensions": [
          {
            "dimension": "string (from rubric)",
            "strengths": [{ "claim_id": "auto", "text": "...", "evidence_refs": ["e_XXXXX", "e_XXXXX"], "confidence": 0.0-1.0 }],
            "risks": [...],
            "actions": [...]
          }
        ],
        "summary": { "strengths": [...], "risks": [...], "actions": [...] }
      }
    ]
  }
}
```

### 5.3 Transcript Truncation Strategy

For interviews >15 minutes, the transcript may exceed LLM token limits. Strategy:

1. **Prioritize**: Keep segments that overlap with memo timestamps (highest signal)
2. **Keep stage boundaries**: First and last 30s of each stage
3. **Keep speaker introductions**: First utterance from each speaker
4. **Truncate middle**: Remove low-signal segments from the middle of each stage
5. **Target**: ~6000 tokens of transcript content (fits within 8K context budget with other fields)

---

## 6. Fallback & Error Handling

```
POST /analysis/synthesize
├── 200 OK → Use synthesized report
│   report_source: "llm_synthesized"
│
├── Timeout (>6s) → Retry once with truncated transcript
│   ├── 200 OK → Use with warning
│   │   report_source: "llm_synthesized_truncated"
│   └── Timeout/Error → Fall back
│       report_source: "memo_first_fallback"
│
├── 400 (validation error) → Fall back to buildMemoFirstReport()
│   report_source: "memo_first_fallback"
│
└── 500/network error → Fall back to buildMemoFirstReport()
    report_source: "memo_first_fallback"
```

**The existing `buildMemoFirstReport()` is never removed.** It serves as the reliable fallback ensuring no data loss even if the LLM is unavailable.

---

## 7. Demo Meeting Bundle

### 7.1 Bundled Assets

```
desktop/src/demo/
├── demo-session.json        # complete session config
│   ├── sessionId: "demo-session-001"
│   ├── sessionName: "Demo: Product Manager Interview"
│   ├── mode: "1v1"
│   ├── stages: ["Intro", "Q1: Product Strategy", "Q2: Analytical Thinking", "Wrap-up"]
│   ├── participants: ["Demo Candidate"]
│   ├── rubric: { template_name: "Product Manager", dimensions: [...] }
│   └── interviewer: "You"
│
├── demo-transcript.json     # 2-3 min simulated interview transcript
│   └── ~20 utterances with speaker attribution + timestamps
│
├── demo-report.json         # pre-generated AI report showing full output
│   └── deep citations, stage segmentation, evidence chips
│
└── demo-audio.wav           # (optional) pre-recorded audio for immersive playback
    └── 2-3 minutes, 16kHz mono PCM
```

### 7.2 User Flow

1. **First launch** → HomeView shows a "Try Demo Interview" card with distinctive styling
2. **Click** → Opens SidecarView pre-configured with demo session context
3. **During demo** → User can:
   - Listen to demo audio playback (optional)
   - Read simulated transcript appearing in real-time (or all at once)
   - Take notes freely in the RichNoteEditor
   - Add memos with Cmd+1/2/3/4
4. **Click "End Session"** → Navigates to FeedbackView
5. **Report generation**:
   - If backend is available: Sends user's memos + demo transcript to `/analysis/synthesize`
   - If backend unavailable: Uses bundled `demo-report.json` as fallback
6. **FeedbackView** → Shows the full AI-generated report with deep citations

### 7.3 Implementation Notes

- Demo session is **not stored in R2** — it exists only in the desktop bundle
- Demo report generation uses the **same production pipeline** — proving the real capability
- If user has no internet, the **pre-generated report** provides the full experience
- Demo card is hidden after the user completes their first real session

---

## 8. Schema Changes Summary

### types_v2.ts (Worker)
- `MemoItem`: Add `stage?: string`, `stage_index?: number`
- `ReportQualityMeta`: Add `"llm_synthesized" | "llm_synthesized_truncated" | "memo_first_fallback"` to `report_source`
- New: `MemoSpeakerBinding` interface
- New: `SynthesizeRequestPayload` interface (for Worker → Inference call)

### schemas.py (Inference)
- New: `SynthesizeReportRequest` model (with all enriched context fields)
- New: `RubricDimension`, `RubricTemplate`, `SessionContext`, `StageDescription`
- New: `MemoSpeakerBinding`, `HistoricalSummary`, `SynthesisContextMeta`
- Existing: `Memo` — add `stage: str | None`, `stage_index: int | None`
- Existing: `ReportQualityMeta` — add `synthesis_context` field

### inference_client.ts (Worker)
- Add `"analysis_synthesize"` to `InferenceEndpointKey` union

### finalize_v2.ts (Worker)
- New: `extractMemoNames()` function
- New: `buildMultiEvidence()` function (replaces single-evidence `buildEvidence()`)
- New: `addStageMetadata()` function
- New: `collectEnrichedContext()` function
- Enhanced: `enforceQualityGates()` function (hard enforcement)
- Existing: `buildMemoFirstReport()` preserved as fallback

### report_synthesizer.py (Inference, NEW FILE)
- New: `ReportSynthesizer` class with `synthesize()` method
- New: `_build_system_prompt()`, `_build_user_prompt()`
- New: `_truncate_transcript()`, `_validate_llm_output()`

### main.py (Inference)
- New route: `POST /analysis/synthesize`

---

## 9. Testing Strategy

### Unit Tests (Inference)
- `test_report_synthesizer.py`: Mock LLM responses, verify claim structure + evidence validation
- `test_memo_name_extraction.py`: Regex patterns for English/Chinese names
- `test_multi_evidence_scoring.py`: Evidence scoring algorithm correctness

### Integration Tests (Worker)
- `test_finalize_synthesize.ts`: Full pipeline with mock Inference responses
- `test_quality_gates.ts`: Gate enforcement with various edge cases

### Smoke Tests
- `scripts/smoke_synthesize.py`: End-to-end with real DashScope call
- `scripts/smoke_demo_session.mjs`: Demo bundle + report generation

### Quality Metrics
- **Evidence coverage**: 100% of claims have ≥1 evidence ref
- **Deep citation rate**: ≥80% of claims have ≥3 evidence refs
- **Name binding accuracy**: ≥90% for names mentioned in memos
- **Synthesis latency**: LLM call ≤6s (total pipeline ≤8s)
- **Fallback rate**: <5% of sessions fall back to memo-first

---

## 10. Implementation Priority

| Priority | Component | Estimated Effort |
|----------|-----------|-----------------|
| P0 | New `/analysis/synthesize` endpoint + `ReportSynthesizer` | 3 days |
| P0 | Worker: `buildMultiEvidence()` | 2 days |
| P0 | Worker: `extractMemoNames()` + bindings | 2 days |
| P0 | Worker: finalize pipeline integration | 2 days |
| P1 | Memo schema: `stage` field + stage metadata | 1 day |
| P1 | Quality gate enforcement | 1 day |
| P1 | Enriched context collection (rubric, notes, history) | 2 days |
| P2 | Demo Meeting bundle + desktop integration | 3 days |
| P2 | Tests + smoke scripts | 2 days |

**Total estimated**: ~18 days (can be parallelized to ~10 working days)

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| LLM hallucinates evidence IDs | Invalid citations in report | Post-validate all evidence_refs against evidence pack; reject invalid ones |
| Transcript too long for LLM context | Truncation loses signal | Prioritize memo-adjacent segments + stage boundaries |
| DashScope latency spikes | Exceeds 8s budget | Retry with truncated transcript; fallback to memo-first |
| Name extraction false positives | Wrong person gets feedback | Fuzzy match against roster only; require confidence ≥0.5 for binding |
| Demo audio licensing | Legal risk for bundled audio | Generate synthetic interview audio or use internal recording |
