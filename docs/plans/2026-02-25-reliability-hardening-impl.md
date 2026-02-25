# Reliability Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix HIGH reliability issues — thread safety, retry logic, thread pool sizing, error message sanitization, finalization timeout, and mutation queue error handling.

**Architecture:** Changes span Inference (Python) and Edge Worker (TypeScript). Each task is independent within its component. No new dependencies.

**Tech Stack:** Python/FastAPI, Cloudflare Workers/TypeScript/Durable Objects

**Batches:**
- Batch 1 (Tasks 1-3): Inference — thread safety, retry, thread pool
- Batch 2 (Tasks 4-6): Edge Worker — error sanitization, finalization timeout, mutation queue

---

### Task 1: Add threading lock to DashScope shared client

**Files:**
- Modify: `inference/app/services/dashscope_llm.py:13-22`

**Step 1: Add lock and fix `_get_shared_client`**

Replace lines 13-22:

```python
# BEFORE:
_shared_client: httpx.Client | None = None

def _get_shared_client(timeout: float) -> httpx.Client:
    global _shared_client
    if _shared_client is None or _shared_client.is_closed:
        _shared_client = httpx.Client(timeout=timeout)
    return _shared_client

# AFTER:
import threading

_shared_client: httpx.Client | None = None
_shared_client_lock = threading.Lock()

def _get_shared_client(timeout: float) -> httpx.Client:
    global _shared_client
    if _shared_client is not None and not _shared_client.is_closed:
        return _shared_client
    with _shared_client_lock:
        if _shared_client is None or _shared_client.is_closed:
            _shared_client = httpx.Client(timeout=timeout)
    return _shared_client
```

**Step 2: Run tests**

Run: `cd inference && python -m pytest tests/test_dashscope_llm.py -v`

**Step 3: Commit**

```bash
git add inference/app/services/dashscope_llm.py
git commit -m "fix(reliability): add threading lock to DashScope shared HTTP client"
```

---

### Task 2: Add retry with exponential backoff to LLM calls

**Files:**
- Modify: `inference/app/services/dashscope_llm.py:40-63`

**Step 1: Add retry logic around the HTTP POST**

In `generate_json`, wrap the POST + status check in a retry loop. Replace lines 53-63 (the `client.post` through the `raise ValidationError`):

```python
    timeout_seconds = max(self.timeout_ms, 1000) / 1000
    client = _get_shared_client(timeout_seconds)

    retryable_codes = {429, 502, 503}
    max_retries = 2
    last_status = 0
    last_body = ""

    for attempt in range(max_retries + 1):
        try:
            response = client.post(self.base_url, headers=self._headers(), json=payload)
        except httpx.TimeoutException:
            if attempt < max_retries:
                time.sleep(min(2 ** attempt * 0.5, 5.0))
                continue
            raise ValidationError("Report generation service timed out after retries")

        last_status = response.status_code
        last_body = response.text[:500]

        if response.status_code < 400:
            break

        if response.status_code in retryable_codes and attempt < max_retries:
            logger.warning(
                "dashscope %s retryable error: status=%s attempt=%d/%d",
                self.model_name, response.status_code, attempt + 1, max_retries + 1
            )
            time.sleep(min(2 ** attempt * 0.5, 5.0))
            continue

        # Non-retryable error or exhausted retries
        logger.error(
            "dashscope %s failed: status=%s body=%s prompt_len=sys:%d+user:%d",
            self.model_name, response.status_code, response.text[:500],
            len(system_prompt), len(user_prompt)
        )
        raise ValidationError(
            f"Report generation service temporarily unavailable (status={response.status_code})"
        )
```

Add `import time` at the top if not present.

**Step 2: Run tests**

Run: `cd inference && python -m pytest tests/test_dashscope_llm.py -v`

**Step 3: Commit**

```bash
git add inference/app/services/dashscope_llm.py
git commit -m "feat(reliability): add retry with exponential backoff to LLM calls"
```

---

### Task 3: Reduce thread pool from 64 to 8

**Files:**
- Modify: `inference/app/main.py:69`

**Step 1: Change max_workers**

```python
# BEFORE:
_thread_pool = concurrent.futures.ThreadPoolExecutor(max_workers=64)

# AFTER:
_thread_pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)
```

**Step 2: Run tests**

Run: `cd inference && python -m pytest tests/ -v`

**Step 3: Commit**

