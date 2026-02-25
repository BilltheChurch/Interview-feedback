# Code Quality Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix MEDIUM + LOW code quality issues — duplicated code, bare exception handling, TypeScript `any` usage, magic numbers, missing a11y, and DRY violations.

**Architecture:** Changes span all three components (Inference, Edge Worker, Desktop). Each task is independent within its component. No new dependencies except shared utility extraction within inference.

**Tech Stack:** Python/FastAPI, Cloudflare Workers/TypeScript, React/TypeScript

**Batches:**
- Batch 1 (Tasks 1-3): Inference — shared utility, exception specificity, type annotations
- Batch 2 (Tasks 4-6): Edge Worker — constants, error helper, duration helper
- Batch 3 (Tasks 7-9): Desktop — a11y fix, TypeScript `any` cleanup

---

### Task 1: Extract shared `detect_device()` into common utility

**Files:**
- Create: `inference/app/services/device.py`
- Modify: `inference/app/services/diarize_full.py:57-71`
- Modify: `inference/app/services/whisper_batch.py:65-80`
- Modify: `inference/app/services/sv.py:23-36`

**Step 1: Create the shared utility**

Create `inference/app/services/device.py`:

```python
"""Shared GPU/compute device detection for all ML services."""

from __future__ import annotations

from typing import Literal

DeviceType = Literal["cuda", "rocm", "mps", "cpu"]


def detect_device() -> DeviceType:
    """Return the best available compute device (CUDA > ROCm > MPS > CPU)."""
    try:
        import torch

        if torch.cuda.is_available():
            if hasattr(torch.version, "hip") and torch.version.hip is not None:
                return "rocm"
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"
```

**Step 2: Update `diarize_full.py`**

Replace lines 1-71 area: remove `DeviceType` definition and `detect_device()` function. Add import:

```python
from app.services.device import DeviceType, detect_device
```

Remove:
- The `DeviceType = Literal[...]` line
- The entire `def detect_device()` function (lines 57-71)

**Step 3: Update `whisper_batch.py`**

Remove `DeviceType` definition and `detect_device()` function (lines 65-80). Add import:

```python
from app.services.device import DeviceType, detect_device
```

**Step 4: Update `sv.py`**

Remove `SVDeviceType` definition and `detect_sv_device()` function (lines 14-36). Replace:

```python
from app.services.device import DeviceType as SVDeviceType, detect_device as detect_sv_device
```

Or better — rename internal usages from `SVDeviceType` to `DeviceType` and `detect_sv_device` to `detect_device`, updating all references within `sv.py`.

**Step 5: Run tests**

Run: `cd inference && python -m pytest tests/ -v`

**Step 6: Commit**

```bash
git add inference/app/services/device.py inference/app/services/diarize_full.py inference/app/services/whisper_batch.py inference/app/services/sv.py
git commit -m "refactor: extract shared detect_device() into common utility"
```

---

### Task 2: Replace bare `except Exception:` with specific exception types

**Files:**
- Modify: `inference/app/services/diarize_full.py:147,178,328`
- Modify: `inference/app/services/whisper_batch.py:172`
- Modify: `inference/app/services/report_synthesizer.py:1111`
- Modify: `inference/app/services/sv.py:94`
- Modify: `inference/app/routes/asr.py:160,166`

**Step 1: Fix `diarize_full.py`**

Line 147 — MPS transfer failure:
```python
# BEFORE:
            except Exception:
                logger.warning("MPS transfer failed for pyannote, falling back to CPU")

# AFTER:
            except RuntimeError:
                logger.warning("MPS transfer failed for pyannote, falling back to CPU")
```

Line 178 — Embedding model load failure:
```python
# BEFORE:
        except Exception:
            logger.warning("Failed to load embedding model, embeddings will be empty", exc_info=True)

# AFTER:
        except (ImportError, OSError, RuntimeError):
            logger.warning("Failed to load embedding model, embeddings will be empty", exc_info=True)
```

Line 328 — General diarization error. Read the full context first. This is a top-level catch for the `diarize()` method — keep as `Exception` but add `# noqa: BLE001` comment if not present, since this is intentionally broad for a top-level fault barrier.

**Step 2: Fix `whisper_batch.py`**

Line 172 — Transcription failure. Read context first. If this is a top-level fault barrier (catching any model error), keep as `Exception` with `# noqa: BLE001`. If it catches a specific operation, narrow it.

**Step 3: Fix `report_synthesizer.py`**

Line 1111 — Fallback report generation. This is intentionally broad (fallback for any LLM failure). Keep as `Exception` with explicit comment:
```python
        except Exception:  # noqa: BLE001 — intentional: fallback report must not crash
```

**Step 4: Fix `sv.py`**

Line 94 — CUDA transfer failure:
```python
# BEFORE:
        except Exception:

# AFTER:
        except RuntimeError:
```

