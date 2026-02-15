# Production Readiness Plan — Interview Feedback MVP-A

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden backend security, fix evidence pipeline integrity issues, refactor code quality, elevate UI/UX to Granola-level polish, and establish production-grade testing. The end state is a deployable product that exceeds BrightHire's core experience in the Chinese-bilingual interview feedback domain.

**Architecture:** Monorepo — inference/ (FastAPI), edge/worker/ (Cloudflare Worker+DO+R2), desktop/ (Electron+React+Zustand). All backend communication is Worker→Inference (server-to-server). Desktop↔Worker via WebSocket (audio) and REST (config/finalize/feedback).

**Tech Stack:** Python 3.11, FastAPI, Cloudflare Workers, Durable Objects, R2, DashScope (ASR+LLM), React 18, Zustand, TypeScript, Tailwind v4, Electron 31, Vite, Vitest, Playwright

**Sources:** Combined findings from internal code review (3 agents) + Codex static security audit.

---

## Phase 1: Security & Evidence Pipeline Integrity [P0-P1]

### Task 1.1: Edge Worker Authentication Middleware

**Problem:** Zero authentication on all Worker endpoints. Any caller can access any session.

**Files:**
- Modify: `edge/worker/src/index.ts` (outer `fetch()` handler, lines 1505-1713)
- Create: `edge/worker/src/auth.ts` (new module)
- Modify: `edge/worker/wrangler.jsonc` (add `WORKER_API_KEY` secret binding)

**Implementation:**

1. Create `edge/worker/src/auth.ts`:
```typescript
export function validateApiKey(request: Request, env: { WORKER_API_KEY?: string }): Response | null {
  const key = env.WORKER_API_KEY;
  if (!key) return null; // no key configured = open (dev mode)

  const incoming = request.headers.get('x-api-key') ||
    new URL(request.url).searchParams.get('api_key'); // allow query param for WebSocket

  if (!incoming || !timingSafeEqual(incoming, key)) {
    return new Response(JSON.stringify({ detail: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }
  return null; // authorized
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
```

2. In `index.ts` outer `fetch()`, add auth check before routing:
```typescript
import { validateApiKey } from './auth';
// ... at top of fetch handler, after CORS preflight:
const authError = validateApiKey(request, env);
if (authError) return authError;
```

3. Add `WORKER_API_KEY` to `wrangler.jsonc` vars (empty for dev, secret for prod):
```bash
npx wrangler secret put WORKER_API_KEY
```

**Verify:** `curl -H "x-api-key: wrong" https://worker/v1/sessions/test/state` → 401

---

### Task 1.2: Fix Evidence Namespace Collision in Finalize v2 Fallback

**Problem:** When `POST /analysis/synthesize` fails and falls back to legacy `POST /analysis/report`, the evidence IDs in claims (`e_000001...`) come from `buildEvidence()` (legacy), but the final `ResultV2` writes `evidence` from `buildMultiEvidence()` (multi-evidence). The IDs collide but reference different utterances.

**Files:**
- Modify: `edge/worker/src/index.ts` (lines 4631-4638, 4685, 4904)
- Modify: `edge/worker/src/finalize_v2.ts` (lines 276, 553)

**Implementation:**

Option A (Recommended): When falling back to legacy report, regenerate evidence pack from `buildEvidence()` and use THAT as the final evidence in the result (not multi-evidence).

In `index.ts` around line 4685 (fallback to legacy report):
```typescript
// When using legacy report fallback, use legacy evidence pack
if (reportSource === 'legacy' || reportSource === 'memo_first') {
  // Replace multi-evidence with legacy evidence so refs match
  evidence = legacyEvidence;
}
```

And at line 4904 where `result_v2` is assembled:
```typescript
evidence: evidence, // already switched to match report source
```

