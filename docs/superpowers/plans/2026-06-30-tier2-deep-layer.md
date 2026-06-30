# Tier2 Deep-Layer Cloud-ification Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an async, ≤5-min cloud "deep review/coaching" layer (Tier2) on top of the already-good Tier1 report — cross-person comparison, per-person coaching, deeper single-person analysis, and an interviewer-perspective summary — that AUGMENTS the Tier1 `ResultV2` without ever touching its per-person scores or regressing it on failure.

**Architecture:** Reuse the existing Tier2 plumbing (DO alarm scheduling, `Tier2Status` state machine, `GET /tier2-status` endpoint, desktop polling that swaps in the "Enhanced Report", R2/D1/cache persist). Rewrite `runTier2Job` to DELETE the dead audio-batch stage (Whisper+Pyannote `/batch/process` is retired) and instead load the Tier1 `ResultV2`, run ONE new deep-synthesis LLM call (`synthesizeDeepLayerInWorker`, qwen3.7-plus, Tier2-specific timeout), and spread-augment the four new optional fields onto the Tier1 result. Add a manual `POST /tier2-trigger` endpoint alongside auto-trigger. Desktop renders the new sections.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects + R2 + D1, DashScope (qwen3.7-plus, OpenAI-compatible), vitest (worker 602 green baseline), Electron + React (desktop 234 green baseline).

**Design doc:** `docs/superpowers/specs/2026-06-30-tier2-deep-layer-design.md` — read it; it contains the locked decisions (D1–D5), the deep-call output_contract skeleton, and failure-handling rules. This plan implements that spec.

**Baseline:** branch `claude/ecstatic-chaum-51c7eb` = main = e99bf97. Worker tests: `cd edge/worker && npx vitest run` (602) + `npm run typecheck`. Desktop: `cd desktop && npx vitest run` (234) + `npx tsc --noEmit`. **Run worker commands FROM `edge/worker`, desktop FROM `desktop`.**

**Project rules:** commits MUST NOT contain a `Co-Authored-By` trailer (verify each commit with `git log -1 --format='%B' <sha> | grep -ci co-authored` → must be 0). English comments/identifiers; UI copy matches the existing view's language (SetupView/FeedbackView are English). Do NOT stage the untracked junk `.playwright-mcp/` or `verify-Cc.png`. Each task: TDD (write failing test → run/fail → implement → run/pass → commit).

---

## File Structure

**Worker (`edge/worker/`):**
- `src/types_v2.ts` — Modify: add 4 optional fields to `ResultV2` + new interfaces `CrossPersonComparison`, `CoachingPlan`, `InterviewerPerspective`, `Tier2Meta`.
- `src/config.ts` — Modify: add `Env.TIER2_LLM_TIMEOUT_MS`, `Env.TIER2_TRANSCRIPT_MAX_TOKENS`; add `resolveTier2LlmTimeoutMs(env)`, `resolveTier2TranscriptMaxTokens(env)`.
- `src/services/llm-synthesizer.ts` — Modify: add `synthesizeDeepLayerInWorker(payload, { timeoutMs })` + deep system prompt + output-contract parse/validate (reuse existing parse-hardening + `sanitizeClaimEvidenceRefs`/`validateClaimEvidenceRefs`).
- `src/tier2-processor.ts` — Modify: rewrite `runTier2Job` (delete Stage 1–2 audio batch; load Tier1 → deep call → augment; failure non-regression).
- `src/index.ts` — Modify: add `"tier2-trigger"` DO action (POST), idempotent; reuse existing alarm scheduling.
- `src/router.ts` — Modify: add `POST /v1/sessions/{id}/tier2-trigger` route → DO action.
- `wrangler.jsonc` — Modify: `TIER2_AUTO_TRIGGER` "false"→"true"; add `TIER2_LLM_TIMEOUT_MS` "240000", `TIER2_TRANSCRIPT_MAX_TOKENS` "12000".
- `tests/*.test.ts` — new/extended per task.

**Desktop (`desktop/`):**
- `src/types.ts` — Modify: mirror the 4 optional `ResultV2` fields + interfaces.
- `src/components/CandidateComparison.tsx` — Modify: accept the new `CrossPersonComparison` shape (currently renders Tier1 per-person score table; imported by FeedbackView from `'../components/CandidateComparison'` — keep `persons` prop, ADD optional `comparison` prop branch).
- `src/views/FeedbackView.tsx` — Modify: render `coaching_plans` + `interviewer_perspective` sections; add "Regenerate deep review" button.
- `main.js` + `preload.js` — Modify: add `tier2Trigger` IPC → `POST /tier2-trigger`.

