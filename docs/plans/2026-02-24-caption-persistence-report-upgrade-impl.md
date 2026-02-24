# Caption Persistence + Report Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix caption-mode Re-generate (stuck at 26%) by persisting captionBuffer to DO storage, add report-only fast path, and show full transcript in FeedbackView.

**Architecture:** Worker DO gains batched captionBuffer persistence and a `mode=report-only` finalize path that skips audio stages. Desktop gains a virtualized TranscriptSection component, SplitButton for re-generate options, and IPC plumbing for the new `mode` parameter.

**Tech Stack:** Cloudflare Workers (Durable Objects, R2), React 18, @tanstack/react-virtual, Tailwind v4, Lucide icons, motion/react

---

## Task 1: Worker — captionBuffer Persistence

Persist ACS caption events to DO storage so they survive DO eviction and are available for Re-generate.

**Files:**
- Modify: `edge/worker/src/index.ts:623` (add storage key constant)
- Modify: `edge/worker/src/index.ts:1629` (add flush fields + methods)
- Modify: `edge/worker/src/index.ts:6290` (add batch flush on caption push)
- Modify: `edge/worker/src/index.ts:4706-4709` (restore from storage)

**Step 1: Add storage key constant**

In `edge/worker/src/index.ts`, after line 623 (`STORAGE_KEY_CAPTION_SOURCE`), add:

```typescript
const STORAGE_KEY_CAPTION_BUFFER = "caption_buffer";
```

**Step 2: Add batch flush fields and methods**

After the `captionBuffer` declaration (line 1629), add flush tracking fields:

```typescript
private captionBuffer: CaptionEvent[] = [];
private captionFlushPending = 0;        // count of un-flushed captions
private captionFlushTimer: ReturnType<typeof setTimeout> | null = null;
private readonly CAPTION_FLUSH_BATCH = 10;
private readonly CAPTION_FLUSH_INTERVAL_MS = 5_000;
private readonly CAPTION_BUFFER_MAX = 2000;
```

Add flush method after `getCaptionBuffer()` (around line 1639):

```typescript
/** Flush captionBuffer to DO storage (batched: 10 items or 5s, whichever first). */
private flushCaptionBuffer(): void {
  if (this.captionFlushTimer) {
    clearTimeout(this.captionFlushTimer);
    this.captionFlushTimer = null;
  }
  const toStore = this.captionBuffer.length > this.CAPTION_BUFFER_MAX
    ? this.captionBuffer.slice(-this.CAPTION_BUFFER_MAX)
    : this.captionBuffer;
  this.ctx.storage.put(STORAGE_KEY_CAPTION_BUFFER, toStore).catch((err) => {
    console.warn(`[caption-persist] flush failed: ${(err as Error).message}`);
  });
  this.captionFlushPending = 0;
}

/** Schedule a batched flush: immediately if batch size reached, else after interval. */
private scheduleCaptionFlush(): void {
  this.captionFlushPending++;
  if (this.captionFlushPending >= this.CAPTION_FLUSH_BATCH) {
    this.flushCaptionBuffer();
    return;
  }
  if (!this.captionFlushTimer) {
    this.captionFlushTimer = setTimeout(() => {
      this.captionFlushTimer = null;
      this.flushCaptionBuffer();
    }, this.CAPTION_FLUSH_INTERVAL_MS);
  }
}
```

**Step 3: Call scheduleCaptionFlush on each caption push**

In the caption handler (line 6290), after `this.captionBuffer.push({...})` (line 6296), add:

```typescript
this.scheduleCaptionFlush();
```

**Step 4: Restore captionBuffer in runFinalizeV2Job**

In `runFinalizeV2Job` (lines 4706-4709), expand the existing captionSource rehydration block:

```typescript
// Rehydrate captionSource from DO storage in case DO was evicted
if (this.captionSource === "none") {
  const persisted = await this.ctx.storage.get<string>(STORAGE_KEY_CAPTION_SOURCE);
  if (persisted === "acs-teams") this.captionSource = persisted;
}
// Rehydrate captionBuffer from DO storage if empty (DO was evicted or re-generate)
if (this.captionSource === "acs-teams" && this.captionBuffer.length === 0) {
  const stored = await this.ctx.storage.get<CaptionEvent[]>(STORAGE_KEY_CAPTION_BUFFER);
  if (Array.isArray(stored) && stored.length > 0) {
    this.captionBuffer = stored;
    console.log(`[finalize-v2] restored ${stored.length} captions from DO storage`);
  }
}
```

**Step 5: Run worker tests**

Run: `cd /Users/billthechurch/Interview-feedback/edge/worker && npx vitest run`
Expected: All existing tests pass (no behavior change for non-caption sessions)

**Step 6: Run worker typecheck**

Run: `cd /Users/billthechurch/Interview-feedback/edge/worker && npm run typecheck`
Expected: PASS

**Step 7: Commit**

```bash
cd /Users/billthechurch/Interview-feedback
git add edge/worker/src/index.ts
git commit -m "feat(worker): persist captionBuffer to DO storage with batched flush"
```

---

## Task 2: Worker — `mode` Parameter + report-only Path