Option B: Prefix legacy evidence IDs with `leg_` to prevent collision:
In `finalize_v2.ts:553`, change `buildEvidence()` to use prefix `leg_e_`:
```typescript
const legacyEvidenceId = `leg_e_${String(idx + 1).padStart(6, '0')}`;
```

**Verify:** Run finalize with synthesize intentionally failing (disconnect inference). Check that every `evidence_ref` in every claim resolves to an entry in the final `evidence` array.

---

### Task 1.3: Fix Report Synthesizer Fallback Integrity

**Problem:** Multiple issues in `report_synthesizer.py` fallback paths.

**Files:**
- Modify: `inference/app/services/report_synthesizer.py` (lines 369, 447, 458, 465)

**Implementation:**

1. **Remove dummy text** (lines 369, 458):
```python
# Before:
text = "Pending assessment."
# After:
text = f"Insufficient data for {dim_name} assessment — awaiting more evidence."
```
Ensure locale-aware messaging:
```python
if locale.startswith("zh"):
    text = f"{dim_name} 维度数据不足，暂无法评估。"
else:
    text = f"Insufficient data for {dim_name} assessment — awaiting more evidence."
```

2. **Fix "none" evidence id** (line 447):
```python
# Before:
evidence_refs=["none"]
# After:
fallback_refs = self._fallback_refs_for_person(person_key, evidence_by_person, all_refs)
evidence_refs = fallback_refs[:1] if fallback_refs else []
```
If truly no evidence exists, the claim should have `evidence_refs=[]` and be flagged via `needs_evidence_count`.

3. **Fix multi-person loss** (line 465):
```python
# Before:
for stat in req.stats[:1]:
# After:
for stat in req.stats:
```

**Verify:** `cd inference && python -m pytest tests/test_report_synthesizer.py -v` — all pass. Write new test for multi-person fallback.

---

### Task 1.4: Inference Service Security Hardening

**Files:**
- Modify: `inference/app/main.py` (lines 61, 227-230)
- Modify: `inference/app/services/audio.py` (line 81)
- Modify: `inference/app/services/dashscope_llm.py` (lines 37-39)
- Modify: `inference/.gitignore`
- Delete secret from: `inference/.env` (rotate key)

**Implementation:**

1. **Constant-time API key comparison** (`main.py:61`):
```python
import hmac
# Before:
if incoming_key != settings.inference_api_key:
# After:
if not hmac.compare_digest(incoming_key, settings.inference_api_key):
```

2. **Sanitize error responses** (`main.py:227-230`):
```python
# Before:
content=ErrorResponse(detail=f"internal server error: {exc}").model_dump()
# After:
logger.exception("Unhandled error")
content=ErrorResponse(detail="internal server error").model_dump()
```

3. **Add ffmpeg timeout** (`audio.py:81`):
```python
# Before:
process = subprocess.run(ffmpeg_cmd, input=raw_audio, ...)
# After:
process = subprocess.run(ffmpeg_cmd, input=raw_audio, ..., timeout=30)
```
Add exception handler:
```python
except subprocess.TimeoutExpired:
    raise ValueError("audio normalization timed out (>30s)")
```

4. **Use async httpx + connection pool** (`dashscope_llm.py`):
```python
# Create shared client at module level
_client: httpx.Client | None = None

def _get_client(timeout: float) -> httpx.Client:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.Client(timeout=timeout)
    return _client
```

5. **Fix .gitignore**:
```
# Add to inference/.gitignore:
.env
.env.*
!.env.example
```

6. **Rotate DashScope API key**: User must do this manually in DashScope console.

**Verify:** `cd inference && python -m pytest tests/ -v`

---

### Task 1.5: Fix Chinese Token Counting

**Files:**
- Modify: `inference/app/services/report_synthesizer.py` (line 251, `_estimate_tokens` method)