> **First action for the implementer of each task:** read the named files + the design doc's relevant section to confirm current behavior before editing. Cite the actual symbols; line numbers in this plan may have shifted.

---

## Chunk 1: Worker types + config

### Task 1.1: ResultV2 deep-layer types

**Files:**
- Modify: `edge/worker/src/types_v2.ts`
- Test: `edge/worker/tests/tier2-types.test.ts` (type-level — see step 1)

- [ ] **Step 1: Write the failing test** — a compile-time/structural test asserting the new optional fields exist and accept the shape. Since these are types, write a vitest test that constructs a `ResultV2` with the new fields and asserts round-trip:
```ts
import { describe, it, expect } from "vitest";
import type { ResultV2, CrossPersonComparison, CoachingPlan, InterviewerPerspective } from "../src/types_v2";
describe("ResultV2 deep-layer fields", () => {
  it("accepts cross_person_comparison/coaching_plans/interviewer_perspective/tier2_meta as optional", () => {
    const cpc: CrossPersonComparison = { ranking: [{ person_key: "p1", display_name: "A", rank: 1, rationale: "r", evidence_refs: ["e_1"] }], by_dimension: [{ dimension: "logic", label_zh: "逻辑", ordered: ["p1"], note: "n" }], summary: "s" };
    const cp: CoachingPlan = { person_key: "p1", display_name: "A", deep_analysis: "d", action_items: [{ area: "logic", suggestion: "s", why: "w", evidence_refs: ["e_1"] }] };
    const ip: InterviewerPerspective = { decision_support: "d", key_moments: [{ time_ms: 0, what: "w", why_it_matters: "y", evidence_refs: [] }], follow_ups_missed: ["x"], interview_quality_note: "n" };
    const r: Partial<ResultV2> = { cross_person_comparison: cpc, coaching_plans: [cp], interviewer_perspective: ip, tier2_meta: { generated_at: "t", model: "m", build_ms: 1 } };
    expect(r.cross_person_comparison?.ranking[0].rank).toBe(1);
    expect(r.coaching_plans?.[0].action_items[0].area).toBe("logic");
    expect(r.interviewer_perspective?.follow_ups_missed.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`cd edge/worker && npx vitest run tests/tier2-types.test.ts`). Expected: TS/import error — interfaces don't exist.

- [ ] **Step 3: Implement** — in `types_v2.ts`, add the 4 interfaces EXACTLY per the design doc's output_contract section (`CrossPersonComparison`, `CoachingPlan`, `InterviewerPerspective`, `Tier2Meta`) and add the 4 optional fields to `ResultV2`: `cross_person_comparison?`, `coaching_plans?`, `interviewer_perspective?`, `tier2_meta?`. Keep `evidence_refs` on `ranking[]`, `action_items[]`, and `key_moments[]`. Place the interfaces near the other report interfaces; comment that these are Tier2-only (Tier1 never emits them).

- [ ] **Step 4: Run → PASS** + `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(worker): add Tier2 deep-layer types to ResultV2`

### Task 1.2: Tier2 config resolvers + wrangler vars

**Files:**
- Modify: `edge/worker/src/config.ts` (`Env` + resolvers)
- Modify: `edge/worker/wrangler.jsonc`
- Test: `edge/worker/tests/tier2-config.test.ts`

- [ ] **Step 1: Write the failing test** — for two pure resolvers, mirroring the existing `parsePositiveInt` style:
```ts
import { describe, it, expect } from "vitest";
import { resolveTier2LlmTimeoutMs, resolveTier2TranscriptMaxTokens } from "../src/config";
describe("Tier2 config resolvers", () => {
  it("resolveTier2LlmTimeoutMs: default 240000; valid override; invalid→default", () => {
    expect(resolveTier2LlmTimeoutMs({ TIER2_LLM_TIMEOUT_MS: "" } as any)).toBe(240000);
    expect(resolveTier2LlmTimeoutMs({ TIER2_LLM_TIMEOUT_MS: "180000" } as any)).toBe(180000);
    expect(resolveTier2LlmTimeoutMs({ TIER2_LLM_TIMEOUT_MS: "abc" } as any)).toBe(240000);
  });
  it("resolveTier2TranscriptMaxTokens: default 12000; valid override; invalid→default", () => {
    expect(resolveTier2TranscriptMaxTokens({ TIER2_TRANSCRIPT_MAX_TOKENS: "" } as any)).toBe(12000);
    expect(resolveTier2TranscriptMaxTokens({ TIER2_TRANSCRIPT_MAX_TOKENS: "8000" } as any)).toBe(8000);
    expect(resolveTier2TranscriptMaxTokens({ TIER2_TRANSCRIPT_MAX_TOKENS: "-1" } as any)).toBe(12000);
  });
});
```

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** — add `TIER2_LLM_TIMEOUT_MS?: string` and `TIER2_TRANSCRIPT_MAX_TOKENS?: string` to `Env`. Add `resolveTier2LlmTimeoutMs(env)` (default 240000) and `resolveTier2TranscriptMaxTokens(env)` (default 12000) using the existing `parsePositiveInt` helper (reuse it — don't reinvent). In `wrangler.jsonc`: set `TIER2_AUTO_TRIGGER` to `"true"`, add `TIER2_LLM_TIMEOUT_MS: "240000"` and `TIER2_TRANSCRIPT_MAX_TOKENS: "12000"`.

- [ ] **Step 4: Run → PASS** + `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(worker): Tier2 LLM timeout + transcript-budget config; enable auto-trigger`

---

## Chunk 2: Deep-synthesis LLM call

### Task 2.1: `synthesizeDeepLayerInWorker`

**Files:**
- Modify: `edge/worker/src/services/llm-synthesizer.ts`
- Test: `edge/worker/tests/deep-layer-synth.test.ts`

> Read `llm-synthesizer.ts` first: study `synthesizeReportInWorker` — how it builds the system prompt, calls `callDashScope` (endpoint, model from `env.LLM_MODEL`, `enable_thinking:false`, temperature, max_tokens, timeout), parses/repairs the JSON envelope. Look at how the existing tests mock `fetch`/DashScope. The new function mirrors these patterns but with a NEW prompt + a NEW output contract (the 4 deep fields, NO per_person).
> **Visibility constraints (from plan review):** `callDashScope` is MODULE-PRIVATE to `llm-synthesizer.ts` — you MUST add `synthesizeDeepLayerInWorker` to that SAME file (do not put it elsewhere and try to import `callDashScope`). `truncateTranscript` IS exported from `llm-synthesizer.ts` (reuse it). `sanitizeClaimEvidenceRefs`/`validateClaimEvidenceRefs` are CONTEXT-INJECTED methods on `Tier2Context` (not importable into `llm-synthesizer.ts`) — so `synthesizeDeepLayerInWorker` must do evidence-ref grounding INLINE: accept the set of allowed evidence ids as a parameter and strip any `evidence_refs` id not in that set itself.

- [ ] **Step 1: Write the failing test** — mock the DashScope HTTP call (same pattern as existing llm-synthesizer tests) to return a deep-layer JSON envelope, and assert `synthesizeDeepLayerInWorker` returns the parsed `{ cross_person_comparison, coaching_plans, interviewer_perspective }` and that invalid `evidence_refs` (ids not in the supplied evidence) are stripped. Include a case where the LLM returns malformed/partial JSON → function throws or returns null (so the caller can treat it as failure). Assert the request body uses the passed `timeoutMs` is honored (or at least that the function accepts `{ timeoutMs }` and uses `env.LLM_MODEL` + `enable_thinking:false`). Keep assertions on the real parsed output, not the mock.

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** `synthesizeDeepLayerInWorker(payload, opts)`:
  - `payload`: `{ perPerson, stats, evidence, transcript, rubricDimensionKeys, roster, nameAliases, sessionContext, locale }` (everything the prompt packs — derived from the Tier1 ResultV2 by the caller).
  - System prompt: instruct the model to output ONLY the JSON envelope from the design doc (`cross_person_comparison`, `coaching_plans`, `interviewer_perspective`) — NO `per_person`. Require: `action_items[].area` ∈ supplied `rubricDimensionKeys`; every `evidence_refs` id ∈ supplied evidence ids; cross-person ranking covers all interviewees; deep_analysis 3-5 sentences/dimension.
  - Truncate transcript with the existing `truncateTranscript(transcript, maxTokens)` using the caller-supplied Tier2 budget.
  - Call DashScope via the existing `callDashScope` path (model `env.LLM_MODEL`, `enable_thinking:false`, temperature 0.2, `max_tokens` high enough for the deep envelope, timeout = `opts.timeoutMs`). Reuse the existing JSON parse/repair helper.
  - After parse: run evidence-ref grounding — strip any `evidence_refs` id not present in the supplied evidence (reuse `sanitizeClaimEvidenceRefs` or an equivalent over the deep fields). Drop empty/invalid sub-objects gracefully.
  - Return the validated `{ cross_person_comparison?, coaching_plans?, interviewer_perspective? }` (each optional — partial is OK). On unparseable output, throw (caller handles as failure).

- [ ] **Step 4: Run → PASS** + `npm run typecheck`. Run full worker suite to confirm no regression.

- [ ] **Step 5: Commit** — `feat(worker): synthesizeDeepLayerInWorker — Tier2 deep-review LLM call`

---

## Chunk 3: runTier2Job rewrite + augmentation

### Task 3.1: Rewrite `runTier2Job` (deep layer, augment, non-regression)

**Files:**
- Modify: `edge/worker/src/tier2-processor.ts`
- Test: `edge/worker/tests/tier2-job.test.ts` (test the pure augment/decision logic; the DO/R2 wiring is integration)

> Read `tier2-processor.ts` fully first. Current `runTier2Job` does Stage 1 (list R2 PCM) → Stage 2 (POST `/batch/process`) → Stage 3 (load Tier1) → Stage 4 (recompute stats + buildSynthesizePayload + overwrite per_person/overall) → Stage 5 (persist). You will DELETE Stage 1, 2, and the Stage-4 recompute/per_person-overwrite, and insert the deep call + augment.

- [ ] **Step 1: Write the failing test** — extract the augmentation into a pure exported helper `augmentTier1WithDeepLayer(tier1Result, deepFields, tier2Meta)` and test it:
```ts
// returns { ...tier1Result, cross_person_comparison, coaching_plans, interviewer_perspective, tier2_meta }
// AND tier1Result.per_person / overall / stats / evidence are byte-identical (not replaced)
```
Assert: deep fields present; `per_person`/`overall`/`stats` are the SAME references/values as Tier1; partial deepFields (e.g. only cross_person_comparison) → only that field added, others absent; passing `null`/empty deepFields → returns tier1Result essentially unchanged (no deep fields). This locks D4 (augment, never touch per_person).

- [ ] **Step 2: Run → FAIL** (helper doesn't exist).

- [ ] **Step 3: Implement** the helper + rewrite `runTier2Job`:
  - DELETE Stage 1 (R2 PCM list, ~line 131) + Stage 2 (WAV + `/batch/process` fetch, through ~line 205) entirely, AND the old Stage-4 recompute (stats recompute + `buildSynthesizePayload` + per_person/overall overwrite, ~line 252-358). Then run `npm run typecheck` and remove ALL imports that go dead as a result (likely `tier2BatchEndpoint`, `concatUint8Arrays`/`pcm16ToWavBytes`/`bytesToBase64`/`TARGET_SAMPLE_RATE`/`TARGET_CHANNELS` from audio-utils, and several `finalize_v2` helpers like `buildSynthesizePayload`/`buildEvidence`/`attachEvidenceToMemos` if no longer used) — strict typecheck flags unused imports.
  - New flow: load Tier1 `ResultV2` from R2 (reuse the existing load at the old Stage 3). If absent → `Tier2Status=failed`, return WITHOUT overwriting anything (Tier1 stays).
  - Build the deep payload from the Tier1 result (perPerson, stats, evidence, transcript, rubric dimension keys, roster/nameAliases, sessionContext, locale). Call `synthesizeDeepLayerInWorker(payload, { timeoutMs: resolveTier2LlmTimeoutMs(ctx.env) })` with the transcript truncated to `resolveTier2TranscriptMaxTokens(ctx.env)`.
  - On success: `const tier2Result = augmentTier1WithDeepLayer(tier1Result, deepFields, { generated_at: ctx.currentIsoTs(), model: <llm model>, build_ms })`. Persist via the existing R2 overwrite + D1 + DO cache update. `Tier2Status=succeeded`.
  - **On deep-call failure/timeout/empty:** `Tier2Status=failed` with a warning; **DO NOT overwrite the R2 Tier1 result** (non-regression — D4/failure rule). Return.
  - Update `Tier2Status.progress` at the key steps (reporting → persisting → succeeded) so the desktop poll shows movement.

- [ ] **Step 4: Run → PASS** + `npm run typecheck` + full worker suite green.

- [ ] **Step 5: Commit** — `feat(worker): rewrite runTier2Job — deep layer augments Tier1, no audio batch, fail-safe`

### Task 3.2: Auto-trigger scheduling regression lock

**Files:**
- Test: `edge/worker/tests/tier2-trigger-schedule.test.ts` (or extend an existing finalize/tier2 test)

> `finalize-orchestrator.ts` already schedules Tier2 (writes `Tier2Status=pending` + `setAlarm`) after Tier1 persist WHEN `tier2Enabled() && tier2AutoTrigger()`. We just flipped `TIER2_AUTO_TRIGGER=true` (Task 1.2). This task locks that the scheduling path fires under the enabled flags and is skipped when disabled.

- [ ] **Step 1: Write the failing test** — assert the pure predicate used for scheduling: given `tier2Enabled=true && tier2AutoTrigger=true` (and incremental did NOT run) → schedule Tier2; given either false → don't. If the predicate is inline, extract a small pure `shouldScheduleTier2(opts)` helper and test it. (Don't test the DO alarm itself — that's integration.)

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** — extract `shouldScheduleTier2({ incrementalSucceeded, tier2Enabled, tier2AutoTrigger })` pure helper if not present; wire it into the existing finalize-orchestrator scheduling condition (no behavior change, just testable).

- [ ] **Step 4: Run → PASS** + typecheck.

- [ ] **Step 5: Commit** — `test(worker): lock Tier2 auto-trigger scheduling predicate`

---

## Chunk 4: Manual trigger endpoint

### Task 4.1: `POST /v1/sessions/{id}/tier2-trigger`

**Files:**
- Modify: `edge/worker/src/router.ts` (route)
- Modify: `edge/worker/src/index.ts` (DO `"tier2-trigger"` action)
- Test: `edge/worker/tests/tier2-trigger-endpoint.test.ts`

> Read how `tier2-status` is routed (router.ts `SESSION_TIER2_STATUS_ROUTE_REGEX` → DO action) and how an existing POST write action is auth-gated + dispatched. Mirror that for the trigger.

- [ ] **Step 1: Write the failing test** — test the DO action handler's idempotency decision as a pure helper `tier2TriggerDecision(currentStatus)`: if status is `running`/`pending`/active → return `"already-running"` (don't reschedule); if `idle`/`succeeded`/`failed` → return `"schedule"`. Assert both branches.

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** —
  - Add `POST /v1/sessions/{id}/tier2-trigger` route in `router.ts` (auth-gated like other writes) → DO action `"tier2-trigger"`.
  - In `index.ts`, handle action `"tier2-trigger"` (POST): load `Tier2Status`; via `tier2TriggerDecision`, if already running return current status (idempotent), else set `Tier2Status=pending` + `setAlarm(now+2000)` (reuse the existing tier2 alarm-tag mechanism) and return the pending status. Requires `tier2Enabled()` (if disabled, return a clear 4xx/`{error}`).

- [ ] **Step 4: Run → PASS** + typecheck + full suite green.

- [ ] **Step 5: Commit** — `feat(worker): POST /tier2-trigger manual deep-layer trigger (idempotent)`

---

## Chunk 5: Desktop rendering

### Task 5.1: Mirror deep-layer types in desktop

**Files:**
- Modify: `desktop/src/types.ts`
- Test: `desktop/src/__tests__/tier2-types.test.ts` (or co-located) — structural, like Task 1.1

- [ ] **Step 1: Write the failing test** — construct a report object with the 4 new optional fields, assert access. (Mirror Task 1.1.)
- [ ] **Step 2: Run → FAIL** (`cd desktop && npx vitest run <file>`).
- [ ] **Step 3: Implement** — mirror the 4 interfaces + optional report fields in `desktop/src/types.ts` (match the worker `types_v2.ts` shapes exactly).
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(desktop): mirror Tier2 deep-layer types`

