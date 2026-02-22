import { useSessionStore } from '../stores/sessionStore';
import type { StreamRole } from '../stores/sessionStore';

/* ── Types ─────────────────────────────────── */

export type WsConnectOptions = {
  baseWsUrl: string;
  sessionId: string;
  sampleRate?: number;
  channels?: number;
  format?: string;
  interviewerName?: string;
  teamsInterviewerName?: string;
  participants?: Array<{ name: string }>;
};

/* ── Constants ─────────────────────────────── */

const STREAM_ROLES: StreamRole[] = ['teacher', 'students'];
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000];
const MAX_RECONNECT_ATTEMPTS = 20;

/* ── Helpers ───────────────────────────────── */

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function buildWsUrl(baseWsUrl: string, sessionId: string, role: StreamRole): Promise<string> {
  const base = baseWsUrl.replace(/\/+$/, '');
  const url = `${base}/v1/audio/ws/${encodeURIComponent(sessionId)}/${role}`;
  // Retrieve API key from main process via IPC (keeps secret out of renderer bundle).
  // Falls back to VITE_ env var for dev/browser mode where desktopAPI is unavailable.
  let apiKey: string | undefined;
  try {
    if (window.desktopAPI?.getWorkerApiKey) {
      apiKey = await window.desktopAPI.getWorkerApiKey();
    }
  } catch {
    // IPC unavailable — fall through to env var
  }
  if (!apiKey) {
    apiKey = import.meta.env.VITE_WORKER_API_KEY;
  }
  if (apiKey) {
    return `${url}?api_key=${encodeURIComponent(apiKey)}`;
  }
  return url;
}

/* ── WebSocketService ──────────────────────── */

class WebSocketService {
  private sockets: Record<StreamRole, WebSocket | null> = { teacher: null, students: null };
  private ready: Record<StreamRole, boolean> = { teacher: false, students: false };
  private reconnectAttempts: Record<StreamRole, number> = { teacher: 0, students: 0 };
  private reconnectTimers: Record<StreamRole, ReturnType<typeof setTimeout> | null> = {
    teacher: null,
    students: null,
  };
  private closing: Record<StreamRole, boolean> = { teacher: false, students: false };

  // Cached connect options for reconnection
  private connectOpts: WsConnectOptions | null = null;

  /* ── Open a single stream ────────────────── */

  private openSocket(role: StreamRole): Promise<void> {
    const opts = this.connectOpts;
    if (!opts) return Promise.reject(new Error('No connect options'));

    const {
      baseWsUrl,
      sessionId,
      sampleRate = 16000,
      channels = 1,
      format = 'pcm_s16le',
      interviewerName,
      teamsInterviewerName,
      participants,
    } = opts;

    return new Promise(async (resolve, reject) => {
      const url = await buildWsUrl(baseWsUrl, sessionId, role);
      useSessionStore.getState().setWsStatus(role, 'connecting');

      const ws = new WebSocket(url);
      this.sockets[role] = ws;
      this.ready[role] = false;
      this.closing[role] = false;

      let settled = false;

      const onOpen = () => {
        if (settled) return;
        settled = true;
        ws.removeEventListener('error', onError);

        ws.send(
          JSON.stringify({
            type: 'hello',
            stream_role: role,
            meeting_id: sessionId,
            sample_rate: sampleRate,
            channels,
            format,
            capture_mode: 'dual_stream',
            interviewer_name: interviewerName,
            teams_interviewer_name: teamsInterviewerName,
            teams_participants: participants,
          }),
        );
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        ws.removeEventListener('open', onOpen);
        useSessionStore.getState().setWsStatus(role, 'error');
        useSessionStore.getState().setWsError(`${role} websocket open failed`);
        reject(new Error(`${role} websocket open failed`));
      };

      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });

      // Ongoing message handler
      ws.addEventListener('message', (event: MessageEvent) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (payload.type === 'ready') {
          this.ready[role] = true;
          this.reconnectAttempts[role] = 0;
          useSessionStore.getState().setWsStatus(role, 'connected');
        }
      });