**Implementation:**
```python
def _estimate_tokens(self, text: str) -> int:
    """Estimate token count. For Chinese text, each character ≈ 1-2 tokens.
    For English, each word ≈ 1.3 tokens. Mixed text uses character-based counting."""
    if not text:
        return 0
    # Count CJK characters (each ≈ 1.5 tokens on average for qwen)
    cjk_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff' or '\u3400' <= c <= '\u4dbf')
    if cjk_chars > len(text) * 0.3:
        # Predominantly Chinese: character-based estimate
        return int(len(text) * 1.5)
    else:
        # Predominantly English: word-based estimate
        return int(len(text.split()) * 1.3)
```

**Verify:** Test with Chinese transcript. Verify truncation activates at ~4000 characters (≈6000 tokens) instead of ~6000 words.

---

## Phase 2: Code Quality & Refactoring [P2]

### Task 2.1: Split Edge Worker index.ts into Modules

**Problem:** 6581-line god file is unmaintainable.

**Files:**
- Modify: `edge/worker/src/index.ts` → split into:
- Create: `edge/worker/src/router.ts` — HTTP routing logic
- Create: `edge/worker/src/websocket.ts` — WebSocket message handling
- Create: `edge/worker/src/asr.ts` — ASR processing (realtime + windowed)
- Create: `edge/worker/src/speaker.ts` — Speaker resolution + enrollment
- Create: `edge/worker/src/feedback.ts` — Feedback cache, regeneration, export
- Create: `edge/worker/src/audio-utils.ts` — PCM/WAV utilities
- Create: `edge/worker/src/storage.ts` — DO storage helpers
- Keep: `edge/worker/src/index.ts` — Durable Object class (core state + method delegation)

**Approach:** Extract pure functions first (no `this` dependency), then extract methods that take explicit DO state parameters. The DO class remains the orchestrator but delegates to modules.

**Verify:** `cd edge/worker && npm run typecheck` — 0 errors. Existing smoke scripts still pass.

---

### Task 2.2: Fix Async/Sync Blocking in Inference

**Files:**
- Modify: `inference/app/main.py` (all route handlers)
- Modify: `inference/app/services/dashscope_llm.py`

**Implementation:**

Option A (Simpler): Remove `async` from CPU-bound handlers so FastAPI auto-threads them:
```python
# Before:
@app.post("/speaker/resolve")
async def resolve_speaker(req: ResolveRequest):
# After:
@app.post("/speaker/resolve")
def resolve_speaker(req: ResolveRequest):
```

Option B: Keep async but wrap blocking calls:
```python
result = await asyncio.to_thread(orchestrator.resolve, req.session_id, ...)
```

Recommendation: Option A for simplicity — all our handlers are CPU-bound.

For DashScope LLM calls specifically, convert to async httpx:
```python
import httpx
# Module-level async client
_async_client: httpx.AsyncClient | None = None

async def generate_json_async(self, ...):
    async with httpx.AsyncClient(timeout=self.timeout) as client:
        response = await client.post(...)
```

**Verify:** Run inference under load (10 concurrent requests), confirm no event loop blocking warnings.

---

### Task 2.3: Deduplicate Reconciliation Logic

**Files:**
- Modify: `edge/worker/src/index.ts` — extract shared reconciliation into `edge/worker/src/reconcile.ts`

**Implementation:**
Extract the shared logic used in:
- `buildTranscriptForFeedback()` (line 2384)
- `runFinalizeV2Job()` (line 4547)
- `state` GET handler (line 5401)

Create `reconcile.ts`:
```typescript
export function inferStudentsClusterFromEdgeTurns(
  turns: EdgeTurn[],
  events: SpeakerEvent[],
  clusterBindingMeta: ClusterBindingMeta
): Map<string, string> { ... }

export function buildReconciliedTranscript(
  utterances: UtteranceRaw[],
  events: SpeakerEvent[],
  speakerLogs: SpeakerLogTurn[],
  state: SessionState
): TranscriptSegment[] { ... }
```

**Verify:** `cd edge/worker && npm run typecheck` — 0 errors.