### Task 5.2: Adapt `CandidateComparison` to `CrossPersonComparison`

**Files:**
- Modify: `desktop/src/components/CandidateComparison.tsx`
- Test: `desktop/src/components/CandidateComparison.test.tsx`

> Read the current component — it renders a Tier1 per-person score table from `persons: {person_name, dimensions}`. Adapt it to ALSO (or instead) render a `CrossPersonComparison` (`ranking` + `by_dimension` + `summary`). Prefer adding a new prop/branch over breaking the existing usage; if the existing usage is unused, replace it. Follow existing UI (liquid-glass) components.

- [ ] **Step 1: Write the failing test** — render `<CandidateComparison comparison={mockCrossPersonComparison} />`; assert it shows the ranking order, per-dimension ordering, and summary. (RTL, like existing component tests.)
- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement** — accept and render the `CrossPersonComparison` shape; keep accessibility (headings/roles) consistent with sibling components.
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(desktop): render cross-person comparison in CandidateComparison`

### Task 5.3: FeedbackView coaching + interviewer sections + re-run button

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` (+ small subcomponents if it keeps the view focused)
- Modify: `desktop/main.js`, `desktop/preload.js` (tier2Trigger IPC)
- Modify: `desktop/src/types/desktop-api.d.ts` (IPC type)
- Test: `desktop/src/views/<FeedbackView or subcomponent>.test.tsx`