**Step 5: Fix `asr.py`**

Line 160:
```python
# BEFORE:
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")

# AFTER:
        except (ValueError, TypeError, KeyError):
            raise HTTPException(status_code=400, detail="Invalid JSON body")
```

Line 166:
```python
# BEFORE:
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 in pcm_base64 field")

# AFTER:
        except (ValueError, binascii.Error):
            raise HTTPException(status_code=400, detail="Invalid base64 in pcm_base64 field")
```

Add `import binascii` at the top of `asr.py` if not present.

**Step 6: Run tests**

Run: `cd inference && python -m pytest tests/ -v`

**Step 7: Commit**

```bash
git add inference/app/services/diarize_full.py inference/app/services/whisper_batch.py inference/app/services/report_synthesizer.py inference/app/services/sv.py inference/app/routes/asr.py
git commit -m "fix: replace bare except Exception with specific exception types"
```

---

### Task 3: Add missing return type annotations to main.py

**Files:**
- Modify: `inference/app/main.py:92,167`

**Step 1: Fix `request_guard` signature**

Line 92:
```python
# BEFORE:
async def request_guard(request: Request, call_next):

# AFTER:
async def request_guard(request: Request, call_next: Callable) -> Response:
```

Add necessary imports at top if not present:
```python
from collections.abc import Callable
from starlette.responses import Response
```

**Step 2: Fix `health` endpoint return type**

Line 167 (approximate — the minimal health endpoint):
```python
# BEFORE:
async def health():

# AFTER:
async def health() -> dict[str, str]:
```

**Step 3: Run tests**

Run: `cd inference && python -m pytest tests/ -v`

**Step 4: Commit**

```bash
git add inference/app/main.py
git commit -m "fix: add missing return type annotations to main.py"
```

---

### Task 4: Extract magic numbers to named constants in Edge Worker

**Files:**
- Modify: `edge/worker/src/index.ts` (constants area ~line 643-656, and usage sites)

**Step 1: Add new constants after the existing constants block (~line 656)**

```typescript
// ── Reliability & timeout constants ──────────────────────────────────
const DASHSCOPE_TIMEOUT_CAP_MS = 15_000;
const DEFAULT_ASR_TIMEOUT_MS = 45_000;
const DRAIN_TIMEOUT_CAP_MS = 30_000;
const WS_CLOSE_REASON_MAX_LEN = 120;
const R2_LIST_LIMIT = 100;
const MAX_BACKOFF_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MS_PER_SECOND = 1000;
```

**Step 2: Replace hardcoded values throughout the file**

Search for each magic number and replace with the named constant:

- `Math.min(timeoutMs, 15_000)` → `Math.min(timeoutMs, DASHSCOPE_TIMEOUT_CAP_MS)` (lines ~3189, 3272, 3790)
- `Math.min(timeoutMs, 15000)` → `Math.min(timeoutMs, DASHSCOPE_TIMEOUT_CAP_MS)` (same pattern without underscore)
- `"45000"` default in env parsing → `String(DEFAULT_ASR_TIMEOUT_MS)` where appropriate
- `.slice(0, 120)` for WebSocket close reasons → `.slice(0, WS_CLOSE_REASON_MAX_LEN)` (lines ~3114, 6811)
- `100` in R2 list limit → `R2_LIST_LIMIT` (line ~1751)
- `60_000` backoff cap → `MAX_BACKOFF_MS` (line ~4266)

Do NOT replace `1000` (MS_PER_SECOND) everywhere — only replace where it's clearly a ms→s conversion, not where it's a sequence number or other meaning.

**Step 3: Run tests**

Run: `cd edge/worker && npx vitest run`

**Step 4: Commit**

```bash
git add edge/worker/src/index.ts
git commit -m "refactor: extract magic numbers to named constants in Edge Worker"
```

---

### Task 5: Add `getErrorMessage()` helper to Edge Worker

**Files:**
- Modify: `edge/worker/src/index.ts` (add helper function, replace ~30 casts)

**Step 1: Add helper function near the top utility functions area (~line 670)**

```typescript
/** Extract error message safely from unknown catch value. */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
```

**Step 2: Replace all `(error as Error).message` and `(err as Error).message` patterns**

Search for `(error as Error).message` and `(err as Error).message` patterns throughout the file. Replace each with `getErrorMessage(error)` or `getErrorMessage(err)` respectively.

Examples:
```typescript
// BEFORE:
console.error(`[context] failed: ${(err as Error).message}`);

// AFTER:
console.error(`[context] failed: ${getErrorMessage(err)}`);
```

```typescript
// BEFORE:
const message = (error as Error).message;

// AFTER:
const message = getErrorMessage(error);
```

There are ~30 instances to replace. Replace ALL of them — this is a mechanical search-and-replace.