---

### Task 2.4: Implement R2 Storage Cleanup

**Files:**
- Modify: `edge/worker/src/index.ts` (add cleanup to `alarm()` handler)
- Modify: `edge/worker/wrangler.jsonc` (ensure `AUDIO_RETENTION_HOURS` is read)

**Implementation:**
In the DO `alarm()` handler, after watchdog check, add cleanup:
```typescript
// Check if session is finalized and chunks are old enough
const finalizedAt = await this.ctx.storage.get<string>(STORAGE_KEY_FINALIZED_AT);
if (finalizedAt) {
  const age = Date.now() - new Date(finalizedAt).getTime();
  const retentionMs = (Number(this.env.AUDIO_RETENTION_HOURS) || 72) * 3600 * 1000;
  if (age > retentionMs) {
    await this.cleanupAudioChunks();
  }
}
```

**Verify:** Deploy, finalize a session, wait for retention period, confirm chunks cleaned.

---

## Phase 3: UI/UX Elevation to Granola Level

### Task 3.1: UX Research — Competitor Analysis

**Deliverable:** Design spec document at `docs/plans/2026-02-15-ux-elevation-design.md`

**Research targets:**
1. **Granola** — meeting notes UX: auto-capture, clean transcript view, inline editing, export
2. **BrightHire** — interview intelligence: scorecard UX, evidence highlighting, collaborative feedback
3. **Metaview** — interview recording: candidate summary, structured notes, ATS integration UI
4. **Otter.ai** — transcription: real-time display, speaker labels, searchable history

**Analysis dimensions:**
- First-run experience (setup → first session time-to-value)
- Live recording UX (visual feedback, cognitive load, information density)
- Post-session review UX (report readability, evidence navigation, export quality)
- Navigation and information architecture
- Animation and microinteraction patterns
- Empty states and error states
- Typography, spacing, color usage

### Task 3.2: Redesign Core Views

Based on research, redesign:

**SetupView** — Current: form-heavy. Target: 3-step wizard with smart defaults, calendar integration preview, one-click "Start Recording"

**SidecarView** — Current: functional but dense. Target:
- Clean two-panel layout (left: interview controls, right: live transcript)
- Floating action bar for memos (keyboard shortcut focused)
- Stage timeline with visual progress
- Audio meters integrated into header (subtle, not distracting)
- Live transcript with real-time speaker labels and timestamps

**FeedbackView** — Current: basic card layout. Target:
- Executive summary card at top
- Per-person tabbed view with dimension radar chart
- Evidence panel with click-to-jump-to-transcript
- Print-ready export (PDF/DOCX with company branding)
- Share link generation

**HistoryView** — Current: simple list. Target:
- Card grid with session thumbnails (participant avatars, date, duration, quality score)
- Search and filter (by date, participant, quality)
- Quick actions (re-open, export, delete)

**Files to modify:**
- `desktop/src/views/SetupView.tsx`
- `desktop/src/views/SidecarView.tsx`
- `desktop/src/views/FeedbackView.tsx`
- `desktop/src/views/HistoryView.tsx`
- `desktop/src/components/PipOverlay.tsx`
- New components as needed in `desktop/src/components/`

### Task 3.3: Animation & Microinteraction System

**Files:**
- Create: `desktop/src/lib/animations.ts` — shared animation variants
- Modify: Views to use consistent animation patterns

**Patterns:**
- Page transitions: slide + fade (200ms ease-out)
- Card enter: scale(0.98) → scale(1) + opacity (150ms)
- Audio meters: spring physics for natural movement
- Stage transitions: progress bar with easing
- Memo creation: slide-in from right with bounce
- PiP: enter/exit with scale + opacity

### Task 3.4: Polish — Empty States, Loading, Error UX

**Files:**
- Create: `desktop/src/components/EmptyState.tsx`
- Create: `desktop/src/components/SkeletonLoader.tsx`
- Modify: All views to use consistent patterns

