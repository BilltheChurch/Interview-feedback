# PiP + Background Session & Audio Fixes Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable interview sessions to run in the background when users navigate away, showing a draggable PiP overlay with real-time session status. Also fix two critical audio bugs in the current implementation.

**Architecture:** Zustand Store + Service Singletons. All session state (audio, WebSocket, timer, memos, stage) is lifted out of component lifecycle into module-level singletons and a Zustand store. React components become thin consumers via selector hooks.

**Tech Stack:** React 18, Zustand, TypeScript, Tailwind v4, Electron 31, Web Audio API

---

## Part 1: Audio Bug Fixes

### Bug A — Mic Level Meters Not Responding

**Symptom:** Settings → Audio Setup shows microphone as ready (✓), Audio Monitor shows "Live", but all three meter bars (Mic/System/Mixed) remain at 0% when speaking.

**Root Cause:** The `AnalyserNode` audio graph in `useAudioCapture.ts` is **disconnected from `AudioContext.destination`**. Chromium's audio rendering thread only processes nodes that have a path to the `AudioDestinationNode`. The current graph:

```
micSource → micAnalyser       (dead end — not connected to destination)
micSource → mixGain → mixedAnalyser  (dead end — not connected to destination)
```

Since no node reaches `ctx.destination`, the rendering thread skips the entire branch. `getFloatTimeDomainData()` returns a buffer of zeros.

**Fix:** Add a zero-gain "silent output" node that connects the graph to destination without producing audible output:

```typescript
// In ensureAudioGraph():
const silentGain = ctx.createGain();
silentGain.gain.value = 0;
mixedAnalyser.connect(silentGain);
silentGain.connect(ctx.destination);
```

This ensures the rendering thread processes all upstream nodes (micAnalyser, systemAnalyser, mixedAnalyser) while outputting silence.

**Secondary Fix:** Add Electron autoplay policy to guarantee `AudioContext.resume()` works without user gesture:

```javascript
// In main.js BrowserWindow webPreferences:
webPreferences: {
  autoplayPolicy: 'no-user-gesture-required',
  // ... existing preferences
}
```

**Files to modify:**
- `desktop/src/hooks/useAudioCapture.ts` — line ~88: add silentGain connection
- `desktop/main.js` — webPreferences: add autoplayPolicy

### Bug B — System Audio Shows "—" in Settings

**Symptom:** Settings → Audio Setup shows System Audio with "—" indicator instead of checkmark.

**Root Cause:** The `AudioSetup` component in `SettingsView.tsx` only calls `initMic()` + `startCapture()`. It never calls `initSystem()`. This is because `initSystem()` uses `navigator.mediaDevices.getDisplayMedia()` which triggers a screen/window picker dialog — inappropriate for auto-initialization in a settings page.

**Fix:** Change the System Audio indicator in Settings to show informational status instead of a broken-looking "—":
- When `!systemReady` in Settings: show text "Session only" or "Available during recording"
- System audio should only auto-initialize during active sessions (SidecarView), not in Settings
- The Settings page is for microphone testing only, consistent with Zoom/Teams behavior

**Files to modify:**
- `desktop/src/views/SettingsView.tsx` — AudioSetup component, system audio indicator section

---

## Part 2: PiP + Background Session Architecture

### Design Decisions

| Decision | Choice |
|----------|--------|
| PiP content | Timer + audio meters + current stage |
| PiP implementation | React floating overlay (same Electron window) |
| Background behavior | Full background running (audio, WS, timer all continue) |
| PiP interaction | Draggable + click to return to session |
| State management | Zustand store + service singletons |

### Architecture Overview

```
SetupView ──→ orchestrator.start(config) ──→ AudioService.initMic()
                                            AudioService.initSystem()
                                            AudioService.startCapture()
                                            WsService.connect()
                                            TimerService.start()
                                                 │
              ┌──────── Zustand Store ◄──────────┘
              │    (single source of truth)
              │         │            │
              ▼         ▼            ▼
         SidecarView  PipOverlay  FeedbackView
         (full UI)   (mini panel) (reads memos)
              │
              ▼
    orchestrator.end() ──→ TimerService.stop()
                          WsService.disconnect()
                          AudioService.destroy()
                          store.reset()
                          navigate(/feedback/:id)
```