      // Close handler
      ws.addEventListener('close', () => {
        if (this.sockets[role] !== ws) return;
        this.sockets[role] = null;
        this.ready[role] = false;

        if (this.closing[role]) {
          useSessionStore.getState().setWsStatus(role, 'disconnected');
          this.closing[role] = false;
        } else {
          this.scheduleReconnect(role);
        }
      });

      // Ongoing error handler
      ws.addEventListener('error', () => {
        if (!settled) return;
        useSessionStore.getState().setWsError(`${role} websocket error`);
        useSessionStore.getState().setWsStatus(role, 'error');
      });
    });
  }

  /* ── Reconnect with exponential backoff ──── */

  private scheduleReconnect(role: StreamRole): void {
    if (this.closing[role]) return;

    const attempts = this.reconnectAttempts[role];

    // Enforce max reconnect attempts to avoid infinite retry loops
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[WebSocketService] ${role}: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded — giving up`,
      );
      useSessionStore.getState().setWsStatus(role, 'error');
      useSessionStore
        .getState()
        .setWsError(`${role} connection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      return;
    }

    const idx = Math.min(RECONNECT_BACKOFF_MS.length - 1, attempts);
    const delay = RECONNECT_BACKOFF_MS[idx];
    this.reconnectAttempts[role] = attempts + 1;

    useSessionStore.getState().setWsStatus(role, 'reconnecting');

    this.reconnectTimers[role] = setTimeout(() => {
      if (this.closing[role]) return;
      this.openSocket(role).catch(() => {
        // openSocket rejection triggers error state;
        // next close event will schedule another reconnect
      });
    }, delay);
  }

  /* ── Close a single stream ───────────────── */

  private closeSocket(role: StreamRole, reason: string): void {
    if (this.reconnectTimers[role]) {
      clearTimeout(this.reconnectTimers[role]!);
      this.reconnectTimers[role] = null;
    }

    const ws = this.sockets[role];
    if (!ws) {
      useSessionStore.getState().setWsStatus(role, 'disconnected');
      return;
    }

    this.closing[role] = true;

    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'close', stream_role: role, reason }));
      }
    } catch {
      // noop
    }

    try {
      ws.close(1000, reason.slice(0, 120));
    } catch {
      // noop
    }

    // Fallback cleanup if close event never fires
    setTimeout(() => {
      if (this.sockets[role] === ws) {
        this.sockets[role] = null;
        this.ready[role] = false;
        this.closing[role] = false;
        useSessionStore.getState().setWsStatus(role, 'disconnected');
      }
    }, 1500);
  }

  /* ── Public API ──────────────────────────── */

  async connect(opts: WsConnectOptions): Promise<void> {
    this.connectOpts = opts;
    useSessionStore.getState().setWsError(null);
    await Promise.all(STREAM_ROLES.map((role) => this.openSocket(role)));
  }

  disconnect(reason = 'client-stop'): void {
    STREAM_ROLES.forEach((role) => this.closeSocket(role, reason));
  }

  sendAudioChunk(role: StreamRole, chunk: ArrayBuffer, seq: number): void {
    const ws = this.sockets[role];
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ready[role]) return;

    const opts = this.connectOpts;
    if (!opts) return;

    ws.send(
      JSON.stringify({
        type: 'chunk',
        stream_role: role,
        meeting_id: opts.sessionId,
        seq,
        timestamp_ms: Date.now(),
        sample_rate: opts.sampleRate ?? 16000,
        channels: opts.channels ?? 1,
        format: opts.format ?? 'pcm_s16le',
        content_b64: arrayBufferToBase64(chunk),
      }),
    );
  }

  sendMark(role: StreamRole, mark: Record<string, unknown>): void {
    const ws = this.sockets[role];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'mark', stream_role: role, ...mark }));
  }

  sendEnrollment(role: StreamRole, data: Record<string, unknown>): void {
    const ws = this.sockets[role];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'enrollment', stream_role: role, ...data }));
  }

  /** Get the raw WebSocket for a given stream role. Used by ACS caption integration. */
  getSocket(role: StreamRole): WebSocket | null {
    return this.sockets[role];
  }

  destroy(): void {
    this.disconnect('destroy');
    this.connectOpts = null;
  }
}

export const wsService = new WebSocketService();
