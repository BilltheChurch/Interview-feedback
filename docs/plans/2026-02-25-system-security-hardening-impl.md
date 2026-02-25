# System Security Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all CRITICAL + HIGH security vulnerabilities identified in the 2026-02-25 system-level code review — XSS, SSRF, secret leaks, timing attacks, and health endpoint over-exposure.

**Architecture:** Changes span all 3 components (Desktop, Inference, Edge Worker). No new dependencies except DOMPurify for Desktop. Each task is independent and can be parallelized by component.

**Tech Stack:** TypeScript/Electron, Python/FastAPI/Pydantic, Cloudflare Workers/TypeScript

**Batches:**
- Batch 1 (Tasks 1-4): CRITICAL — XSS, SSRF proxy, duplicate handler, error leak
- Batch 2 (Tasks 5-8): CRITICAL+HIGH — path traversal, SecretStr, timing-safe, DOMPurify
- Batch 3 (Tasks 9-11): HIGH — health endpoints, CSP hardening

---

### Task 1: Fix XSS in SidecarView (CRITICAL)

**Files:**
- Modify: `desktop/src/views/SidecarView.tsx:687`

**Step 1: Add sanitize import**

At the top of `SidecarView.tsx`, add alongside existing imports:

```ts
import { sanitizeHtml } from '../lib/sanitize';
```

**Step 2: Wrap dangerouslySetInnerHTML**

At line 687, change:

```tsx
// BEFORE:
dangerouslySetInnerHTML={{ __html: archive.freeformHtml }}

// AFTER:
dangerouslySetInnerHTML={{ __html: sanitizeHtml(archive.freeformHtml) }}
```

**Step 3: Verify build**

Run: `cd desktop && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add desktop/src/views/SidecarView.tsx
git commit -m "fix(security): sanitize dangerouslySetInnerHTML in SidecarView"
```

---

### Task 2: Add URL allowlist to `api:request` IPC handler (CRITICAL)

**Files:**
- Modify: `desktop/main.js:448-476`

**Step 1: Replace the api:request handler**

Replace lines 448-476 in `main.js`:

```js
  ipcMain.handle('api:request', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('api request payload is required');
    }

    const method = typeof payload.method === 'string' ? payload.method.toUpperCase() : 'GET';
    const url = typeof payload.url === 'string' ? payload.url : '';
    if (!url) {
      throw new Error('api request url is required');
    }

    // Security: validate URL against allowed base URLs to prevent SSRF
    const allowedBaseUrls = [
      process.env.WORKER_BASE_URL,
      process.env.WORKER_BASE_URL_SECONDARY,
      process.env.INFERENCE_BASE_URL,
    ].filter(Boolean);

    let urlAllowed = false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Blocked protocol: ${parsed.protocol}`);
      }
      // In dev mode (no allowed URLs configured), allow localhost
      if (allowedBaseUrls.length === 0) {
        urlAllowed = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      } else {
        urlAllowed = allowedBaseUrls.some(base => url.startsWith(base));
      }
    } catch (e) {
      throw new Error('api:request blocked: invalid URL');
    }
    if (!urlAllowed) {
      throw new Error('api:request blocked: URL not in allowlist');
    }

    const headers = payload.headers && typeof payload.headers === 'object' ? { ...payload.headers } : {};
    const apiKey = process.env.WORKER_API_KEY;
    if (apiKey && !headers['x-api-key']) {
      headers['x-api-key'] = apiKey;
    }
    const response = await fetch(url, {
      method,
      headers,
      body: payload.body === undefined ? undefined : payload.body
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text
    };
  });