### Component 1: Zustand Session Store

**File:** `desktop/src/stores/sessionStore.ts`

Single store for all session state. Components subscribe to slices for minimal re-renders.

```typescript
import { create } from 'zustand';

interface SessionStore {
  // ── Session metadata ──
  sessionId: string | null;
  sessionName: string;
  mode: '1v1' | 'group';
  status: 'idle' | 'setup' | 'recording' | 'feedback_draft' | 'feedback_final';
  participants: Participant[];
  stages: string[];
  currentStage: number;
  startedAt: number | null;
  baseApiUrl: string;

  // ── Timer ──
  elapsedSeconds: number;

  // ── Audio levels ──
  audioLevels: { mic: number; system: number; mixed: number };
  micReady: boolean;
  systemReady: boolean;
  isCapturing: boolean;
  audioError: string | null;

  // ── WebSocket ──
  wsStatus: { teacher: WebSocketStatus; students: WebSocketStatus };
  wsError: string | null;
  wsConnected: boolean;

  // ── Memos & Notes ──
  memos: Memo[];
  notes: string;

  // ── Actions ──
  startSession: (config: SessionConfig) => void;
  endSession: () => void;
  addMemo: (type: MemoType, text: string) => void;
  advanceStage: () => void;
  setNotes: (html: string) => void;
  tick: () => void;
  setAudioLevels: (levels: AudioLevels) => void;
  setAudioReady: (device: 'mic' | 'system', ready: boolean) => void;
  setAudioError: (error: string | null) => void;
  setIsCapturing: (capturing: boolean) => void;
  setWsStatus: (role: StreamRole, status: WebSocketStatus) => void;
  setWsError: (error: string | null) => void;
  reset: () => void;
}
```

**Key design principle:** Services call `useSessionStore.getState().setAudioLevels(...)` directly (no React). Components use `useSessionStore(s => s.audioLevels)` for selective subscriptions.

### Component 2: AudioService Singleton

**File:** `desktop/src/services/AudioService.ts`

Extracts audio logic from `useAudioCapture.ts` into a class that lives outside React lifecycle.

```typescript
class AudioService {
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private systemStream: MediaStream | null = null;
  private displayStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private systemAnalyser: AnalyserNode | null = null;
  private mixedAnalyser: AnalyserNode | null = null;
  private mixGain: GainNode | null = null;
  private silentGain: GainNode | null = null;  // ← fixes Bug A
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  ensureAudioGraph(): AudioContext { ... }
  async initMic(): Promise<void> { ... }
  async initSystem(): Promise<void> { ... }
  startCapture(): void { ... }          // starts RMS polling → pushes to store
  stopCapture(): void { ... }
  destroy(): void { ... }               // stops tracks, closes AudioContext
}

export const audioService = new AudioService();
```

**Important:** The `ensureAudioGraph()` method includes the Bug A fix — connects `mixedAnalyser → silentGain(0) → ctx.destination`.

### Component 3: WebSocketService Singleton

**File:** `desktop/src/services/WebSocketService.ts`

Extracts WebSocket logic from `useWebSocket.ts` into a class.

```typescript
class WebSocketService {
  private sockets: Record<StreamRole, WebSocket | null> = { teacher: null, students: null };
  private ready: Record<StreamRole, boolean> = { teacher: false, students: false };
  private reconnectAttempts: Record<StreamRole, number> = { teacher: 0, students: 0 };
  private reconnectTimers: Record<StreamRole, ReturnType<typeof setTimeout> | null> = { teacher: null, students: null };
  private closing: Record<StreamRole, boolean> = { teacher: false, students: false };

  async connect(opts: WsConnectOptions): Promise<void> { ... }
  disconnect(reason?: string): void { ... }
  sendAudioChunk(role: StreamRole, chunk: ArrayBuffer, seq: number): void { ... }
  sendMark(role: StreamRole, mark: Record<string, unknown>): void { ... }
  sendEnrollment(role: StreamRole, data: Record<string, unknown>): void { ... }
  destroy(): void { ... }
}

export const wsService = new WebSocketService();
```