- [ ] **Step 1: Write the failing test** — render FeedbackView (or extracted subcomponents) with a report containing `coaching_plans` + `interviewer_perspective`; assert the coaching items and interviewer decision-support render. Assert the "Regenerate deep review" button calls `window.desktopAPI.tier2Trigger`. Mock desktopAPI.
- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement** —
  - Add `tier2Trigger({ baseUrl, sessionId })` IPC: `preload.js` exposes it, `main.js` POSTs `/v1/sessions/{id}/tier2-trigger` via the existing `requestJson` (with `x-api-key`), `desktop-api.d.ts` types it.
  - FeedbackView: render `coaching_plans` (per person) + `interviewer_perspective` sections when present (they're optional — hide when absent). Add a "Regenerate deep review" button (visible once Tier1 is ready) that calls `tier2Trigger` and re-enters the existing tier2 poll. Keep the view focused — extract a `DeepReviewSection`/`CoachingSection` subcomponent if FeedbackView grows large. Follow existing liquid-glass UI; do NOT redesign (Phase X is separate).
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + full desktop suite green.
- [ ] **Step 5: Commit** — `feat(desktop): coaching + interviewer-perspective sections + regenerate-deep-review button`

---

## Chunk 6: Deploy + live validation (user-run — NOT auto-testable)

> After Chunks 1–5 land green, deploy and validate the ≤5min budget + report quality on a real meeting. The implementer does the deploy; the user runs the live gate.

- [ ] **Deploy:** `cd edge/worker && npx wrangler deploy --env=""` (top-level = prod). Confirm `/health` 200 and that `TIER2_AUTO_TRIGGER=true` + the two Tier2 vars appear in the deploy bindings. Keep `feat/phase6-cloud-companion` synced to `main`.
- [ ] **Gate Q1 — Tier2 end-to-end:** finalize a real session (or re-run via the harness / the desktop app). PASS = after Tier1, Tier2 auto-runs, `tier2-status` reaches `succeeded`, the report gains cross_person_comparison + coaching_plans + interviewer_perspective, AND per_person scores are UNCHANGED from Tier1.
- [ ] **Gate Q2 — ≤5min budget:** measure Tier2 wall-time on a 30–60min real meeting (R3 audio). PASS = Tier2 completes ≤5min. If it exceeds, split the single deep call into two (cross-person+coaching / interviewer+deep) per the design's fallback, or lower `TIER2_TRANSCRIPT_MAX_TOKENS`.
- [ ] **Gate Q3 — failure non-regression:** force a deep-call failure (e.g. bad model temporarily) and confirm the Tier1 report stays intact and `tier2-status=failed` (desktop keeps showing Tier1). 
- [ ] **Gate Q4 — manual re-run:** click "Regenerate deep review" → Tier2 re-runs and replaces the deep sections.

> Record results in `Task.md` §6.

---

## Notes for the implementer
- Reuse, don't reinvent: `parsePositiveInt`, `truncateTranscript`, `callDashScope`, `sanitizeClaimEvidenceRefs`/`validateClaimEvidenceRefs`, the existing JSON parse/repair helper, the existing Tier2 alarm/status/persist plumbing.
- The single most important invariant (test it hard): **Tier2 NEVER overwrites Tier1's `per_person`/`overall`/`stats`, and a Tier2 failure NEVER corrupts the stored Tier1 result.**
- Keep decision logic pure + unit-tested (`augmentTier1WithDeepLayer`, `tier2TriggerDecision`, `shouldScheduleTier2`, the resolvers); DO/WS/R2/timer wiring is integration validated by the live gates.
- DashScope rollback knobs unchanged (`enable_thinking:false`, model from `LLM_MODEL`). If qwen3.7-plus deep latency is high, `TIER2_TRANSCRIPT_MAX_TOKENS` + the split-call fallback are the levers — do NOT re-enable thinking.