```

**Step 2: Verify syntax**

Run: `cd desktop && node -c main.js`
Expected: No errors

**Step 3: Commit**

```bash
git add desktop/main.js
git commit -m "fix(security): add URL allowlist to api:request IPC to prevent SSRF"
```

---

### Task 3: Remove duplicate `export:printToPDF` handler (CRITICAL)

**Files:**
- Modify: `desktop/main.js:1002-1041`

**Step 1: Delete the first (insecure) handler**

Remove lines 1002-1041 entirely — the block starting with the first `ipcMain.handle('export:printToPDF'` that uses `data:text/html` URL and has `webPreferences: { offscreen: true }` only.

Keep the second handler (lines 1064-1116) which uses temp file + full security hardening (sandbox, contextIsolation, nodeIntegration: false).

**Step 2: Verify syntax**

Run: `cd desktop && node -c main.js`
Expected: No errors

**Step 3: Commit**

```bash
git add desktop/main.js
git commit -m "fix(security): remove duplicate insecure printToPDF handler"
```

---

### Task 4: Sanitize DashScope error messages (CRITICAL)

**Files:**
- Modify: `inference/app/services/dashscope_llm.py:55-63`

**Step 1: Change the error handling**

At lines 55-63, change:

```python
# BEFORE:
            logger.error(
                "dashscope %s failed: status=%s body=%s prompt_len=sys:%d+user:%d",
                self.model_name, response.status_code, response.text[:500],
                len(system_prompt), len(user_prompt)
            )
            raise ValidationError(
                f"dashscope report request failed: status={response.status_code} body={response.text[:500]}"
            )

# AFTER:
            logger.error(
                "dashscope %s failed: status=%s body=%s prompt_len=sys:%d+user:%d",
                self.model_name, response.status_code, response.text[:500],
                len(system_prompt), len(user_prompt)
            )
            raise ValidationError(
                f"Report generation service temporarily unavailable (status={response.status_code})"
            )
```

**Step 2: Run tests**

Run: `cd inference && python -m pytest tests/test_dashscope_llm.py -v`
Expected: All tests pass (update any test that checks for the old error message pattern)

**Step 3: Commit**

```bash
git add inference/app/services/dashscope_llm.py
git commit -m "fix(security): sanitize DashScope error messages to prevent info leakage"
```

---

### Task 5: Add path traversal protection to batch endpoint (CRITICAL)

**Files:**
- Modify: `inference/app/routes/batch.py:82-86`

**Step 1: Replace local path handling**

At lines 82-86 in `_resolve_audio`, change:

```python
# BEFORE:
    if not audio_url.startswith(("http://", "https://")):
        if not Path(audio_url).exists():
            raise HTTPException(status_code=400, detail=f"Local audio file not found: {audio_url}")
        return audio_url

# AFTER:
    if not audio_url.startswith(("http://", "https://")):
        # Security: restrict local paths to prevent path traversal
        local_path = Path(audio_url).resolve()
        allowed_dir = Path(os.environ.get("AUDIO_UPLOAD_DIR", "/tmp/audio")).resolve()
        if not local_path.is_relative_to(allowed_dir):
            raise HTTPException(status_code=400, detail="Local file path not in allowed directory")
        if not local_path.exists():
            raise HTTPException(status_code=400, detail="Local audio file not found")
        return str(local_path)
```

Also add `import os` at the top if not present.

**Step 2: Add SSRF protection for remote URLs**

At lines 95-106, add URL validation before the download:

```python
    # Security: block internal/private network SSRF
    try:
        from urllib.parse import urlparse
        parsed = urlparse(audio_url)
        if parsed.scheme not in ("http", "https"):
            raise HTTPException(status_code=400, detail="Only http/https URLs allowed")
        blocked_hosts = {"localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "[::1]"}
        if parsed.hostname and (parsed.hostname in blocked_hosts or parsed.hostname.startswith("10.") or parsed.hostname.startswith("192.168.") or parsed.hostname.startswith("172.")):
            raise HTTPException(status_code=400, detail="Internal URLs not allowed")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid audio URL")
```

**Step 3: Run tests**

Run: `cd inference && python -m pytest tests/ -v -k batch`
Expected: All tests pass

**Step 4: Commit**

```bash
git add inference/app/routes/batch.py
git commit -m "fix(security): add path traversal + SSRF protection to batch endpoint"
```

---

### Task 6: Use SecretStr for API keys in config (CRITICAL)

**Files:**
- Modify: `inference/app/config.py:17,35,67`
- Modify: `inference/app/services/dashscope_llm.py` (if it reads config directly)
- Modify: `inference/app/main.py` (auth comparison)

**Step 1: Update config.py**

Change the 3 secret fields:

```python
# Add import
from pydantic import SecretStr

# Line 17:
# BEFORE:
inference_api_key: str = Field(default="", alias="INFERENCE_API_KEY")
# AFTER:
inference_api_key: SecretStr = Field(default="", alias="INFERENCE_API_KEY")

# Line 35:
# BEFORE:
dashscope_api_key: str = Field(default="", alias="DASHSCOPE_API_KEY")
# AFTER:
dashscope_api_key: SecretStr = Field(default="", alias="DASHSCOPE_API_KEY")

# Line 67:
# BEFORE:
hf_token: str = Field(default="", alias="HF_TOKEN")
# AFTER:
hf_token: SecretStr = Field(default="", alias="HF_TOKEN")
```

**Step 2: Update all call sites to use `.get_secret_value()`**

Search for `settings.inference_api_key`, `settings.dashscope_api_key`, `settings.hf_token` across the codebase and add `.get_secret_value()`. Key locations:

- `main.py` auth check: `hmac.compare_digest(incoming, settings.inference_api_key.get_secret_value())`
- `runtime.py` DashScope client: `api_key=settings.dashscope_api_key.get_secret_value()`
- Any HF token usage: `settings.hf_token.get_secret_value()`

**Step 3: Update DashScope dataclass**

In `dashscope_llm.py`, mark api_key as `repr=False`:

```python
from dataclasses import dataclass, field

@dataclass(slots=True)
class DashScopeLLM:
    api_key: str = field(repr=False)
    # ... rest unchanged
```

**Step 4: Run tests**

Run: `cd inference && python -m pytest tests/ -v`
Expected: All 200 tests pass

**Step 5: Commit**

```bash
git add inference/app/config.py inference/app/main.py inference/app/services/dashscope_llm.py inference/app/runtime.py
git commit -m "fix(security): use SecretStr for API keys to prevent accidental logging"
```

---

### Task 7: Fix timing-safe comparison length leak (HIGH)

**Files:**
- Modify: `edge/worker/src/auth.ts:22-29`

**Step 1: Replace timingSafeEqual**

Replace lines 22-29:

```typescript
// BEFORE:
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// AFTER:
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}
```

**Step 2: Run tests**

Run: `cd edge/worker && npx vitest run`
Expected: All tests pass

**Step 3: Commit**

```bash
git add edge/worker/src/auth.ts
git commit -m "fix(security): prevent key length leak in timing-safe comparison"
```

---

### Task 8: Replace custom sanitizeHtml with DOMPurify (HIGH)

**Files:**
- Modify: `desktop/package.json` (add dependency)
- Modify: `desktop/src/lib/sanitize.ts:57-73`

**Step 1: Install DOMPurify**

Run: `cd desktop && npm install dompurify && npm install -D @types/dompurify`

**Step 2: Replace sanitizeHtml implementation**

In `desktop/src/lib/sanitize.ts`, replace lines 57-73:

```typescript
// BEFORE:
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'style']) {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  }
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || attr.value.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