### Component 4: TimerService Singleton

**File:** `desktop/src/services/TimerService.ts`

Simple interval timer that pushes to store.

```typescript
class TimerService {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      useSessionStore.getState().tick();
    }, 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  reset(): void {
    this.stop();
  }
}

export const timerService = new TimerService();
```

### Component 5: Session Orchestrator Hook

**File:** `desktop/src/hooks/useSessionOrchestrator.ts`

Coordinates service lifecycle. Used by SetupView and SidecarView.

```typescript
export function useSessionOrchestrator() {
  const navigate = useNavigate();

  const start = async (config: SessionConfig) => {
    const store = useSessionStore.getState();
    store.startSession(config);

    await audioService.initMic();
    try { await audioService.initSystem(); } catch { /* non-fatal */ }
    audioService.startCapture();

    await wsService.connect({
      baseWsUrl: config.baseApiUrl.replace('http', 'ws'),
      sessionId: config.sessionId,
      interviewerName: config.interviewerName,
      participants: config.participants,
    });

    timerService.start();
  };

  const end = () => {
    const store = useSessionStore.getState();
    const sessionId = store.sessionId;

    timerService.stop();
    wsService.disconnect();
    audioService.stopCapture();

    store.endSession();
    navigate(`/feedback/${sessionId}`);

    // Defer full cleanup
    setTimeout(() => {
      audioService.destroy();
      useSessionStore.getState().reset();
    }, 100);
  };

  return { start, end };
}
```

### Component 6: PiP Overlay

**File:** `desktop/src/components/PipOverlay.tsx`

Floating draggable overlay that shows when session is active and user is not on `/session` route.

**Visibility logic:**
```typescript
const status = useSessionStore(s => s.status);
const location = useLocation();
const visible = status === 'recording' && location.pathname !== '/session';
```

**Layout (240×120px, glassmorphic):**
```
┌──────────────────────────────┐
│  ● Recording   00:12:34      │  ← StatusDot + timer
│  ▓▓▓▓▓▓░░░  Mic              │  ← audio meter bar
│  ▓▓▓░░░░░░  System           │  ← audio meter bar
│  Stage: Q2                   │  ← current stage name
└──────────────────────────────┘
```

**Styling:**
- `bg-surface/90 backdrop-blur-md border border-border shadow-lg rounded-2xl`
- Position: `fixed z-50`, default bottom-right with 16px inset
- Draggable via pointer events (mousedown → track offset → mousemove → update position)
- Cursor: `cursor-grab` (default), `cursor-grabbing` (while dragging)
- Click (non-drag) navigates to `/session` via `useNavigate()`
- Enter/exit animation via `motion/react` (scale + opacity)

**Placement in App.tsx:**
```tsx
<HashRouter>
  <AppShell>
    <AppRoutes />
  </AppShell>
  <PipOverlay />   {/* sibling to AppShell, reads from Zustand store */}
</HashRouter>
```

### Component 7: SidecarView Refactor

**File:** `desktop/src/views/SidecarView.tsx`

Becomes a thin view that consumes the Zustand store instead of managing local state.

**Before (local state):**
```typescript
const [sessionTimer, setSessionTimer] = useState(0);
const [memos, setMemos] = useState<Memo[]>([]);
const [currentStage, setCurrentStage] = useState(0);
const { levels, initMic, initSystem, startCapture, stopCapture } = useAudioCapture();
```

**After (store selectors):**
```typescript
const sessionTimer = useSessionStore(s => s.elapsedSeconds);
const memos = useSessionStore(s => s.memos);
const currentStage = useSessionStore(s => s.currentStage);
const audioLevels = useSessionStore(s => s.audioLevels);
const addMemo = useSessionStore(s => s.addMemo);
const advanceStage = useSessionStore(s => s.advanceStage);
const { end } = useSessionOrchestrator();
```