**Step 3: Run tests**

Run: `cd edge/worker && npx vitest run`

**Step 4: Commit**

```bash
git add edge/worker/src/index.ts
git commit -m "refactor: add getErrorMessage() helper, replace 30 unsafe error casts"
```

---

### Task 6: Add `calcTranscriptDurationMs()` helper to Edge Worker

**Files:**
- Modify: `edge/worker/src/index.ts` (add helper, replace 3 duplicates)

**Step 1: Add helper function near other utility functions**

```typescript
/** Calculate total transcript duration from the last utterance's end_ms. */
function calcTranscriptDurationMs(transcript: Array<{ end_ms: number }>): number {
  return transcript.length > 0 ? Math.max(...transcript.map(u => u.end_ms)) : 0;
}
```

**Step 2: Replace duplicated patterns**

Find these 3 locations and replace:

Line ~4881:
```typescript
// BEFORE:
const audioDurationMs = transcript.length > 0 ? Math.max(...transcript.map(u => u.end_ms)) : 0;

// AFTER:
const audioDurationMs = calcTranscriptDurationMs(transcript);
```

Line ~5529 (similar pattern):
```typescript
// BEFORE:
const audioDurationMs = transcript.length > 0 ? Math.max(...transcript.map(u => u.end_ms)) : 0;

// AFTER:
const audioDurationMs = calcTranscriptDurationMs(transcript);
```

Line ~6341 (Tier 2):
```typescript
// BEFORE:
const tier2AudioDurationMs = finalTranscript.length > 0 ? Math.max(...finalTranscript.map(u => u.end_ms)) : 0;

// AFTER:
const tier2AudioDurationMs = calcTranscriptDurationMs(finalTranscript);
```

**Step 3: Run tests**

Run: `cd edge/worker && npx vitest run`

**Step 4: Commit**

```bash
git add edge/worker/src/index.ts
git commit -m "refactor: extract calcTranscriptDurationMs() helper, de-duplicate 3 sites"
```

---

### Task 7: Fix FootnoteList accessibility

**Files:**
- Modify: `desktop/src/components/ui/FootnoteList.tsx:20-24`

**Step 1: Add keyboard accessibility to the clickable div**

Replace lines 20-24:

```tsx
// BEFORE:
        <div
          key={e.index}
          className="flex gap-2 text-xs text-secondary cursor-pointer hover:text-ink transition-colors"
          onClick={() => onFootnoteClick?.(e.evidenceId)}
        >

// AFTER:
        <div
          key={e.index}
          role="button"
          tabIndex={0}
          className="flex gap-2 text-xs text-secondary cursor-pointer hover:text-ink transition-colors"
          onClick={() => onFootnoteClick?.(e.evidenceId)}
          onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onFootnoteClick?.(e.evidenceId); } }}
        >
```

**Step 2: Run tests**

Run: `cd desktop && npx vitest run`

**Step 3: Commit**

```bash
git add desktop/src/components/ui/FootnoteList.tsx
git commit -m "fix(a11y): add keyboard accessibility to FootnoteList items"
```

---

### Task 8: Replace TypeScript `any` in FeedbackView normalization functions

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx:229-460` (normalization functions area)

**Step 1: Define raw API types at the top of the normalization section**

Before the `normalizeApiReport` function, add interfaces for the raw API response shapes. These should be minimal — just enough to replace `any`:

```typescript
/** Raw shapes from inference API / localStorage — used only for normalization input. */
interface RawDimension {
  dimension?: string;
  label?: string;
  score?: number | string;
  claims?: RawClaim[];
}

interface RawClaim {
  claim?: string;
  evidence_ids?: string[];
  evidence?: string[];
  answer_quality?: string;
}

interface RawSpeaker {
  name?: string;
  display_name?: string;
}

interface RawPerson {
  display_name?: string;
  speaker_label?: string;
  dimensions?: RawDimension[];
  overall_score?: number | string;
  recommendation?: string;
  recommendation_confidence?: string;
}

interface RawEvidenceBullet {
  id?: string;
  evidence_id?: string;
  start_ms?: number;
  end_ms?: number;
  text?: string;
  speaker?: string;
  utterance_ids?: string[];
}

interface RawEvent {
  type?: string;
  text?: string;
  summary?: string;
  start_ms?: number;
  end_ms?: number;
  participants?: string[];
}

interface RawMemo {
  dimension?: string;
  label?: string;
  content?: string;
}

interface RawUtterance {
  id?: string;
  utterance_id?: string;
  speaker?: string;
  text?: string;
  start_ms?: number;
  end_ms?: number;
}