Add `mode` parameter to `/finalize?version=v2` endpoint and implement report-only fast path.

**Files:**
- Modify: `edge/worker/src/types_v2.ts` (add `FinalizeMode` type)
- Modify: `edge/worker/src/index.ts:7516-7572` (parse `mode` from request body)
- Modify: `edge/worker/src/index.ts:4695-4699` (accept `mode` param in runFinalizeV2Job)
- Modify: `edge/worker/src/index.ts:4723-4947` (skip audio stages for report-only)

**Step 1: Add FinalizeMode type**

In `edge/worker/src/types_v2.ts`, add near the `CaptionSource` type:

```typescript
export type FinalizeMode = 'full' | 'report-only';
```

**Step 2: Parse `mode` from request body in finalize endpoint**

In `edge/worker/src/index.ts` at line 7517, after `payload = await readJson<FinalizeRequest>(request)`, add mode extraction. Also update the `runFinalizeV2Job` call at line 7561:

Change:
```typescript
await this.runFinalizeV2Job(sessionId, nextStatus.job_id, payload.metadata ?? {});
```
To:
```typescript
const mode = (payload as Record<string, unknown>).mode === 'report-only' ? 'report-only' : 'full';
await this.runFinalizeV2Job(sessionId, nextStatus.job_id, payload.metadata ?? {}, mode);
```

**Step 3: Update runFinalizeV2Job signature**

Change the method signature from:
```typescript
private async runFinalizeV2Job(
  sessionId: string,
  jobId: string,
  metadata: Record<string, unknown>
): Promise<void> {
```
To:
```typescript
private async runFinalizeV2Job(
  sessionId: string,
  jobId: string,
  metadata: Record<string, unknown>,
  mode: 'full' | 'report-only' = 'full'
): Promise<void> {
```

**Step 4: Implement report-only path**

After the captionBuffer restoration block (after Step 4 of Task 1), and before the `await this.setFinalizeLock(true)` line, add the report-only early path:

```typescript
// ── report-only mode: skip audio stages, reload existing transcript from R2 ──
if (mode === 'report-only') {
  await this.updateFinalizeV2Status(jobId, {
    status: "running",
    stage: "reconcile",
    progress: 42,
    started_at: startedAt,
    warnings: [],
    degraded: false,
    backend_used: "primary"
  });
  await this.setFinalizeLock(true);

  try {
    // Load existing ResultV2 from R2
    const existingKey = resultObjectKeyV2(sessionId);
    const existingObj = await this.env.RESULT_BUCKET.get(existingKey);
    if (!existingObj) {
      throw new Error("report-only: no existing ResultV2 in R2");
    }
    const existingResult = JSON.parse(await existingObj.text()) as ResultV2;

    // Extract previously computed data
    const transcript = existingResult.transcript;
    const speakerLogs = existingResult.speaker_logs;
    const stats = existingResult.stats;
    const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
    const memos = await this.loadMemos();
    const locale = getSessionLocale(state, this.env);

    // Merge any new metadata memos
    if (Array.isArray((metadata as Record<string, unknown>)?.memos)) {
      const incomingMemos = (metadata as Record<string, unknown>).memos as Array<Record<string, unknown>>;
      const existingIds = new Set(memos.map((m) => m.memo_id));
      for (const raw of incomingMemos) {
        const memoId = typeof raw.memo_id === "string" ? raw.memo_id : `m_meta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        if (existingIds.has(memoId)) continue;
        memos.push({
          memo_id: memoId,
          created_at_ms: typeof raw.created_at_ms === "number" ? raw.created_at_ms : Date.now(),
          author_role: "teacher",
          type: (["observation", "evidence", "question", "decision", "score"].includes(raw.type as string) ? raw.type : "observation") as MemoItem["type"],
          tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
          text: typeof raw.text === "string" ? raw.text : "",
          stage: typeof raw.stage === "string" ? raw.stage : undefined,
          stage_index: typeof raw.stage_index === "number" ? raw.stage_index : undefined,
        });
        existingIds.add(memoId);
      }
      await this.storeMemos(memos);
    }

    // Re-run events → report → persist (reuse transcript + stats)
    // Jump to events stage
    await this.updateFinalizeV2Status(jobId, { stage: "events", progress: 55 });
    await this.ensureFinalizeJobActive(jobId);

    const knownSpeakers = stats.map((s) => s.speaker_name ?? s.speaker_key).filter(Boolean);
    const memoBindings = extractMemoNames(memos, knownSpeakers);
    const configStages: string[] = (state.config as Record<string, unknown>)?.stages as string[] ?? [];
    const enrichedMemos = addStageMetadata(memos, configStages);
    let evidence = buildMultiEvidence({ memos: enrichedMemos, transcript, bindings: memoBindings });
    const enrichedEvidence = enrichEvidencePack(transcript, stats);
    evidence = [...evidence, ...enrichedEvidence];

    const legacyEvidence = buildEvidence({ memos, transcript });
    const memosWithEvidence = attachEvidenceToMemos(memos, legacyEvidence);

    const eventsPayload = {
      session_id: sessionId,
      transcript,
      memos: memosWithEvidence,
      stats,
      locale
    };
    const eventsResult = await this.invokeInferenceAnalysisEvents(eventsPayload);
    const analysisEvents = Array.isArray(eventsResult.events) ? eventsResult.events : [];
    if (eventsResult.warnings.length > 0) finalizeWarnings.push(...eventsResult.warnings);
    if (eventsResult.degraded) finalizeDegraded = true;
    finalizeBackendUsed = eventsResult.backend_used === "local" ? "local" : eventsResult.backend_used;

    // Report stage
    await this.updateFinalizeV2Status(jobId, { stage: "report", progress: 75 });
    await this.ensureFinalizeJobActive(jobId);

    const audioDurationMs = transcript.length > 0 ? Math.max(...transcript.map(u => u.end_ms)) : 0;
    const statsObservations = generateStatsObservations(stats, audioDurationMs);
    const memoFirstReport = buildMemoFirstReport({ transcript, memos: memosWithEvidence, evidence: legacyEvidence, stats });
    let finalOverall = memoFirstReport.overall;
    let finalPerPerson = memoFirstReport.per_person;
    let reportSource: "memo_first" | "llm_enhanced" | "llm_failed" | "llm_synthesized" | "llm_synthesized_truncated" | "memo_first_fallback" = "memo_first";
    let reportModel: string | null = null;
    let reportError: string | null = null;
    let reportBlockingReason: string | null = null;
    let pipelineMode: "memo_first_with_llm_polish" | "llm_core_synthesis" = "memo_first_with_llm_polish";

    // Try LLM synthesis
    const storedCheckpoints = await this.loadCheckpoints();
    try {
      const fullConfig = (state.config ?? {}) as Record<string, unknown>;
      const { rubric, sessionContext, freeFormNotes, stages: contextStages } = collectEnrichedContext({
        sessionConfig: {
          mode: fullConfig.mode as "1v1" | "group" | undefined,
          interviewer_name: fullConfig.interviewer_name as string | undefined,
          position_title: fullConfig.position_title as string | undefined,
          company_name: fullConfig.company_name as string | undefined,
          stages: configStages,
          free_form_notes: fullConfig.free_form_notes as string | undefined,
          rubric: fullConfig.rubric as Parameters<typeof collectEnrichedContext>[0]["sessionConfig"]["rubric"],
        },
      });

      const configNameAliases = (fullConfig.name_aliases ?? {}) as Record<string, string[]>;
      const synthPayload = buildSynthesizePayload({
        sessionId,
        transcript,
        memos: enrichedMemos,
        evidence,
        stats,
        events: analysisEvents.map((evt: Record<string, unknown>) => ({
          event_id: String(evt.event_id ?? ""),
          event_type: String(evt.event_type ?? ""),
          actor: evt.actor != null ? String(evt.actor) : null,
          target: evt.target != null ? String(evt.target) : null,
          time_range_ms: Array.isArray(evt.time_range_ms) ? (evt.time_range_ms as number[]) : [],
          utterance_ids: Array.isArray(evt.utterance_ids) ? (evt.utterance_ids as string[]) : [],
          quote: evt.quote != null ? String(evt.quote) : null,
          confidence: typeof evt.confidence === "number" ? evt.confidence : 0.5,
          rationale: evt.rationale != null ? String(evt.rationale) : null,
        })),
        bindings: memoBindings,
        rubric,
        sessionContext,
        freeFormNotes,
        historical: [],
        stages: contextStages.length > 0 ? contextStages : configStages,
        locale,
        nameAliases: configNameAliases,
        statsObservations,
      });

      const synthResult = await this.invokeInferenceSynthesizeReport(synthPayload);
      const synthData = synthResult.data;
      if (synthResult.warnings.length > 0) finalizeWarnings.push(...synthResult.warnings);
      if (synthResult.degraded) finalizeDegraded = true;

      const candidatePerPerson = Array.isArray(synthData?.per_person) ? (synthData.per_person as PersonFeedbackItem[]) : [];
      if (candidatePerPerson.length > 0) {
        const { sanitized, strippedCount } = this.sanitizeClaimEvidenceRefs(candidatePerPerson, evidence);
        if (strippedCount > 0) finalizeWarnings.push(`sanitized ${strippedCount} claims with empty/invalid evidence_refs`);
        const validation = this.validateClaimEvidenceRefs({ evidence, per_person: sanitized } as ResultV2);
        if (validation.valid) {
          finalPerPerson = sanitized;
          finalOverall = synthData?.overall ?? finalOverall;
          reportSource = "llm_synthesized";
          pipelineMode = "llm_core_synthesis";
          evidence = backfillSupportingUtterances(evidence, finalPerPerson);
        } else {
          reportSource = "memo_first_fallback";
          reportBlockingReason = validation.failures[0] || "invalid evidence refs";
        }
      }
    } catch (synthErr) {
      reportSource = "memo_first_fallback";
      reportError = (synthErr as Error).message;
      finalizeWarnings.push(`report-only synthesis failed: ${(synthErr as Error).message}`);
    }

    if (reportSource === 'memo_first_fallback' || reportSource === 'memo_first' || reportSource === 'llm_enhanced' || reportSource === 'llm_failed') {
      evidence = legacyEvidence;
    }

    // Persist stage
    await this.updateFinalizeV2Status(jobId, { stage: "persist", progress: 92 });
    await this.ensureFinalizeJobActive(jobId);
    const finalizedAt = this.currentIsoTs();

    const memoFirstValidation = validatePersonFeedbackEvidence(finalPerPerson);
    const finalStrictValidation = this.validateClaimEvidenceRefs({ evidence, per_person: finalPerPerson } as ResultV2);
    const synthQualityGate = enforceQualityGates({
      perPerson: finalPerPerson,
      unknownRatio: computeUnknownRatio(transcript),
    });

    const captureByStream = (normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE))).capture_by_stream ?? defaultCaptureByStream();
    const qualityMetrics = this.buildQualityMetrics(transcript, captureByStream);
    const quality: ReportQualityMeta = {
      ...memoFirstValidation.quality,
      generated_at: finalizedAt,
      build_ms: 0,
      validation_ms: 0,
      claim_count: finalStrictValidation.claimCount,
      invalid_claim_count: finalStrictValidation.invalidCount,
      needs_evidence_count: finalStrictValidation.needsEvidenceCount,
      report_source: reportSource,
      report_model: reportModel,
      report_degraded: !ACCEPTED_REPORT_SOURCES.has(reportSource),
      report_error: reportError
    };

    const confidenceLevel = existingResult.session.confidence_level ?? "high";
    const tentative = confidenceLevel === "low" || !this.evaluateFeedbackQualityGates({
      unknownRatio: qualityMetrics.unknown_ratio,
      ingestP95Ms: null,
      claimValidationFailures: [
        ...(finalStrictValidation.failures ?? []),
        ...synthQualityGate.failures,
        ...(ACCEPTED_REPORT_SOURCES.has(reportSource) ? [] : [reportBlockingReason || "llm report unavailable"])
      ]
    }).passed;

    const resultV2 = buildResultV2({
      sessionId,
      finalizedAt,
      tentative,
      confidenceLevel,
      unresolvedClusterCount: existingResult.session.unresolved_cluster_count ?? 0,
      diarizationBackend: existingResult.session.diarization_backend ?? "cloud",
      transcript,
      speakerLogs,
      stats,
      memos,
      evidence,
      overall: finalOverall,
      perPerson: finalPerPerson,
      quality,
      finalizeJobId: jobId,
      modelVersions: existingResult.model_versions ?? {},
      thresholds: existingResult.thresholds ?? {},
      backendTimeline: [],
      qualityGateSnapshot: existingResult.quality_gate_snapshot ?? {},
      reportPipeline: {
        mode: pipelineMode,
        source: reportSource,
        llm_attempted: true,
        llm_success: reportSource === "llm_synthesized",
        llm_elapsed_ms: 0,
        blocking_reason: reportBlockingReason
      },
      qualityGateFailures: []
    });

    const resultV2Key = resultObjectKeyV2(sessionId);
    await this.env.RESULT_BUCKET.put(resultV2Key, JSON.stringify(resultV2), {
      httpMetadata: { contentType: "application/json" }
    });
    await this.ctx.storage.put(STORAGE_KEY_RESULT_KEY_V2, resultV2Key);
    await this.ctx.storage.put(STORAGE_KEY_FINALIZED_AT, finalizedAt);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, finalizedAt);

    const cache = await this.loadFeedbackCache(sessionId);
    cache.updated_at = finalizedAt;
    cache.report = resultV2;
    cache.person_summary_cache = resultV2.per_person;
    cache.overall_summary_cache = resultV2.overall;
    cache.evidence_index_cache = this.buildEvidenceIndex(resultV2.per_person);
    cache.quality = resultV2.quality;
    await this.storeFeedbackCache(sessionId, cache);

    await this.updateFinalizeV2Status(jobId, {
      status: "done",
      stage: "persist",
      progress: 100,
      finished_at: finalizedAt,
      warnings: finalizeWarnings,
      degraded: finalizeDegraded,
      backend_used: finalizeBackendUsed
    });

    console.log(`[finalize-v2] report-only completed for session=${sessionId}`);
  } catch (err) {
    const errMsg = (err as Error).message || "unknown error";
    console.error(`[finalize-v2] report-only failed: ${errMsg}`);
    await this.updateFinalizeV2Status(jobId, {
      status: "failed",
      errors: [errMsg],
      finished_at: this.currentIsoTs()
    });
  } finally {
    await this.setFinalizeLock(false);
  }
  return; // exit early — do not run full pipeline
}
```

**Step 5: Run worker typecheck + tests**

Run: `cd /Users/billthechurch/Interview-feedback/edge/worker && npm run typecheck && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
cd /Users/billthechurch/Interview-feedback
git add edge/worker/src/index.ts edge/worker/src/types_v2.ts
git commit -m "feat(worker): add report-only finalization mode for caption-mode re-generate"
```

---

## Task 3: Desktop — IPC Plumbing for `mode` Parameter

Thread the `mode` parameter from FeedbackView → preload → main → Worker HTTP.

**Files:**
- Modify: `desktop/src/types/desktop-api.d.ts:14`
- Modify: `desktop/preload.js:10`
- Modify: `desktop/main.js:478-499`

**Step 1: Update desktop-api.d.ts**

Change line 14 from:
```typescript
finalizeV2(payload: { baseUrl: string; sessionId: string; metadata?: Record<string, unknown> }): Promise<unknown>;
```
To:
```typescript
finalizeV2(payload: { baseUrl: string; sessionId: string; metadata?: Record<string, unknown>; mode?: 'full' | 'report-only' }): Promise<unknown>;
```

**Step 2: Update main.js handler**

In `desktop/main.js` at line 487-493, change the fetch body to include `mode`:

Change:
```javascript
body: JSON.stringify({ metadata: payload.metadata || {} })
```
To:
```javascript
body: JSON.stringify({
  metadata: payload.metadata || {},
  mode: payload.mode || 'full'
})
```

**Step 3: Run desktop typecheck**

Run: `cd /Users/billthechurch/Interview-feedback/desktop && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
cd /Users/billthechurch/Interview-feedback
git add desktop/src/types/desktop-api.d.ts desktop/main.js
git commit -m "feat(desktop): thread finalize mode parameter through IPC"
```

---

## Task 4: Desktop — SplitButton Component

Create a reusable SplitButton with dropdown for Re-generate options.

**Files:**
- Create: `desktop/src/components/ui/SplitButton.tsx`

**Step 1: Create the SplitButton component**

```tsx
import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