**Patterns:**
- Empty history: illustration + "Start your first interview" CTA
- Loading feedback: skeleton cards matching final layout
- Error states: friendly message + retry button + help link
- Connection lost: toast notification + auto-reconnect indicator

---

## Phase 4: Testing Infrastructure

### Task 4.1: Edge Worker Unit Tests

**Files:**
- Create: `edge/worker/tests/` directory
- Create: `edge/worker/tests/auth.test.ts`
- Create: `edge/worker/tests/reconcile.test.ts`
- Create: `edge/worker/tests/finalize.test.ts`
- Create: `edge/worker/tests/websocket.test.ts`
- Create: `edge/worker/vitest.config.ts`

**Priority test areas:**
1. Auth middleware (valid key, invalid key, missing key, dev mode)
2. Evidence namespace integrity (multi-evidence vs legacy IDs never collide)
3. Finalize pipeline stage transitions (happy path + each fallback)
4. WebSocket message parsing and validation
5. Utterance merging deduplication

### Task 4.2: Inference Service Test Gaps

**Files:**
- Create: `inference/tests/test_audio_normalization.py`
- Create: `inference/tests/test_events_analyzer.py`
- Create: `inference/tests/test_dashscope_llm.py`
- Create: `inference/tests/test_regenerate_claim.py`
- Modify: `inference/tests/test_report_synthesizer.py` (add multi-person fallback test)

**Priority tests:**
1. Multi-person fallback retains all speakers
2. No "none" evidence IDs in output
3. No "Pending assessment" text in output
4. Chinese token counting accuracy
5. ffmpeg timeout handling

### Task 4.3: Desktop Hook & Service Tests

**Files:**
- Create: `desktop/src/stores/sessionStore.test.ts`
- Create: `desktop/src/services/AudioService.test.ts`
- Create: `desktop/src/services/WebSocketService.test.ts`
- Create: `desktop/src/hooks/useSessionOrchestrator.test.ts`

### Task 4.4: CI Pipeline Enhancement

**Files:**
- Modify: `.github/workflows/ci.yml`

**Additions:**
- Edge Worker: `vitest run` (after task 4.1)
- E2E smoke test job (optional, needs secrets)
- Coverage reporting
- Quality gate check (optional)

---

## Phase 5: Integration & Verification

### Task 5.1: Full Build Verification

```bash
cd desktop && npx tsc --noEmit && npx vitest run && npx vite build
cd edge/worker && npm run typecheck && npx vitest run
cd inference && python -m pytest tests/ -v
```

### Task 5.2: End-to-End Flow Test

Manual test plan:
1. Start Electron app
2. Configure session with 2 participants
3. Record 2 minutes of audio
4. Verify ASR produces utterances
5. Finalize session
6. Verify report has correct evidence refs (no namespace collisions)
7. Verify all participants present in report (no multi-person loss)
8. Export report (markdown + DOCX)

### Task 5.3: Documentation Update

- Update `Inference_API_Contract.md` with any schema changes
- Create `edge/worker/API.md` — Edge Worker endpoint documentation
- Update `Task.md` with completed items
- Update `CLAUDE.md` if patterns changed

---

## Execution Order & Dependencies

```
Phase 1 (Security) ──────┐
                          ├──→ Phase 4 (Testing) ──→ Phase 5 (Integration)
Phase 2 (Code Quality) ──┘         ↑
                                    │
Phase 3 (UI/UX) ───────────────────┘
```

- Phase 1 and Phase 2 can run in parallel (different files)
- Phase 3 can start in parallel (different codebase area: desktop/ vs edge/ and inference/)
- Phase 4 depends on Phase 1 and 2 (tests verify the fixes)
- Phase 5 depends on all phases

**Estimated scope:** 6 new files, ~20 modified files, 1 new dependency (vitest for edge worker)
