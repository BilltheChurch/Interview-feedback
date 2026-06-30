# Setup Evaluation Rubric — Consolidation + Wiring Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Session Setup Step 2's two overlapping + inert scoring controls (Rubric Template + 面试类型) into ONE editable English "Evaluation Rubric" control, and WIRE the chosen dimensions (with weights) through to the worker so they actually drive the report's per-person scoring. Keep Interview Flow untouched.

**Architecture:** The worker dimension pipeline is ALREADY wired end-to-end (`/config`→`state.config`→`sessionContext`→synthesis `evaluation_dimensions`→per_person scored on `dimension_presets[].key`). The only gaps: (1) the desktop never SENDS `interview_type`/`dimension_presets` (it doesn't even call `/config`), and (2) dimension `weight` is stripped before reaching the LLM and the prompt ignores it. So: desktop sends the two fields via the existing `finalizeV2` metadata; worker merges them into `state.config` (same pattern as memos/free_form_notes); worker stops stripping `weight` and the synthesis prompt is told to weight dimensions. Desktop UI merges the two cards into one type-picker + full dimension editor + reusable-template save/load.

**Tech Stack:** Electron + React + TypeScript (desktop, vitest 234 green), Cloudflare Worker + DashScope qwen3.7-plus (worker, vitest 602 green).

**Design doc:** `docs/superpowers/specs/2026-06-30-setup-evaluation-rubric-design.md` — read it; it has the locked decisions (D1–D7), the custom-dim key-gen rule, lazy migration, and the weight-stripping fix. This plan implements that spec.

**Baseline:** branch `claude/ecstatic-chaum-51c7eb` = main = 4bf7eca. Desktop: `cd desktop && npx vitest run` (234) + `npx tsc --noEmit`. Worker: `cd edge/worker && npx vitest run` (602) + `npm run typecheck`. **Run desktop commands FROM `desktop`, worker FROM `edge/worker`.**

**Project rules:** commits MUST NOT contain a `Co-Authored-By` trailer (verify each: `git log -1 --format='%B' <sha> | grep -ci co-authored` → 0). English UI copy + identifiers (this fixes the Chinese inconsistency). Don't stage junk (`.playwright-mcp/`, `verify-Cc.png`). Each task: TDD (failing test → fail → implement → pass → commit).

---

## File Structure

**Desktop (`desktop/`):**
- `src/lib/dimensionPresets.ts` — Modify: add `generateDimensionKey(name)` + `ensureDimensionKeys(dims)` (lazy migration) helpers; keep the 4 presets.
- `src/components/EvaluationRubricEditor.tsx` — Create: the merged control (type pills + full dimension editor + save/load custom templates). Extracted so SetupView stays focused. Absorbs the editing/localStorage capability from the old `RubricTemplateModal`.
- `src/views/SetupView.tsx` — Modify: replace the "Rubric Template" card + the "面试类型" card with `<EvaluationRubricEditor>`; remove `BUILTIN_TEMPLATES`; keep Interview Flow; thread the editor's `{interviewType, dimensions}` into `startSession`/session config.
- `src/components/RubricTemplateModal.tsx` — Modify or remove: fold its useful editor/localStorage logic into `EvaluationRubricEditor`; delete if fully superseded.
- `src/hooks/useSessionFlow.ts` — Modify: add `interview_type` + `dimension_presets` to the `finalizeV2` metadata.
- `desktop/main.js` — Modify: ensure the `finalizeV2` metadata body forwards the 2 new fields to the worker (it sends `metadata` already).
- `src/stores/sessionStore.ts` — Modify (if needed): ensure `interviewType` + `dimensionPresets` are actually stored (currently dropped) so `useSessionFlow` can read them at finalize.

**Worker (`edge/worker/`):**
- `src/finalize-orchestrator.ts` — Modify: in the finalize-metadata→`state.config` merge (currently memos/free_form_notes ~757-787), also merge `interview_type` (string) + `dimension_presets` (array).
- `src/services/llm-synthesizer.ts` — Modify: `getDimensionPresets()` keep `weight`; system prompt rule 4 instruct weighting.
- `tests/*` — new/extended.

> **First action per task:** read the named files + the spec section to confirm current behavior; cite real symbols (line numbers may have shifted).

---

## Chunk 1: Desktop preset utilities (pure, testable)

### Task 1.1: `generateDimensionKey` + `ensureDimensionKeys`

**Files:**
- Modify: `desktop/src/lib/dimensionPresets.ts`
- Test: `desktop/src/lib/dimensionPresets.test.ts`

- [ ] **Step 1: Write the failing test** — per the spec's locked key-gen rule:
```ts
import { generateDimensionKey, ensureDimensionKeys } from "./dimensionPresets";
// generateDimensionKey("System Design") -> /^custom_system_design_[a-z0-9]{6}$/
// generateDimensionKey("  ?? ") (empty slug) -> /^custom_dim_[a-z0-9]{6}$/
// generateDimensionKey("A Very Long Dimension Name Beyond Twenty Chars") -> slug capped at 20 chars
// ensureDimensionKeys([{name:"X", weight:3, description:"d"}]) -> each item gains a key matching /^custom_/; existing keys preserved
```
Assert the regex shape, the 20-char slug cap, empty→`dim`, and that `ensureDimensionKeys` preserves an existing `key` and only generates for missing ones.

- [ ] **Step 2: Run → FAIL** (`cd desktop && npx vitest run src/lib/dimensionPresets.test.ts`).

- [ ] **Step 3: Implement** — `generateDimensionKey(name)`: `"custom_" + (slug || "dim") + "_" + base36(6)` where `slug = name.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,20)` and `base36(6) = Math.random().toString(36).slice(2,8)` padded to 6. `ensureDimensionKeys(dims)`: map, `key: d.key || generateDimensionKey(d.name ?? d.label_en ?? "")`, carry label/description/weight (default weight 1 if missing). (Random in tests: assert the REGEX shape, not exact value.)

- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `feat(desktop): dimension key-gen + lazy-migration helpers`

---

## Chunk 2: Desktop merged Evaluation Rubric control

### Task 2.1: `EvaluationRubricEditor` component

**Files:**
- Create: `desktop/src/components/EvaluationRubricEditor.tsx`
- Test: `desktop/src/components/EvaluationRubricEditor.test.tsx`

> Read `RubricTemplateModal.tsx` (existing editor + localStorage `ifb_rubric_templates`), `lib/dimensionPresets.ts` (the 4 presets), and existing UI primitives (TextField, Card, Button) first. The new component MERGES: type pills (Academic/Technical/Behavioral/Group) + a full per-dimension editor + save/load reusable templates. English only.

- [ ] **Step 1: Write the failing test** — render `<EvaluationRubricEditor value={...} onChange={...} />`:
  - shows 4 type pills (English labels); clicking "Technical" loads that preset's dimensions (problem_analysis, coding_ability, …) and calls `onChange` with `{interviewType:"technical", dimensions:[...]}`.
  - editing a dimension's name/description/weight updates `onChange`; a PRESET dim keeps its original `key` after rename (assert key unchanged); "Add dimension" appends a custom dim with a generated `key` (matches `/^custom_/`); delete is disabled at 3 dims and add disabled at 6.
  - "Save as template" persists to localStorage (`ifb_rubric_templates`) and a saved template can be re-selected (mock localStorage).

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** the component:
  - props: `value: { interviewType: string; dimensions: DimensionPresetItem[] }`, `onChange(value)`.
  - type pills from `DIMENSION_PRESETS` (hardcode English pill labels: Academic/Technical/Behavioral/Group keyed by `interview_type`). Selecting a type loads `getPresetByType(type).dimensions` (deep-copied).
  - dimension rows: editable `name` (label_en/label), `description`, `weight` (numeric 1–5); delete button (enabled when `dimensions.length>3`); "Add dimension" (enabled when `<6`) appends `{ key: generateDimensionKey(""), label_en:"", description:"", weight:1 }`.
  - **Preset dim rename keeps key**: only set a new key when ADDING; never regenerate an existing dim's key on edit.
  - top explanatory line: "These dimensions are what the AI uses to score each candidate. Pick a type, then tweak."
  - save/load custom templates via localStorage `ifb_rubric_templates` (load applies `ensureDimensionKeys`); reuse `RubricTemplateModal` logic where clean.
  - English UI, liquid-glass styling consistent with existing components.

- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `feat(desktop): EvaluationRubricEditor — merged type + dimension editor + templates`

### Task 2.2: Integrate into SetupView (remove old two cards)

**Files:**
- Modify: `desktop/src/views/SetupView.tsx`
- Modify/Remove: `desktop/src/components/RubricTemplateModal.tsx` (delete if fully superseded; otherwise leave only what EvaluationRubricEditor reuses)
- Test: `desktop/src/views/SetupView.test.tsx` (or the existing setup test) — assert Step 2 renders one rubric editor + Interview Flow, and `startSession` receives `{interviewType, dimensionPresets}`.

- [ ] **Step 1: Write the failing test** — render SetupView, navigate to Step 2; assert the old "Rubric Template" + "面试类型" cards are gone, `<EvaluationRubricEditor>` is present, Interview Flow still present; on start, `startSession` is called with `interviewType` + `dimensionPresets` populated (not dropped).

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** — replace the two cards (Rubric Template ~1061-1168 + 面试类型 ~1170-1237) with `<EvaluationRubricEditor value={{interviewType, dimensions:dimensionPresets}} onChange={(v)=>{setInterviewType(v.interviewType); setDimensionPresets(v.dimensions);}} />`. Remove `BUILTIN_TEMPLATES` (lines 64-103) and its references (template state for the old system). Keep `stages`/FlowEditor. Ensure `startSession({...interviewType, dimensionPresets})` actually carries them. Delete `RubricTemplateModal.tsx` if nothing else uses it (grep first).

- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + full desktop suite.

- [ ] **Step 5: Commit** — `feat(desktop): consolidate Setup Step 2 to one Evaluation Rubric control`

---

## Chunk 3: Desktop → worker wiring

### Task 3.1: Store + forward interview_type + dimension_presets

**Files:**
- Modify: `desktop/src/stores/sessionStore.ts` (store the 2 fields in `startSession` if currently dropped)
- Modify: `desktop/src/hooks/useSessionFlow.ts` (add to finalizeV2 metadata)
- Modify: `desktop/main.js` (forward in the finalizeV2 request body)
- Modify: `desktop/src/types/desktop-api.d.ts` (if the IPC metadata type needs the fields)
- Test: `desktop/src/hooks/useSessionFlow.test.ts` (or store test)

> Read `sessionStore.ts startSession` (the audit found `interviewType`/`dimensionPresets` are accepted by `SessionConfig` but NOT written into the store) and `useSessionFlow.ts` finalizeV2 metadata (currently memos/free_form_notes/stages/participants) and `main.js` finalizeV2 (the metadata body it POSTs).

- [ ] **Step 1: Write the failing test** — assert: (a) `startSession({interviewType, dimensionPresets})` results in the store holding them; (b) the finalizeV2 metadata object built in `useSessionFlow` includes `interview_type` + `dimension_presets` from the session. Mock as needed.

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** — in `sessionStore.startSession`, write `interviewType` + `dimensionPresets` into the store (+ `PersistedSession` for crash recovery). In `useSessionFlow.ts`, add `interview_type: sessionData.interviewType` and `dimension_presets: sessionData.dimensionPresets` to the finalizeV2 metadata. In `main.js`, ensure the metadata body passes them through (it forwards the metadata object — confirm no allowlist drops unknown keys). Update IPC type if needed.

- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + full desktop suite.

- [ ] **Step 5: Commit** — `feat(desktop): send interview_type + dimension_presets in finalizeV2 metadata`

---

## Chunk 4: Worker — merge rubric from finalize metadata

### Task 4.1: Merge interview_type + dimension_presets into state.config

**Files:**
- Modify: `edge/worker/src/finalize-orchestrator.ts` (metadata→state.config merge)
- Test: `edge/worker/tests/finalize-rubric-metadata.test.ts`

> Read the finalize-metadata merge (~757-787) — currently merges `memos` + `free_form_notes` into `state.config` with `if (typeof metadata.X ...)`. The orchestrator already copies `state.config.interview_type`/`dimension_presets` into `sessionContext` (~417-422/1166-1171). So this task just feeds them from finalize metadata.

- [ ] **Step 1: Write the failing test** — extract/locate a pure merge helper `mergeFinalizeMetadataIntoConfig(config, metadata)` (or test the merge logic): given metadata with `interview_type:"technical"` + `dimension_presets:[...]`, the resulting config has both; given absent → config unchanged; given malformed `dimension_presets` (not array) → ignored.

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** — in the metadata merge, add: `if (typeof metadata.interview_type === "string") config.interview_type = metadata.interview_type;` and `if (Array.isArray(metadata.dimension_presets)) config.dimension_presets = metadata.dimension_presets;` (validate items have key/label/weight loosely). Keep it minimal, mirror the existing memos/free_form_notes pattern.

- [ ] **Step 4: Run → PASS** + `npm run typecheck` + full worker suite.

- [ ] **Step 5: Commit** — `feat(worker): accept interview_type + dimension_presets from finalize metadata`

---

## Chunk 5: Worker — weights influence scoring

### Task 5.1: Keep weight in evaluation_dimensions + prompt weighting

**Files:**
- Modify: `edge/worker/src/services/llm-synthesizer.ts` (`getDimensionPresets` + system prompt rule 4)
- Test: `edge/worker/tests/synth-dimension-weight.test.ts`

> Read `getDimensionPresets` (~234-239 — it currently STRIPS `weight`) and system prompt rule 4 (~421 — no weight mention). The fix: include `weight` in the mapped `evaluation_dimensions`, and instruct the LLM to weight.

- [ ] **Step 1: Write the failing test** — call `getDimensionPresets({ session_context: { dimension_presets: [{key:"a",label_zh:"A",description:"d",weight:5},{key:"b",label_zh:"B",description:"d",weight:1}] } })`; assert the returned array INCLUDES `weight` (5 and 1) — currently it's stripped. Also assert that with no dimension_presets it returns the default 5 (back-compat). (The prompt-weighting instruction is verified by asserting the system prompt string contains a weight directive — a string-contains test on the built prompt.)

- [ ] **Step 2: Run → FAIL** (weight currently stripped).

- [ ] **Step 3: Implement** — `getDimensionPresets` maps include `weight: d.weight ?? 1`. Update system prompt rule 4 to instruct: dimensions still scored 0-10 each, but per-person overall assessment AND cross-person ranking must WEIGHT dimensions by their `weight` (higher weight = more influence on the overall conclusion). Ensure `evaluation_dimensions` in the user prompt JSON now carries weight.

- [ ] **Step 4: Run → PASS** + `npm run typecheck` + full worker suite (confirm no regression — existing synthesis tests with default presets still pass; default weights are 1 so behavior for unweighted rubrics is unchanged).

- [ ] **Step 5: Commit** — `feat(worker): dimension weights influence synthesis scoring + ranking`

---

## Chunk 6: Deploy + live validation (user-run — NOT auto-testable)

> After Chunks 1–5 land green, deploy the worker and validate end-to-end with the real desktop app.

- [ ] **Deploy:** `cd edge/worker && npx wrangler deploy --env=""`; confirm `/health` 200. Keep `feat/phase6-cloud-companion` synced to `main`. (Desktop changes ship by running the updated app `cd desktop && npm run dev`.)
- [ ] **Gate S1 — type drives report dimensions:** run a real session with the updated app, pick "Technical". PASS = the finalized report's per_person dimensions are the Technical set (problem_analysis/coding_ability/system_design/communication/initiative), NOT the default leadership/collaboration/logic/structure/initiative.
- [ ] **Gate S2 — edits drive report:** add/rename/remove a dimension in the editor, run a session. PASS = the report scores on exactly the edited dimension set (custom dim appears).
- [ ] **Gate S3 — weight influences:** set one dimension's weight high (e.g. 5) and others low, run a session. PASS = the high-weight dimension visibly dominates the per_person overall/ranking rationale.
- [ ] **Gate S4 — back-compat:** a session where the user doesn't touch the rubric (default Group) still works; no rubric breakage.
- [ ] **Gate S5 — templates:** save a custom rubric as a template, reload the app, confirm it's selectable and applies.

> Record results in `Task.md` §6.

---

## Notes for the implementer
- Reuse: `lib/dimensionPresets.ts` (the 4 presets, already worker-synced), `RubricTemplateModal`'s editor/localStorage logic, the worker's already-wired `/config`→sessionContext→synthesis dimension path, existing UI primitives.
- The worker dimension PIPELINE is already wired — Chunks 4-5 are small (feed it from finalize metadata + stop stripping weight + prompt). The bulk of the work is the desktop UI merge (Chunk 2).
- Keep decision logic pure + unit-tested (key-gen, ensureDimensionKeys, the metadata merge, getDimensionPresets weight inclusion); UI rendering verified by component tests; the LLM weighting effect verified by the live gates.
- Back-compat is critical: no `dimension_presets` sent → worker uses default 5 dims (existing behavior). Default weights are 1.0 → unweighted rubrics behave exactly as before.