```bash
git add inference/app/main.py
git commit -m "perf: reduce thread pool from 64 to 8 for GPU workload safety"
```

---

### Task 4: Sanitize error messages in Edge Worker

**Files:**
- Modify: `edge/worker/src/index.ts` (multiple locations)

**Step 1: Find and fix all error message leaks**

Search for patterns that pass raw error messages to client responses. Key locations:

At the `/resolve` handler (~line 7927), change:
```typescript
// BEFORE:
return jsonResponse({ detail: `inference request failed: ${(error as Error).message}` }, 502);

// AFTER:
console.error(`inference resolve failed session=${sessionId}:`, error);
return jsonResponse({ detail: "Speaker resolution temporarily unavailable" }, 502);
```

Search for all similar patterns: `(error as Error).message` used in `jsonResponse` or `badRequest` calls. For each one:
- Log the full error with `console.error` (keeping internal details server-side)
- Return a generic user-facing message

Common patterns to fix:
- `badRequest((error as Error).message)` → log + generic message
- `jsonResponse({ detail: \`...\${(error as Error).message}\` })` → log + generic message

Do NOT change logging — only change what's returned to the client.

**Step 2: Run tests**

Run: `cd edge/worker && npx vitest run`

**Step 3: Commit**

```bash
git add edge/worker/src/index.ts
git commit -m "fix(security): sanitize error messages in Edge Worker responses"
```

---

### Task 5: Add global timeout to runFinalizeV2Job

**Files:**
- Modify: `edge/worker/src/index.ts` (~line 4723-4763)

**Step 1: Add AbortController with global timeout**

At the start of `runFinalizeV2Job`, after the variable declarations (~line 4733), add:

```typescript
    // Global timeout guard — abort all operations if finalization exceeds budget
    const globalTimeoutMs = this.finalizeTimeoutMs();
    const abortController = new AbortController();
    const globalTimer = setTimeout(() => {
      abortController.abort(new Error(`Finalization exceeded global timeout of ${globalTimeoutMs}ms`));
    }, globalTimeoutMs);
```

Before the main `try` block, and in the `finally` block of `runFinalizeV2Job`, add:

```typescript
    } finally {
      clearTimeout(globalTimer);
      // ... existing finally code
    }
```

Also add a periodic check inside the try block. After each major stage (freeze, drain, replay, reconcile, stats, events, report, persist), add:

```typescript
      if (abortController.signal.aborted) {
        throw new Error("Finalization aborted: global timeout exceeded");
      }
```

**Step 2: Run tests**

Run: `cd edge/worker && npx vitest run`

**Step 3: Commit**

```bash
git add edge/worker/src/index.ts
git commit -m "fix(reliability): add global timeout guard to runFinalizeV2Job"
```

---

### Task 6: Fix mutation queue error swallowing

**Files:**
- Modify: `edge/worker/src/index.ts` (~line 1765-1772)

**Step 1: Add error logging to enqueueMutation**

Replace the `enqueueMutation` method:

```typescript
// BEFORE:
private async enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = this.mutationQueue.then(fn);
  this.mutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// AFTER:
private async enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = this.mutationQueue.then(fn);
  this.mutationQueue = run.then(
    () => undefined,
    (err) => {
      console.error("enqueueMutation: queued operation failed:", err);
      return undefined;
    }
  );
  return run;
}
```

This preserves the queue-continuation behavior (preventing a broken chain) while ensuring errors are logged instead of silently swallowed.

**Step 2: Run tests**

Run: `cd edge/worker && npx vitest run`

**Step 3: Commit**

```bash
git add edge/worker/src/index.ts
git commit -m "fix(reliability): log errors in mutation queue instead of silent swallowing"
```

---

## Verification Checklist

```bash
# Inference
cd inference && python -m pytest tests/ -v

# Edge Worker
cd edge/worker && npx vitest run
```

## Summary

| Task | Severity | Component | Issue |
|------|----------|-----------|-------|
| 1 | HIGH | Inference | DashScope shared client thread safety |
| 2 | HIGH | Inference | LLM calls retry with exponential backoff |
| 3 | HIGH | Inference | Thread pool 64→8 for GPU safety |
| 4 | HIGH | Edge Worker | Error messages leak internal details |
| 5 | HIGH | Edge Worker | runFinalizeV2Job no global timeout |
| 6 | HIGH | Edge Worker | Mutation queue silently swallows errors |