// AFTER:
import DOMPurify from 'dompurify';

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}
```

Move the import to the top of the file.

**Step 3: Run tests**

Run: `cd desktop && npx vitest run src/lib/__tests__/sanitize.test.ts`
Expected: All 8 tests pass (DOMPurify handles all the same cases)

**Step 4: Run full test suite**

Run: `cd desktop && npx tsc --noEmit && npx vitest run`
Expected: 0 TS errors, all tests pass

**Step 5: Commit**

```bash
git add desktop/package.json desktop/package-lock.json desktop/src/lib/sanitize.ts
git commit -m "fix(security): replace custom sanitizeHtml with DOMPurify"
```

---

### Task 9: Minimize health endpoint exposure — Inference (HIGH)

**Files:**
- Modify: `inference/app/main.py:166-188`
- Modify: `inference/app/schemas.py` (HealthResponse model)

**Step 1: Create minimal health response**

Replace the health endpoint:

```python
@app.get("/health")
async def health():
    """Minimal health check — no auth required."""
    return {"status": "ok", "app_name": settings.app_name}
```

**Step 2: Add authenticated diagnostics endpoint**

Add a new endpoint after the health check (inside the auth-protected section):

```python
@app.get("/health/detailed", response_model=HealthResponse)
async def health_detailed() -> HealthResponse:
    """Detailed health info — requires auth."""
    sv_health = runtime.sv_backend.health()
    return HealthResponse(
        app_name=settings.app_name,
        model_id=sv_health.model_id,
        model_revision=sv_health.model_revision,
        embedding_dim=sv_health.embedding_dim,
        sv_t_low=settings.sv_t_low,
        sv_t_high=settings.sv_t_high,
        max_request_body_bytes=settings.max_request_body_bytes,
        rate_limit_enabled=settings.rate_limit_enabled,
        rate_limit_requests=settings.rate_limit_requests,
        rate_limit_window_seconds=settings.rate_limit_window_seconds,
        segmenter_backend=settings.segmenter_backend,
        diarization_enabled=settings.enable_diarization,
        devices=DeviceInfo(
            sv_device=sv_health.device,
            whisper_device=settings.whisper_device,
            pyannote_device=settings.pyannote_device,
            whisper_model_size=settings.whisper_model_size,
        ),
    )
