# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Interview Feedback (Chorus)** is a monorepo implementing a realtime interview recording and AI-powered feedback system with three main components:

1. **Inference Service** (`inference/`) — FastAPI backend for audio + AI processing
   - Audio normalization (16kHz/mono/PCM16) with ffmpeg timeout protection
   - Voice Activity Detection (VAD) segmentation
   - Speaker Verification (SV) embedding via ModelScope CAM++
   - Online clustering for speaker identification
   - Name extraction from transcripts (EN + ZH)
   - LLM-based report synthesis via DashScope (qwen-plus)
   - Event analysis (support cues, interruptions, decisions, summaries)
   - Diarization endpoint (reserved for Phase 2)

2. **Edge Gateway** (`edge/worker/`) — Cloudflare Worker + Durable Objects + R2
   - Realtime WebSocket audio ingest and chunking (dual-stream: teacher/students)
   - Automatic Speech Recognition (ASR) via Aliyun DashScope FunASR
   - Speaker resolution and enrollment with voice profile matching
   - Finalization pipeline v2 (9-stage: freeze → drain → replay → reconcile → stats → events → report → persist)
   - Session state management via Durable Objects
   - Result storage in R2 buckets
   - Auth middleware with timing-safe API key validation
   - Modular architecture: `auth.ts`, `audio-utils.ts`, `reconcile.ts`

3. **Desktop App** (`desktop/`) — Electron + React + Vite + TypeScript + Tailwind v4
   - Dual-stream audio capture (microphone + system audio via Web Audio API)
   - Zustand session store + service singletons (AudioService, WebSocketService, TimerService)
   - PiP overlay for background session monitoring
   - OAuth login (Microsoft Graph + Google Calendar) via MSAL Node + google-auth-library
   - 6 views: Home, Setup (3-step wizard), Sidecar (notes-first), Feedback (radar chart), History (date grouping), Settings
   - Rich text notes editor (TipTap), enrollment wizard, competency radar chart
   - Animation system (motion/react) with shared variants

## Key Architecture Patterns

### Audio Pipeline
- **Normalization**: All audio is strictly enforced as 16kHz/mono/pcm_s16le before processing
- **Streaming**: Dual WebSocket streams per session (`teacher` = microphone, `students` = system audio)
- **Chunking**: 1-second PCM chunks with sequence tracking for reliability
- **Echo Suppression**: Chunk-by-chunk correlation-based filtering for dual-stream scenarios
- **Bug A Fix**: `silentGain(0) → ctx.destination` ensures AnalyserNode processing in Chromium

### Desktop State Architecture
- **Zustand Store** (`src/stores/sessionStore.ts`): Single source of truth for session state
- **Service Singletons** (`src/services/`): AudioService, WebSocketService, TimerService — live outside React lifecycle
- **Orchestrator** (`src/hooks/useSessionOrchestrator.ts`): Coordinates start/end of services
- **PiP Overlay** (`src/components/PipOverlay.tsx`): Shows timer + audio levels when navigated away from session
- **HashRouter**: Required for Electron's `file://` protocol

### Failover & Reliability
- **Circuit Breaker Pattern** (Worker → Inference): Configurable timeout, retry, and backoff
- **Failover Routing**: Primary + secondary inference endpoints (wrangler.jsonc vars)
- **Stream Recovery**: Exponential backoff (1s → 2s → 5s) for network failures
- **State Durability**: Durable Objects persist session state across Worker restarts

### Security
- **Timing-safe auth**: `hmac.compare_digest()` for API key validation (inference), constant-time comparison (worker)
- **Error sanitization**: Internal errors logged server-side only, generic messages returned to clients
- **Rate limiting**: IP-based sliding window (inference)
- **ffmpeg timeout**: 30s subprocess timeout prevents DoS via crafted audio