type SplitButtonOption = {
  label: string;
  value: string;
  icon?: React.ReactNode;
};

type SplitButtonProps = {
  options: SplitButtonOption[];
  onSelect: (value: string) => void;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
};

export function SplitButton({ options, onSelect, loading, disabled, className = '' }: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const primary = options[0];
  if (!primary) return null;

  return (
    <div ref={ref} className={`relative inline-flex ${className}`}>
      {/* Main action */}
      <button
        onClick={() => onSelect(primary.value)}
        disabled={disabled || loading}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-l-[--radius-button] bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
      >
        {loading ? (
          <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        ) : primary.icon ? (
          <span className="w-3.5 h-3.5 flex items-center justify-center">{primary.icon}</span>
        ) : null}
        {primary.label}
      </button>

      {/* Dropdown toggle */}
      {options.length > 1 && (
        <button
          onClick={() => setOpen(!open)}
          disabled={disabled || loading}
          className="inline-flex items-center px-1.5 py-1.5 rounded-r-[--radius-button] bg-accent text-white hover:bg-accent/90 border-l border-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Dropdown menu */}
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-[--radius-card] shadow-lg border border-border z-50">
          {options.slice(1).map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onSelect(opt.value);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-surface-hover transition-colors first:rounded-t-[--radius-card] last:rounded-b-[--radius-card] flex items-center gap-2 cursor-pointer"
            >
              {opt.icon && <span className="w-4 h-4 flex items-center justify-center">{opt.icon}</span>}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Run desktop typecheck**

Run: `cd /Users/billthechurch/Interview-feedback/desktop && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
cd /Users/billthechurch/Interview-feedback
git add desktop/src/components/ui/SplitButton.tsx
git commit -m "feat(desktop): add SplitButton component for re-generate options"
```

---

## Task 5: Desktop — TranscriptSection Component

Create the virtualized transcript viewer with speaker filtering, evidence highlighting, and search.

**Files:**
- Modify: `desktop/package.json` (add `@tanstack/react-virtual`)
- Create: `desktop/src/components/TranscriptSection.tsx`

**Step 1: Install @tanstack/react-virtual**

Run: `cd /Users/billthechurch/Interview-feedback/desktop && npm install @tanstack/react-virtual`

**Step 2: Create TranscriptSection component**

```tsx
import { useState, useMemo, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, Filter } from 'lucide-react';

/** Single transcript utterance from ResultV2. */
export type TranscriptUtterance = {
  utterance_id: string;
  speaker_name: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
};

/** Map from utterance_id → evidence IDs that reference it. */
export type UtteranceEvidenceMap = Record<string, string[]>;

type Props = {
  transcript: TranscriptUtterance[];
  evidenceMap: UtteranceEvidenceMap;
  onEvidenceBadgeClick?: (evidenceId: string) => void;
  scrollToUtteranceId?: string | null;
};

const SPEAKER_COLORS = [
  'text-blue-600',
  'text-emerald-600',
  'text-amber-600',
  'text-purple-600',
  'text-rose-600',
  'text-cyan-600',
];

const SPEAKER_BG = [
  'bg-blue-50',
  'bg-emerald-50',
  'bg-amber-50',
  'bg-purple-50',
  'bg-rose-50',
  'bg-cyan-50',
];

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Merge consecutive utterances from the same speaker into groups. */
type UtteranceGroup = {
  speaker: string;
  speakerIndex: number;
  startMs: number;
  items: TranscriptUtterance[];
  hasEvidence: boolean;
  evidenceIds: string[];
};

export function TranscriptSection({ transcript, evidenceMap, onEvidenceBadgeClick, scrollToUtteranceId }: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  // Extract unique speakers with stable color index
  const speakerList = useMemo(() => {
    const seen = new Map<string, number>();
    for (const u of transcript) {
      const name = u.speaker_name || 'Unknown';
      if (!seen.has(name)) seen.set(name, seen.size);
    }
    return Array.from(seen.entries()).map(([name, idx]) => ({ name, colorIndex: idx % SPEAKER_COLORS.length }));
  }, [transcript]);

  const speakerColorMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of speakerList) map.set(s.name, s.colorIndex);
    return map;
  }, [speakerList]);

  // Group consecutive utterances by speaker, apply filters
  const groups = useMemo(() => {
    let filtered = transcript;

    // Speaker filter
    if (activeSpeaker) {
      filtered = filtered.filter(u => (u.speaker_name || 'Unknown') === activeSpeaker);
    }

    // Text search filter
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(u => u.text.toLowerCase().includes(q));
    }

    // Merge consecutive same-speaker
    const result: UtteranceGroup[] = [];
    for (const u of filtered) {
      const speaker = u.speaker_name || 'Unknown';
      const last = result[result.length - 1];
      const evIds = evidenceMap[u.utterance_id] ?? [];
      if (last && last.speaker === speaker) {
        last.items.push(u);
        if (evIds.length > 0) {
          last.hasEvidence = true;
          last.evidenceIds.push(...evIds);
        }
      } else {
        result.push({
          speaker,
          speakerIndex: speakerColorMap.get(speaker) ?? 0,
          startMs: u.start_ms,
          items: [u],
          hasEvidence: evIds.length > 0,
          evidenceIds: [...evIds],
        });
      }
    }
    return result;
  }, [transcript, activeSpeaker, searchQuery, evidenceMap, speakerColorMap]);

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 10,
  });

  // Scroll to a specific utterance
  const scrollToRef = useRef(scrollToUtteranceId);
  scrollToRef.current = scrollToUtteranceId;
  const scrolledRef = useRef<string | null>(null);

  if (scrollToUtteranceId && scrollToUtteranceId !== scrolledRef.current) {
    const idx = groups.findIndex(g => g.items.some(u => u.utterance_id === scrollToUtteranceId));
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center' });
      scrolledRef.current = scrollToUtteranceId;
    }
  }

  const highlightText = useCallback((text: string) => {
    if (!searchQuery.trim()) return text;
    const q = searchQuery.trim();
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? <mark key={i} className="bg-yellow-200 rounded-sm px-0.5">{part}</mark> : part
    );
  }, [searchQuery]);

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setActiveSpeaker(null)}
          className={`px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer ${
            !activeSpeaker ? 'bg-accent text-white border-accent' : 'border-border text-ink-secondary hover:bg-surface-hover'
          }`}
        >
          All
        </button>
        {speakerList.map(s => (
          <button
            key={s.name}
            onClick={() => setActiveSpeaker(activeSpeaker === s.name ? null : s.name)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer ${
              activeSpeaker === s.name
                ? `${SPEAKER_BG[s.colorIndex]} ${SPEAKER_COLORS[s.colorIndex]} border-current`
                : 'border-border text-ink-secondary hover:bg-surface-hover'
            }`}
          >
            {s.name}
          </button>
        ))}

        {/* Search */}
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-secondary" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search transcript..."
            className="pl-7 pr-3 py-1 text-xs border border-border rounded-[--radius-button] bg-white focus:outline-none focus:ring-1 focus:ring-accent w-48"
          />
        </div>
      </div>

      {/* Empty state */}
      {groups.length === 0 && (
        <div className="text-center text-ink-secondary text-sm py-8">
          {transcript.length === 0 ? 'No transcript data available.' : 'No matching utterances.'}
        </div>
      )}

      {/* Virtualized list */}
      <div
        ref={parentRef}
        className="h-[500px] overflow-y-auto rounded-[--radius-card] border border-border bg-white"
      >
        <div
          style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const group = groups[virtualRow.index];
            const isHighlighted = scrollToUtteranceId && group.items.some(u => u.utterance_id === scrollToUtteranceId);
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className={`px-4 py-2 border-b border-border/50 ${
                  group.hasEvidence ? 'bg-accent/5' : ''
                } ${isHighlighted ? 'ring-2 ring-accent/30 ring-inset' : ''}`}
              >
                {/* Speaker header */}
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-ink-secondary font-mono">{formatTime(group.startMs)}</span>
                  <span className={`w-2 h-2 rounded-full ${SPEAKER_BG[group.speakerIndex]} ${SPEAKER_COLORS[group.speakerIndex]} ring-1 ring-current`} />
                  <span className={`text-sm font-medium ${SPEAKER_COLORS[group.speakerIndex]}`}>
                    {group.speaker}
                  </span>
                  {group.hasEvidence && (
                    <div className="flex gap-1 ml-auto">
                      {[...new Set(group.evidenceIds)].slice(0, 3).map(eid => (
                        <button
                          key={eid}
                          onClick={() => onEvidenceBadgeClick?.(eid)}
                          className="px-1.5 py-0.5 text-[10px] font-medium bg-accent/10 text-accent rounded cursor-pointer hover:bg-accent/20 transition-colors"
                        >
                          {eid.slice(0, 6)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Utterance texts */}
                {group.items.map(u => (
                  <p key={u.utterance_id} className="text-sm text-ink leading-relaxed pl-6">
                    {highlightText(u.text)}
                  </p>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer count */}
      <div className="text-xs text-ink-secondary text-right">
        {groups.length} groups / {transcript.length} utterances
      </div>
    </div>
  );
}
```

**Step 3: Run desktop typecheck + build**

Run: `cd /Users/billthechurch/Interview-feedback/desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

**Step 4: Commit**

```bash
cd /Users/billthechurch/Interview-feedback
git add desktop/package.json desktop/package-lock.json desktop/src/components/TranscriptSection.tsx
git commit -m "feat(desktop): add virtualized TranscriptSection component"
```

---

## Task 6: Desktop — FeedbackView Integration

Wire TranscriptSection + SplitButton into FeedbackView. Add transcript to normalizeApiReport. Add Transcript to section navigation.

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx:107-118` (add `transcript` to FeedbackReport type)
- Modify: `desktop/src/views/FeedbackView.tsx:124-340` (normalizeApiReport — add transcript + evidenceMap extraction)
- Modify: `desktop/src/views/FeedbackView.tsx:2231-2236` (SectionNav — add Transcript tab)
- Modify: `desktop/src/views/FeedbackView.tsx:3098` (add TranscriptSection before Evidence section)
- Modify: `desktop/src/views/FeedbackView.tsx:2868-2891` (handleRegenerate — pass `mode`)
- Modify: `desktop/src/views/FeedbackView.tsx:1174-1233` (FeedbackHeader — SplitButton for re-generate)

**Step 1: Add transcript types to FeedbackReport**

Add imports at top of FeedbackView.tsx:

```typescript
import { TranscriptSection, type TranscriptUtterance, type UtteranceEvidenceMap } from '../components/TranscriptSection';
import { SplitButton } from '../components/ui/SplitButton';
import { ScrollText } from 'lucide-react';
```

Extend FeedbackReport type (line 107):

```typescript
type FeedbackReport = {
  session_id: string;
  session_name: string;
  date: string;
  duration_ms: number;
  status: 'draft' | 'final';
  mode: '1v1' | 'group';
  participants: string[];
  overall: OverallFeedback;
  persons: PersonFeedback[];
  evidence: EvidenceRef[];
  transcript: TranscriptUtterance[];
  utteranceEvidenceMap: UtteranceEvidenceMap;
  captionSource?: string;
};
```

**Step 2: Add transcript extraction in normalizeApiReport**

At the end of `normalizeApiReport`, before the `return` statement, add transcript normalization:

```typescript
// ── transcript: extract from raw.transcript ──
const normalizedTranscript: TranscriptUtterance[] = (() => {
  if (!Array.isArray(raw.transcript)) return [];
  return raw.transcript.map((u: any) => ({
    utterance_id: u.utterance_id || '',
    speaker_name: u.speaker_name || null,
    text: u.text || '',
    start_ms: typeof u.start_ms === 'number' ? u.start_ms : 0,
    end_ms: typeof u.end_ms === 'number' ? u.end_ms : 0,
  }));
})();

// ── utteranceEvidenceMap: build from evidence[].utterance_ids ──
const utteranceEvidenceMap: UtteranceEvidenceMap = {};
const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
for (const ev of rawEvidence) {
  const evId = ev.evidence_id || ev.id || '';
  const uttIds = Array.isArray(ev.utterance_ids) ? ev.utterance_ids : [];
  for (const uid of uttIds) {
    if (!utteranceEvidenceMap[uid]) utteranceEvidenceMap[uid] = [];
    utteranceEvidenceMap[uid].push(evId);
  }
}

// ── captionSource: from session metadata ──
const captionSource = typeof raw.session?.caption_source === 'string'
  ? raw.session.caption_source
  : typeof raw.caption_source === 'string'
    ? raw.caption_source
    : undefined;
```

Then update the return statement to include:

```typescript
transcript: normalizedTranscript,
utteranceEvidenceMap,
captionSource,
```

**Step 3: Add Transcript to SectionNav**

In the `SectionNav` function (line 2231), update the sections array:

```typescript
const sections = [
  { id: 'overview', label: 'Overview' },
  { id: 'notes', label: 'Session Notes' },
  ...report.persons.map((p) => ({ id: `person-${p.speaker_id}`, label: p.person_name })),
  ...(report.transcript.length > 0 ? [{ id: 'transcript', label: 'Transcript' }] : []),
  { id: 'evidence', label: 'Evidence' },
];
```

**Step 4: Add TranscriptSection before Evidence**

After the person cards loop and before the evidence section (around line 3098), add:

```tsx
{report.transcript.length > 0 && (
  <section id="transcript" data-section className="pb-4">
    <SectionStickyHeader icon={ScrollText} title="Transcript" />
    <motion.div variants={fadeInUp} custom={report.persons.length + 3}>
      <TranscriptSection
        transcript={report.transcript}
        evidenceMap={report.utteranceEvidenceMap}
        onEvidenceBadgeClick={(evId) => {
          const ev = report.evidence.find(e => e.id === evId);
          if (ev) {
            setHighlightEvidence(evId);
            setDetailEvidence(ev);
            setEvidenceModalMode('browse');
          }
        }}
        scrollToUtteranceId={null}
      />
    </motion.div>
  </section>
)}
```

**Step 5: Update handleRegenerate to pass `mode`**

In the main FeedbackView component's `handleRegenerate` (line 2868), update the `finalizeV2` call:

```typescript
const handleRegenerate = useCallback(async (mode: 'full' | 'report-only' = 'full') => {
  if (!sessionId || !sessionData?.baseApiUrl || finalizingRef.current) return;
  const storeState = useSessionStore.getState();
  if (storeState.finalizeRequested && finalizingRef.current) return;
  finalizingRef.current = true;
  storeState.setFinalizeRequested(true);
  setFinalizeError(null);
  setFinalizeStatus('awaiting');
  setApiReport(null);
  try {
    await window.desktopAPI.finalizeV2({
      baseUrl: sessionData.baseApiUrl,
      sessionId: sessionId!,
      metadata: buildFinalizeMetadata(),
      mode,
    });
  } catch {
    setFinalizeStatus('error');
  } finally {
    finalizingRef.current = false;
    useSessionStore.getState().setFinalizeRequested(false);
  }
}, [sessionId, sessionData?.baseApiUrl, buildFinalizeMetadata]);
```

**Step 6: Update FeedbackHeader to use SplitButton**

In the `FeedbackHeader` component, replace the existing Re-generate button with a SplitButton. The FeedbackHeader's `onRegenerate` prop needs to be updated to accept an optional mode:

Update the prop type:
```typescript
onRegenerate: (mode?: 'full' | 'report-only') => void;
```

Determine `captionSource` from the report (passed as a prop). Replace the Re-generate `<Button>` with:

```tsx
{captionSource === 'acs-teams' ? (
  <SplitButton
    options={[
      { label: 'Re-generate Report', value: 'report-only', icon: <RefreshCw className="w-3.5 h-3.5" /> },
      { label: 'Full Re-analysis', value: 'full', icon: <Layers className="w-3.5 h-3.5" /> },
    ]}
    onSelect={(v) => onRegenerate(v as 'full' | 'report-only')}
    loading={regenerating}
    disabled={!sessionId || !baseApiUrl}
  />
) : (
  <Button variant="secondary" size="sm" onClick={() => onRegenerate('full')} loading={regenerating} className="transition-all duration-200">
    <RefreshCw className="w-3.5 h-3.5" />
    Re-generate
  </Button>
)}
```

Update where `FeedbackHeader` is rendered (around line 2977):

```tsx
onRegenerate={(mode) => handleRegenerate(mode || (apiReport?.captionSource === 'acs-teams' ? 'report-only' : 'full'))}
```

**Step 7: Run desktop typecheck + build + tests**

Run: `cd /Users/billthechurch/Interview-feedback/desktop && npx tsc --noEmit && npx vite build && npx vitest run`
Expected: PASS

**Step 8: Commit**

```bash
cd /Users/billthechurch/Interview-feedback
git add desktop/src/views/FeedbackView.tsx
git commit -m "feat(desktop): integrate TranscriptSection + SplitButton in FeedbackView"
```

---

## Task 7: Verification + Manual Testing

Run full test suite and launch app for manual testing.

**Files:** None (verification only)

**Step 1: Run full worker test suite**

Run: `cd /Users/billthechurch/Interview-feedback/edge/worker && npx vitest run`
Expected: All tests pass

**Step 2: Run full desktop test suite**

Run: `cd /Users/billthechurch/Interview-feedback/desktop && npx vitest run`
Expected: All tests pass

**Step 3: Run desktop typecheck + production build**

Run: `cd /Users/billthechurch/Interview-feedback/desktop && npx tsc --noEmit && npx vite build`
Expected: PASS, ~2086+ modules

**Step 4: Launch app for manual testing**

Run: `cd /Users/billthechurch/Interview-feedback/desktop && npm run dev`

**Manual test checklist:**
1. Start a caption-mode session (ACS Teams) → captions should persist to DO storage
2. End session → report generated with transcript section visible
3. Click "Transcript" in left nav → virtualized list with speaker colors
4. Click speaker filter chips → filters utterances
5. Search in transcript → highlights matching text
6. Click evidence badge in transcript → opens evidence detail modal
7. Click "Re-generate Report" (SplitButton) → uses report-only mode (~15s)
8. Click dropdown "Full Re-analysis" → uses full mode
9. For non-caption (audio-mode) sessions → single Re-generate button (no split)

**Step 5: Commit any fixes found during testing**

```bash
cd /Users/billthechurch/Interview-feedback
git add -A
git commit -m "fix: address issues found during manual testing"
```
