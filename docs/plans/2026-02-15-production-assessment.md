# Chorus Production Assessment & Optimization Plan

**Date:** 2026-02-15
**Status:** Active — Phase A & B in progress

---

## Executive Summary

Full-stack audit (22 files, ~1900 lines changed) + competitive intelligence (Granola, BrightHire, Metaview, Pillar, HireVue, Screenloop, Otter, Fireflies) revealed **6 critical security issues**, **10 important reliability issues**, and significant competitive gaps. Chorus has unique technical advantages (bot-free + real speaker verification) but needs security hardening, reliability fixes, and strategic positioning before production.

---

## 1. Production Readiness — Critical Security Issues (MUST FIX)

| ID | Issue | File | Fix |
|----|-------|------|-----|
| MF-1 | API key baked into client JS bundle via `VITE_WORKER_API_KEY`, sent as WS query parameter | `desktop/src/services/WebSocketService.ts:38` | Load key from main process via IPC instead of VITE_ env var. Remove from client bundle. |
| MF-2 | `system:openExternalUrl` IPC opens ANY URL (file://, javascript:, custom protocols) | `desktop/main.js:882` | Whitelist `https://` and `http://` schemes only |
| MF-3 | Deep link participant data parsed from base64 without schema validation | `desktop/main.js:55` | Add JSON schema validation, URL whitelist, name length/charset limits |
| MF-4 | timing-safe comparison leaks key length via early return on `a.length !== b.length` | `edge/worker/src/auth.ts:22` | Use HMAC comparison (hash both values → fixed-length comparison) |
| MF-5 | `sandbox: false` in BrowserWindow weakens Chromium security | `desktop/main.js:264` | Set `sandbox: true`, verify all IPC methods work |
| MF-6 | No Content Security Policy for renderer process | `desktop/main.js` | Add CSP via `session.defaultSession.webRequest.onHeadersReceived` |

## 2. Reliability Issues (SHOULD FIX before launch)

| ID | Issue | File | Fix |
|----|-------|------|-----|
| SF-1 | Audio chunk queue grows unbounded when WS is disconnected | `desktop/src/services/AudioService.ts` | Add `MAX_QUEUE_CHUNKS = 30`, drop oldest when exceeded |
| SF-2 | Double-finalization race: orchestrator setTimeout + FeedbackView retry can both call finalizeV2 | `useSessionOrchestrator.ts:80` + `FeedbackView.tsx:2430` | Add `finalizeRequested` flag to sessionStore, check atomically |
| SF-3 | OAuth tokens stored as plaintext JSON on filesystem | `lib/graphCalendar.js:88`, `lib/googleCalendar.js:47` | Use `safeStorage.encryptString()` for OS keychain storage |
| SF-4 | WebSocket reconnects infinitely (every 5s, no max attempts) | `WebSocketService.ts:163` | Add `MAX_RECONNECT_ATTEMPTS = 20`, set status to 'failed' after |
| SF-5 | No message size limit on WebSocket ingestion in Durable Object | `edge/worker/src/index.ts` | Enforce 256KB max, close oversized connections with code 1009 |
| SF-6 | localStorage session data accumulates with no TTL or cleanup | `useSessionOrchestrator.ts:73` | Add 30-day TTL cleanup on app startup |
| SF-7 | Force finalization timer uses raw setTimeout in DO (lost on eviction) | `index.ts scheduleForceFinalization()` | Migrate to `this.ctx.storage.setAlarm()` for guaranteed delivery |
| SF-8 | Polling useEffect re-triggers on finalizeStatus change, resetting timeout | `FeedbackView.tsx:~2390` | Move `pollStartedAt` to useRef |
| SF-9 | `VITE_WORKER_API_KEY` not declared in TypeScript env types | `desktop/src/vite-env.d.ts` | Add to ImportMetaEnv interface |
| SF-10 | Mock enrollment logic (random confidence, setTimeout) in production code | `SidecarView.tsx:964` | Replace with real enrollment WebSocket flow |

## 3. Competitive Position

### Our Unique Advantages
1. **Bot-free + real speaker diarization** — Only product with local capture AND per-speaker voice verification (CAM++ embeddings + online clustering)
2. **Audio retention** — Granola discards audio post-transcription; we store in R2 for re-processing
3. **In-person/hybrid support** — Works for face-to-face, phone, any meeting platform
4. **Bilingual EN + ZH** — Most competitors English-only

### Critical Competitive Gaps
1. **No ATS integration** — BrightHire's Greenhouse auto-fill is their #1 feature
2. **No interviewer coaching** — Competitors have talk-time ratio, bias detection, question analysis
3. **No compliance certifications** — SOC 2 is table stakes for enterprise
4. **Single ASR provider** (DashScope FunASR) — Granola uses Deepgram + AssemblyAI
5. **Single LLM provider** (qwen-plus) — Granola routes across GPT-4o + Claude + Google

### Competitor Summary

| Product | Capture Method | Speaker ID | LLM | Funding | Key Strength |
|---------|---------------|------------|-----|---------|-------------|
| **Granola** | Local (native Swift) | Me/Them only | GPT-4o+Claude+Google | $67M | Native UX, no-bot, Recipes ecosystem |
| **BrightHire** | Bot (Recall.ai) | Per-speaker streams | Custom | Acquired by Zoom | Greenhouse auto-fill, 3M+ interviews |
| **Metaview** | Bot | Meeting metadata | Multi-source (resume+JD) | $35M Series B | Question-organized notes, AI Filters |
| **Pillar** | Bot | Meeting metadata | Custom | Acquired by Employ | Real-time interviewer coaching |
| **Fireflies** | Bot | AI diarization | ChatGPT-based | $1B unicorn | 100+ languages, voice assistant |

### Market Positioning

**Target**: Privacy-first interview intelligence for teams using mixed formats (video, phone, in-person)
**Customer**: Mid-market companies (100-2000 employees), bilingual environments
**Do NOT**: Compete head-to-head with BrightHire on enterprise ATS or Granola on general meeting notes

## 4. Architecture Comparison

| Dimension | Chorus | Granola | BrightHire |
|-----------|--------|---------|------------|
| Audio capture | Electron dual-stream (Web Audio API) | Native dual-stream (ScreenCaptureKit) | Bot per-speaker streams (Recall.ai) |
| Echo cancellation | Chunk correlation-based | Proprietary on-device | N/A (separate streams) |
| ASR | DashScope FunASR (single) | Deepgram + AssemblyAI (dual) | Undisclosed |
| Speaker diarization | CAM++ SV + online clustering | None on desktop | Meeting platform metadata |
| LLM synthesis | qwen-plus (single) | GPT-4o + Claude + Google (routed) | Custom (3M+ interview dataset) |
| Desktop framework | Electron + React | Native Swift | Web-only |
| Storage | Cloudflare R2 | None (discarded) | Cloud archive |
| Compliance | None | SOC 2 Type 2 | SOC 2 Type II |

## 5. Roadmap

### Phase A: Production Blockers (3-5 days)
- 6 security fixes (MF-1 through MF-6)
- Audio queue limit + WS reconnect cap
- Finalization race condition fix

### Phase B: Launch Readiness (8-12 days)
- OAuth encryption, mock enrollment replacement
- Recording consent, data retention policy
- Structured logging + request tracing

### Phase C: Competitive Advantage (Q2-Q4 2026)

| Timeline | Goals |
|----------|-------|
| Q2 | Multi-ASR (Deepgram) + Multi-LLM (Claude/GPT-4o) + DO decomposition |
| Q3 | Greenhouse ATS integration + interviewer coaching + team collaboration |
| Q4 | SOC 2 certification + Recipe ecosystem + MCP integration |

### Technology Stack Recommendations

| Area | Current | Recommended |
|------|---------|-------------|
| ASR | DashScope FunASR only | Add **Deepgram** for English, keep FunASR for Chinese |
| LLM | qwen-plus only | Add **Claude** or **GPT-4o** with evaluation-based routing |
| Audio | ScriptProcessorNode (deprecated) | Migrate to **AudioWorkletNode** |
| Token storage | Plaintext JSON | **Electron safeStorage** (OS keychain) |
| Desktop | Electron (keep for now) | Evaluate native Swift after product-market fit |

---

## Appendix: Report Sources

- Code Review: 22 files, ~1914 lines (3 Critical, 7 Important, 5 Suggestions)
- Pipeline Analysis: Full 3-component architecture review (5 Critical, 8 Important, 5 Minor, 5 Architectural)
- Granola Intelligence: Product architecture, ASR pipeline, LLM approach, pricing, limitations
- BrightHire + 7 Competitors: Architecture, pricing, strengths/weaknesses, market consolidation trends