interface RawApiReport {
  speakers?: RawSpeaker[];
  per_person?: RawPerson[];
  evidence_bullets?: RawEvidenceBullet[];
  events?: RawEvent[];
  memos?: RawMemo[];
  transcript?: RawUtterance[];
  overall?: Record<string, unknown>;
  quality?: Record<string, unknown>;
  [key: string]: unknown;
}
```

**Step 2: Replace `any` parameters in normalization functions**

Replace each `(dim: any)` → `(dim: RawDimension)`, `(raw: any)` → `(raw: RawApiReport)`, `(s: any)` → `(s: RawSpeaker)`, etc. throughout the normalization functions (lines 229-460).

Key replacements:
- Line 229: `(dim: any)` → `(dim: RawDimension)`
- Line 259: `(raw: any, ...)` → `(raw: RawApiReport, ...)`
- Line 265: `(s: any)` → `(s: RawSpeaker)`
- Line 270: `(p: any)` → `(p: RawPerson)`
- Line 282: `(s: any)` → `(s: RawEvidenceBullet)`
- Line 299: `(s: any)` → `(s: RawEvent)`
- Line 311: `(m: any)` → `(m: RawMemo)`
- Line 346: `(s: any)` → `(s: RawEvidenceBullet)`
- Line 356: `(p: any)` → `(p: RawPerson)`
- Line 358: `(d: any)` → `(d: RawDimension)`
- Line 437: `(e: any)` → `(e: RawEvidenceBullet)`
- Line 452: `(u: any)` → `(u: RawUtterance)`

Also fix:
- Line 3625: `(status: any)` → `(status: Record<string, unknown>)` or define `interface FinalizeStatusResponse`
- Line 3998: `obj: any` → `obj: Record<string, unknown>`

**Step 3: Run tests and type check**

Run: `cd desktop && npx tsc --noEmit && npx vitest run`

**Step 4: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "refactor: replace TypeScript any with proper interfaces in FeedbackView"
```

---

### Task 9: Replace TypeScript `any` in HistoryView, useSessionOrchestrator, injectDemoSession

**Files:**
- Modify: `desktop/src/views/HistoryView.tsx:38,57`
- Modify: `desktop/src/hooks/useSessionOrchestrator.ts:18,24,25`
- Modify: `desktop/src/demo/injectDemoSession.ts:27,43,81,82,91,106`

**Step 1: Define `StoredSession` interface**

In a shared location (e.g., at the top of `HistoryView.tsx` or in a types file if one exists nearby), define:

```typescript
interface StoredSession {
  id: string;
  name: string;
  date?: string;
  mode?: string;
  participantCount?: number;
  participants?: string[];
  status?: string;
}
```

**Step 2: Replace `any` in HistoryView.tsx**

Line 38: `(s: any)` → `(s: StoredSession)`
Line 57: `(s: any)` → `(s: StoredSession)`

**Step 3: Replace `any` in useSessionOrchestrator.ts**

Line 18: `(s: any)` → `(s: StoredSession)`
Line 24: `(s: any)` → `(s: StoredSession)`
Line 25: `(s: any)` → `(s: StoredSession)`

Add the `StoredSession` interface import or define it locally.

**Step 4: Replace `any` in injectDemoSession.ts**

Lines 27, 43, 81, 82, 91, 106: Replace `as any` with `as StoredSession` or use proper typed variables. For demo data casting (`demoResultV2 as any`), use `as RawApiReport` or `as Record<string, unknown>` as appropriate.

**Step 5: Run tests and type check**

Run: `cd desktop && npx tsc --noEmit && npx vitest run`

**Step 6: Commit**

```bash
git add desktop/src/views/HistoryView.tsx desktop/src/hooks/useSessionOrchestrator.ts desktop/src/demo/injectDemoSession.ts
git commit -m "refactor: replace TypeScript any with StoredSession interface across desktop"
```

---

## Verification Checklist

```bash
# Inference
cd inference && python -m pytest tests/ -v

# Edge Worker
cd edge/worker && npx vitest run

# Desktop
cd desktop && npx tsc --noEmit && npx vitest run
```

## Summary

| Task | Severity | Component | Issue |
|------|----------|-----------|-------|
| 1 | MEDIUM | Inference | Duplicated `detect_device()` across 3 files |
| 2 | MEDIUM | Inference | Bare `except Exception:` in 8 locations |
| 3 | LOW | Inference | Missing return type annotations in main.py |
| 4 | MEDIUM | Edge Worker | 12+ magic numbers without named constants |
| 5 | MEDIUM | Edge Worker | 30 unsafe `(err as Error).message` casts |
| 6 | LOW | Edge Worker | Duplicated transcript duration calculation |
| 7 | LOW | Desktop | FootnoteList div lacks keyboard accessibility |
| 8 | MEDIUM | Desktop | 14 TypeScript `any` in FeedbackView normalization |
| 9 | MEDIUM | Desktop | 8 TypeScript `any` in HistoryView/orchestrator/demo |