```

Ensure `/health/detailed` is placed AFTER the auth middleware check (not excluded from auth).

**Step 3: Run tests**

Run: `cd inference && python -m pytest tests/ -v`
Expected: All tests pass (update any test that hits `/health` to expect the minimal response)

**Step 4: Commit**

```bash
git add inference/app/main.py inference/app/schemas.py
git commit -m "fix(security): minimize unauthenticated health endpoint exposure"
```

---

### Task 10: Minimize health endpoint exposure — Edge Worker (HIGH)

**Files:**
- Modify: `edge/worker/src/index.ts:1389-1409`

**Step 1: Replace health endpoint response**

Replace lines 1389-1409:

```typescript
// BEFORE:
    if (path === "/health" && request.method === "GET") {
      const asrProvider = ...
      return jsonResponse({
        status: "ok",
        app: "interview-feedback-gateway",
        durable_object: "MEETING_SESSION",
        r2_bucket: "RESULT_BUCKET",
        asr_enabled: asrEnabled,
        asr_realtime_enabled: asrRealtimeEnabled,
        asr_mode: ...,
        asr_model: ...,
        // ... many internal details
      });
    }

// AFTER:
    if (path === "/health" && request.method === "GET") {
      return jsonResponse({ status: "ok", app: "interview-feedback-gateway" });
    }
```

**Step 2: Run tests**

Run: `cd edge/worker && npx vitest run`
Expected: All tests pass (update any test that checks health response fields)

**Step 3: Commit**

```bash
git add edge/worker/src/index.ts
git commit -m "fix(security): minimize unauthenticated health endpoint exposure"
```

---

### Task 11: Conditional CSP — remove unsafe-eval in production (HIGH)

**Files:**
- Modify: `desktop/main.js:1145-1154`

**Step 1: Make CSP conditional**

Find the CSP setup (around line 1145-1154) and make `unsafe-eval` conditional:

```js
// Replace the script-src portion
const scriptSrc = app.isPackaged
  ? "script-src 'self'"
  : "script-src 'self' 'unsafe-eval'";
```

Use `scriptSrc` in the CSP header string.

**Step 2: Verify syntax**

Run: `cd desktop && node -c main.js`
Expected: No errors

**Step 3: Commit**

```bash
git add desktop/main.js
git commit -m "fix(security): remove unsafe-eval from CSP in production builds"
```

---

## Verification Checklist

After all tasks complete, run full verification:

```bash
# Desktop
cd desktop && npx tsc --noEmit && npx vitest run

# Inference
cd inference && python -m pytest tests/ -v

# Edge Worker
cd edge/worker && npx vitest run

# Desktop build
cd desktop && npx vite build
```

Expected: 0 TS errors, all tests pass, build succeeds.

## Summary

| Task | Severity | Component | Issue |
|------|----------|-----------|-------|
| 1 | CRITICAL | Desktop | SidecarView XSS — add `sanitizeHtml()` |
| 2 | CRITICAL | Desktop | `api:request` SSRF — add URL allowlist |
| 3 | CRITICAL | Desktop | Duplicate `printToPDF` — remove insecure handler |
| 4 | CRITICAL | Inference | DashScope error leak — sanitize error messages |
| 5 | CRITICAL | Inference | Batch path traversal + SSRF — add validation |
| 6 | CRITICAL | Inference | API keys in logs — use `SecretStr` |
| 7 | HIGH | Edge Worker | `timingSafeEqual` length leak — fix comparison |
| 8 | HIGH | Desktop | Custom sanitizer bypass — use DOMPurify |
| 9 | HIGH | Inference | Health endpoint info leak — minimize response |
| 10 | HIGH | Edge Worker | Health endpoint info leak — minimize response |
| 11 | HIGH | Desktop | CSP `unsafe-eval` in prod — make conditional |