### Configuration Management
- **Environment Files**: `.env`, `.env.example`, `.env.production` for different deployment tiers
- **Wrangler Vars**: Worker behavior (timeouts, model names, feature flags) in `wrangler.jsonc`
- **Wrangler Secrets**: `WORKER_API_KEY`, `ALIYUN_DASHSCOPE_API_KEY`, `INFERENCE_API_KEY` via `npx wrangler secret put`
- **Desktop .env**: `MS_GRAPH_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_ID` for OAuth

## Development Setup

### Inference Service
```bash
cd inference
cp .env.example .env        # or .env.production for production-like settings
docker compose up --build   # Starts FastAPI service + dependencies
curl http://localhost:8000/health  # Verify service is running
```

**Key Endpoints (13 total):**
- `GET /health` — Service health check with model info
- `POST /sv/extract_embedding` — Extract speaker embedding from audio chunk
- `POST /sv/score` — Score similarity between two audio samples
- `POST /speaker/resolve` — Resolve speaker identity for a window
- `POST /speaker/enroll` — Enroll speaker in session
- `POST /analysis/events` — Analyze transcript events (interruptions, support, decisions)
- `POST /analysis/report` — Generate feedback report (memo-first approach)
- `POST /analysis/synthesize` — LLM-based report synthesis with deep citations
- `POST /analysis/regenerate-claim` — Regenerate specific feedback claim

**Run Tests:**
```bash
cd inference
python -m pytest tests/ -v                    # All tests (95 tests)
python -m pytest tests/test_report_synthesizer.py -v  # Single file
```

### Edge Worker (Cloudflare)
```bash
cd edge/worker
npm install
npm run dev                 # Local development server (port 8787)
npm run typecheck          # TypeScript validation
npx vitest run             # Unit tests (59 tests)
npm run deploy             # Deploy to Cloudflare (requires auth)
```

**Key Files:**
- `src/index.ts` — Main request router, WebSocket handler, Durable Object class (~6000 lines)
- `src/auth.ts` — API key validation middleware (timing-safe)
- `src/audio-utils.ts` — PCM/WAV binary utilities, base64, ZIP, DOCX generation
- `src/reconcile.ts` — Transcript reconciliation, speaker binding resolution
- `src/types_v2.ts` — Type definitions for session state and events
- `src/inference_client.ts` — Failover-aware HTTP client to inference backend
- `src/finalize_v2.ts` — Report generation and event reconciliation logic
- `wrangler.jsonc` — Configuration (vars, secrets, bindings, routes)

### Desktop Application (Electron + React)
```bash
cd desktop
npm install
npm run dev                 # Start Electron app in dev mode (Electron + Vite)
npm run dev:react           # Vite dev server only (React hot reload)
npx tsc --noEmit            # TypeScript check
npx vite build              # Production build (~2086 modules)
npx vitest run              # Unit tests (63 tests)
```

**Architecture:**
```
src/
├── views/                 # 6 route views (Home, Setup, Sidecar, Feedback, History, Settings, Login)
├── components/            # 25 components (ui/, magicui/, PipOverlay, EnrollmentWizard, etc.)
├── hooks/                 # 12 hooks (useWebSocket, useAudioCapture, useSession, useExport, etc.)
├── services/              # 3 singletons (AudioService, WebSocketService, TimerService)
├── stores/                # Zustand session store
├── lib/                   # Utilities (animations, safeStorage, sanitize)
├── types/                 # desktop-api.d.ts (35+ IPC methods)
└── demo/                  # Demo data for development
```

**Key Design Tokens (globals.css @theme):**
- Background: `#F6F2EA` (warm neutral)
- Accent: `#0D6A63` (teal)
- Ink: `#1A2B33`, Secondary: `#566A77` (WCAG AA 4.5:1)
- Surface: `#FFFFFF`, Border: `#E0D9CE`