**Key change:** SidecarView no longer calls `initMic()`, `initSystem()`, or manages a session timer interval. These are all handled by the services started via the orchestrator. Unmounting SidecarView (navigating away) no longer kills the session.

### Component 8: useAudioCapture (retained for Settings)

**File:** `desktop/src/hooks/useAudioCapture.ts`

Keep the existing hook for SettingsView's audio testing. Apply Bug A fix (silentGain connection) so the mic meter works. This hook is independent of the Zustand session store — it's a standalone audio test utility for the Settings page only.

---

## File Changes Summary

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/stores/sessionStore.ts` | Zustand session store |
| Create | `src/services/AudioService.ts` | Audio capture singleton |
| Create | `src/services/WebSocketService.ts` | WebSocket singleton |
| Create | `src/services/TimerService.ts` | Timer singleton |
| Create | `src/components/PipOverlay.tsx` | PiP floating overlay |
| Create | `src/hooks/useSessionOrchestrator.ts` | Service coordinator hook |
| Modify | `src/hooks/useAudioCapture.ts` | Bug A fix: add silentGain → destination |
| Modify | `src/views/SettingsView.tsx` | Bug B fix: system audio status text |
| Modify | `src/views/SidecarView.tsx` | Refactor to consume Zustand store |
| Modify | `src/views/SetupView.tsx` | Use orchestrator.start() |
| Modify | `src/App.tsx` | Add PipOverlay component |
| Modify | `src/hooks/index.ts` | Export new hook |
| Modify | `desktop/main.js` | Add autoplayPolicy to webPreferences |
| Install | `zustand` | State management (~1KB) |

**Total:** 6 new files, 7 modified, 1 new dependency

---

## Implementation Tasks

### Task 1: Fix Audio Bugs
1. Fix `useAudioCapture.ts` — add `silentGain(0) → ctx.destination` in `ensureAudioGraph()`
2. Fix `main.js` — add `autoplayPolicy: 'no-user-gesture-required'` to webPreferences
3. Fix `SettingsView.tsx` — change system audio indicator to "Session only" text
4. Verify: restart Electron, go to Settings, confirm mic levels respond to speech

### Task 2: Install Zustand & Create Store
1. `npm install zustand`
2. Create `src/stores/sessionStore.ts` with full store shape and actions
3. Export types for Memo, Participant, SessionConfig, etc.

### Task 3: Create Service Singletons
1. Create `src/services/AudioService.ts` — extract from `useAudioCapture.ts`, include silentGain fix
2. Create `src/services/WebSocketService.ts` — extract from `useWebSocket.ts`
3. Create `src/services/TimerService.ts` — simple interval service
4. All services push state to Zustand store via `getState()`

### Task 4: Create Session Orchestrator
1. Create `src/hooks/useSessionOrchestrator.ts`
2. `start()`: init audio → connect WS → start timer
3. `end()`: stop timer → disconnect WS → stop audio → navigate to feedback → reset store

### Task 5: Create PiP Overlay
1. Create `src/components/PipOverlay.tsx`
2. Implement draggable behavior with pointer events
3. Show timer + audio meters + stage name
4. Animate entry/exit with motion/react
5. Add to `App.tsx` as sibling to routes

### Task 6: Refactor SidecarView
1. Replace all local state with Zustand store selectors
2. Remove useEffect for timer, audio init, keyboard shortcuts (move to store/services)
3. Keep UI-only state local (drawerOpen, showTranscript, openMemoId)
4. Use orchestrator.end() for session completion

### Task 7: Refactor SetupView
1. Use orchestrator.start() when user clicks "Start Session"
2. Pass session config to orchestrator instead of route state

### Task 8: TypeScript & Build Verification
1. Run `npx tsc --noEmit` — verify no type errors
2. Run `npx vite build` — verify production build succeeds
3. Verify all imports/exports are correct
