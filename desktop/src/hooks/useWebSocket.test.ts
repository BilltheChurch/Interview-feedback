import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static CONNECTING = 0;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sentMessages: string[] = [];
  private listeners: Map<string, Array<(e: Event) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, handler: (e: Event) => void, _opts?: unknown) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(handler);
  }

  removeEventListener(type: string, handler: (e: Event) => void) {
    const arr = this.listeners.get(type) || [];
    this.listeners.set(type, arr.filter((h) => h !== handler));
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this._emit('close', new CloseEvent('close', { wasClean: true }));
  }

  _emit(type: string, event: Event) {
    (this.listeners.get(type) || []).forEach((h) => h(event));
  }

  _open() {
    this.readyState = MockWebSocket.OPEN;
    this._emit('open', new Event('open'));
  }
}

describe('useWebSocket', () => {
  let createdSockets: MockWebSocket[] = [];

  beforeEach(() => {
    createdSockets = [];
    vi.stubGlobal('WebSocket', class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        createdSockets.push(this);
      }
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts with disconnected status for both roles', () => {
    const { result } = renderHook(() =>
      useWebSocket({ baseWsUrl: 'ws://localhost:8787', sessionId: 'sess_1' }),
    );
    expect(result.current.status.teacher).toBe('disconnected');
    expect(result.current.status.students).toBe('disconnected');
    expect(result.current.isConnected).toBe(false);
  });

  it('transitions to connecting status when connect() is called', async () => {
    const { result } = renderHook(() =>
      useWebSocket({ baseWsUrl: 'ws://localhost:8787', sessionId: 'sess_1' }),
    );

    act(() => {
      result.current.connect();
    });

    // After connect() both sockets are created; status set to 'connecting'
    expect(result.current.status.teacher).toBe('connecting');
    expect(result.current.status.students).toBe('connecting');
  });

  it('becomes connected after both sockets open and receive ready', async () => {
    const { result } = renderHook(() =>
      useWebSocket({ baseWsUrl: 'ws://localhost:8787', sessionId: 'sess_1' }),
    );

    let connectResolve: () => void;
    const connectDone = new Promise<void>((res) => { connectResolve = res; });

    act(() => {
      result.current.connect().then(() => connectResolve());
    });

    act(() => {
      createdSockets.forEach((ws) => ws._open());
    });

    await connectDone;

    act(() => {
      createdSockets.forEach((ws) =>
        ws._emit('message', new MessageEvent('message', { data: JSON.stringify({ type: 'ready' }) })),
      );
    });

    expect(result.current.status.teacher).toBe('connected');
    expect(result.current.status.students).toBe('connected');
    expect(result.current.isConnected).toBe(true);
  });

  it('sends hello handshake on socket open', async () => {
    const { result } = renderHook(() =>
      useWebSocket({ baseWsUrl: 'ws://localhost:8787', sessionId: 'hello_test' }),
    );

    let connectResolve: () => void;
    const connectDone = new Promise<void>((res) => { connectResolve = res; });

    act(() => {
      result.current.connect().then(() => connectResolve());
    });

    act(() => {
      createdSockets.forEach((ws) => ws._open());
    });

    await connectDone;

    const teacherWs = createdSockets.find((ws) => ws.url.includes('/teacher'))!;
    expect(teacherWs.sentMessages.length).toBeGreaterThan(0);
    const hello = JSON.parse(teacherWs.sentMessages[0]);
    expect(hello.type).toBe('hello');
    expect(hello.meeting_id).toBe('hello_test');
  });

  it('transitions to disconnected when disconnect() is called', async () => {
    const { result } = renderHook(() =>
      useWebSocket({ baseWsUrl: 'ws://localhost:8787', sessionId: 'sess_2' }),
    );

    let connectResolve: () => void;
    const connectDone = new Promise<void>((res) => { connectResolve = res; });

    act(() => {
      result.current.connect().then(() => connectResolve());
    });
    act(() => { createdSockets.forEach((ws) => ws._open()); });
    await connectDone;

    act(() => { result.current.disconnect(); });

    // Advance timers for the fallback cleanup
    act(() => { vi.advanceTimersByTime(2000); });

    expect(result.current.status.teacher).toBe('disconnected');
    expect(result.current.status.students).toBe('disconnected');
  });

  it('sets lastError when a socket fails to open', async () => {
    const { result } = renderHook(() =>
      useWebSocket({ baseWsUrl: 'ws://localhost:8787', sessionId: 'sess_3' }),
    );

    act(() => {
      result.current.connect().catch(() => {});
    });

    act(() => {
      createdSockets.forEach((ws) =>
        ws._emit('error', new Event('error')),
      );
    });

    expect(result.current.lastError).not.toBeNull();
  });

  it('schedules reconnect after unexpected socket close', async () => {
    const { result } = renderHook(() =>
      useWebSocket({ baseWsUrl: 'ws://localhost:8787', sessionId: 'sess_4' }),
    );

    let connectResolve: () => void;
    const connectDone = new Promise<void>((res) => { connectResolve = res; });

    act(() => {
      result.current.connect().then(() => connectResolve());
    });
    act(() => { createdSockets.forEach((ws) => ws._open()); });
    await connectDone;

    const teacherWs = createdSockets.find((ws) => ws.url.includes('/teacher'))!;
    // Simulate unexpected close (not initiated by disconnect())
    act(() => {
      teacherWs._emit('close', new CloseEvent('close', { wasClean: false }));
    });

    expect(result.current.status.teacher).toBe('reconnecting');
  });
});