**Electron Main Process:**
- `main.js` — Window creation, IPC handlers, OAuth clients (MSAL + Google)
- `preload.js` — IPC bridge exposing 35+ methods via `window.desktopAPI`
- `lib/graphCalendar.js` — Microsoft Graph Calendar client (MSAL interactive flow)
- `lib/googleCalendar.js` — Google Calendar client (OAuth2 loopback flow)

## Testing & Validation

### Full Test Suite
```bash
# Desktop (React components)
cd desktop && npx vitest run              # 63 tests, ~2s

# Inference (Python)
cd inference && python -m pytest tests/ -v # 95 tests, ~0.8s

# Edge Worker (TypeScript)
cd edge/worker && npx vitest run          # 59 tests, ~0.3s

# Total: 217 tests
```

### Build Verification
```bash
cd desktop && npx tsc --noEmit && npx vite build  # TypeScript + production build
cd edge/worker && npm run typecheck                 # Worker TypeScript check
```

### Smoke Tests
```bash
python scripts/smoke_sv.py --base-url http://localhost:8000 --samples samples/
node scripts/ws_ingest_smoke.mjs --base-http http://127.0.0.1:8787 --base-ws ws://127.0.0.1:8787 --chunks 3
node scripts/quality_gate_regression.mjs
node scripts/eval_speaker_accuracy.mjs
```

## Important Files & Conventions

### API Contract
- Consult `docs/mvp/Inference_API_Contract.md` for complete inference endpoint spec
- Worker routes documented in `wrangler.jsonc` (routes array)
- Desktop WebSocket protocol defined in `edge/worker/src/types_v2.ts`

### Design Documents
- `docs/plans/2026-02-14-backend-intelligence-upgrade-plan.md` — LLM synthesis pipeline
- `docs/plans/2026-02-14-pip-background-session-design.md` — PiP + Zustand architecture
- `docs/plans/2026-02-15-production-readiness-plan.md` — Security + code quality + UI/UX
- `docs/plans/2026-02-15-ux-elevation-design.md` — Competitor analysis + UX specs

### Global Requirements
- Use **Neon** exclusively for database operations (no Firebase)
- Keep **OpenSpec** documentation synchronized with code changes
- Maintain separate `.env` files for dev/staging/production
- Use **Lucide React** for icons (no emojis as UI icons)
- Minimum text size: 12px (WCAG compliance)
- WCAG AA contrast ratios for all text

## Deployment

### Inference Service (Docker)
```bash
cd inference
docker build -t interview-feedback-inference .
docker run -p 8000:8000 --env-file .env interview-feedback-inference
```

### Edge Worker (Cloudflare)
```bash
cd edge/worker
npx wrangler secret put WORKER_API_KEY
npx wrangler secret put ALIYUN_DASHSCOPE_API_KEY
npx wrangler secret put INFERENCE_API_KEY
npm run deploy
```

### Desktop (Electron)
```bash
cd desktop
npm run build:react         # Build React app
npm run pack                # Package for current platform
npm run dist                # Build distributable
```

### OAuth Setup Required
- **Microsoft**: Azure App Registration with `User.Read`, `Calendars.Read`, `OnlineMeetings.ReadWrite` permissions
- **Google**: Google Cloud OAuth 2.0 Client ID (Desktop type) with Calendar API enabled

## Circuit Breaker Configuration

The Worker implements automatic failover via circuit breaker:
- **INFERENCE_FAILOVER_ENABLED**: Enable/disable automatic failover
- **INFERENCE_TIMEOUT_MS**: Request timeout (default 60000ms)
- **INFERENCE_RETRY_MAX**: Max retry attempts (default 2)
- **INFERENCE_RETRY_BACKOFF_MS**: Backoff between retries (default 180ms)
- **INFERENCE_CIRCUIT_OPEN_MS**: Circuit open duration (default 15000ms)

When primary endpoint times out/fails, Worker automatically routes to `INFERENCE_BASE_URL_SECONDARY`. Update these in `wrangler.jsonc` before deploy.
