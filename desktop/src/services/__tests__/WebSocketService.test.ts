import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session store
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: vi.fn(() => ({
      setWsStatus: vi.fn(),
      setWsError: vi.fn(),
    })),
  },
}));

// Stub import.meta.env so getApiKey() takes the fast env-var path (no IPC)
vi.stubEnv('VITE_WORKER_API_KEY', '');

// Ensure window.desktopAPI is undefined so getApiKey falls through to env var
Object.defineProperty(window, 'desktopAPI', {
  value: undefined,
  writable: true,
  configurable: true,
});

class FakeWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static CONNECTING = 0;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  protocols?: string | string[];
  sentMessages: string[] = [];
  private handlers: Map<string, Set<(e: Event) => void>> = new Map();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  addEventListener(type: string, fn: (e: Event) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: Event) => void) {
    this.handlers.get(type)?.delete(fn);
  }

  send(data: string) { this.sentMessages.push(data); }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this._dispatch('close', new CloseEvent('close', { code, reason, wasClean: true }));
  }

  _dispatch(type: string, event: Event) {
    this.handlers.get(type)?.forEach((fn) => fn(event));
  }

  _open() {
    this.readyState = FakeWebSocket.OPEN;
    this._dispatch('open', new Event('open'));
  }
}

// Helper: flush all pending microtasks/promises
function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('WebSocketService', () => {
  let sockets: FakeWebSocket[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    sockets = [];

    const FakeWS = class extends FakeWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    Object.assign(FakeWS, {
      OPEN: FakeWebSocket.OPEN,
      CLOSING: FakeWebSocket.CLOSING,
      CLOSED: FakeWebSocket.CLOSED,
      CONNECTING: FakeWebSocket.CONNECTING,
    });
    vi.stubGlobal('WebSocket', FakeWS);
  });

  it('sendAudioChunk is a no-op when not connected', async () => {
    const { wsService } = await import('../WebSocketService');
    const buf = new ArrayBuffer(8);
    expect(() => wsService.sendAudioChunk('teacher', buf, 1)).not.toThrow();
  });

  it('connect() creates two sockets (teacher + students)', async () => {
    const { wsService } = await import('../WebSocketService');

    // Start connect — it awaits getApiKey() then opens sockets
    const connectP = wsService.connect({
      baseWsUrl: 'ws://localhost:8787',
      sessionId: 'sess_1',
    });

    // Flush the getApiKey() promise resolution
    await flushPromises();

    // Now open both sockets to resolve the openSocket promises
    sockets.forEach((ws) => ws._open());

    await connectP;

    expect(sockets).toHaveLength(2);
    expect(sockets.some((ws) => ws.url.includes('/teacher'))).toBe(true);
    expect(sockets.some((ws) => ws.url.includes('/students'))).toBe(true);
  });

  it('sends hello handshake on connect', async () => {
    const { wsService } = await import('../WebSocketService');

    const connectP = wsService.connect({
      baseWsUrl: 'ws://localhost:8787',
      sessionId: 'sess_hello',
      interviewerName: 'Dr. Smith',
    });

    await flushPromises();
    sockets.forEach((ws) => ws._open());
    await connectP;

    const teacherWs = sockets.find((ws) => ws.url.includes('/teacher'))!;
    expect(teacherWs.sentMessages).toHaveLength(1);
    const hello = JSON.parse(teacherWs.sentMessages[0]);
    expect(hello.type).toBe('hello');
    expect(hello.stream_role).toBe('teacher');
    expect(hello.meeting_id).toBe('sess_hello');
    expect(hello.interviewer_name).toBe('Dr. Smith');
  });

  it('sendMark sends a mark message when socket is open', async () => {
    const { wsService } = await import('../WebSocketService');

    const connectP = wsService.connect({
      baseWsUrl: 'ws://localhost:8787',
      sessionId: 'sess_mark',
    });

    await flushPromises();
    sockets.forEach((ws) => ws._open());
    await connectP;

    const teacherWs = sockets.find((ws) => ws.url.includes('/teacher'))!;
    wsService.sendMark('teacher', { stage: 'intro' });

    const markMsg = teacherWs.sentMessages.find((m) => {
      try { return JSON.parse(m).type === 'mark'; } catch { return false; }
    });
    expect(markMsg).toBeDefined();
    expect(JSON.parse(markMsg!).stage).toBe('intro');
  });

  it('disconnect() sends close frame to open sockets', async () => {
    const { wsService } = await import('../WebSocketService');

    const connectP = wsService.connect({
      baseWsUrl: 'ws://localhost:8787',
      sessionId: 'sess_disc',
    });

    await flushPromises();
    sockets.forEach((ws) => ws._open());
    await connectP;

    wsService.disconnect('test-done');

    sockets.forEach((ws) => {
      const closeMsg = ws.sentMessages.find((m) => {
        try { return JSON.parse(m).type === 'close'; } catch { return false; }
      });
      expect(closeMsg).toBeDefined();
    });
  });

  it('sendEnrollment sends enrollment message to teacher socket', async () => {
    const { wsService } = await import('../WebSocketService');

    const connectP = wsService.connect({
      baseWsUrl: 'ws://localhost:8787',
      sessionId: 'sess_enroll',
    });

    await flushPromises();
    sockets.forEach((ws) => ws._open());
    await connectP;

    wsService.sendEnrollment('teacher', { speaker_id: 'spk_001', participant_name: 'Alice' });

    const teacherWs = sockets.find((ws) => ws.url.includes('/teacher'))!;
    const enrollMsg = teacherWs.sentMessages.find((m) => {
      try { return JSON.parse(m).type === 'enrollment'; } catch { return false; }
    });
    expect(enrollMsg).toBeDefined();
    expect(JSON.parse(enrollMsg!).participant_name).toBe('Alice');
  });
});
