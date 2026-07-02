import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmsToLevel } from '../AudioService';

// Mock the session store
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: vi.fn(() => ({
      setAudioError: vi.fn(),
      setAudioReady: vi.fn(),
      setIsCapturing: vi.fn(),
      setAudioLevels: vi.fn(),
      tick: vi.fn(),
    })),
  },
}));

// Mock WebSocketService to prevent real WS connections
vi.mock('../WebSocketService', () => ({
  wsService: { sendAudioChunk: vi.fn() },
}));

function makeMockStore() {
  return {
    setAudioError: vi.fn(),
    setAudioReady: vi.fn(),
    setIsCapturing: vi.fn(),
    setAudioLevels: vi.fn(),
    tick: vi.fn(),
  };
}

function makeMockAudioContext(closeFn = vi.fn()) {
  const mockAnalyser = {
    fftSize: 0,
    getFloatTimeDomainData: vi.fn(),
    connect: vi.fn(),
  };
  const mockGain = { gain: { value: 1 }, connect: vi.fn() };

  // AudioContext must be a real class constructor (not a plain fn) because the
  // service uses `new AudioContext()`.
  class MockAudioContext {
    state = 'running';
    destination = {};
    audioWorklet = null; // force ScriptProcessorNode fallback
    resume = vi.fn().mockResolvedValue(undefined);
    createAnalyser = vi.fn().mockReturnValue(mockAnalyser);
    createGain = vi.fn().mockReturnValue(mockGain);
    createScriptProcessor = vi.fn().mockReturnValue({
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    });
    createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() });
    close = closeFn;
  }

  return MockAudioContext;
}

function makeMockMicStream() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
    track,
  };
}

describe('rmsToLevel (P1-c louder meter mapping)', () => {
  it('maps full-scale rms (1) to 100', () => {
    expect(rmsToLevel(1)).toBe(100);
  });

  it('clamps above-unity rms to 100', () => {
    expect(rmsToLevel(2)).toBe(100);
  });

  it('maps normal speech rms (0.1) to a clearly visible level (> 40)', () => {
    // Regression guard: the old `rms * 200` mapping produced only 20 here,
    // rendering a ~20% wide bar for a normal-volume speaker.
    const level = rmsToLevel(0.1);
    expect(level).toBeGreaterThan(40);
    expect(level).toBeLessThanOrEqual(100);
  });

  it('keeps a quiet noise-floor rms (0.005) very low but non-negative', () => {
    const level = rmsToLevel(0.005);
    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThan(10);
  });

  it('gives a soft speaker (rms 0.05) a visibly non-trivial reading', () => {
    // Soft speech should still move the bar meaningfully (more than the old
    // mapping's 10) so users see it react.
    expect(rmsToLevel(0.05)).toBeGreaterThan(10);
  });

  it('is monotonic — louder rms never yields a lower level', () => {
    expect(rmsToLevel(0.2)).toBeGreaterThan(rmsToLevel(0.1));
    expect(rmsToLevel(0.5)).toBeGreaterThanOrEqual(rmsToLevel(0.2));
  });

  it('returns 0 for silence (rms 0)', () => {
    expect(rmsToLevel(0)).toBe(0);
  });
});

describe('AudioService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('startCapture sets isCapturing to true', async () => {
    const mockStore = makeMockStore();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as ReturnType<typeof useSessionStore.getState>);

    vi.stubGlobal('AudioContext', makeMockAudioContext());

    const { audioService } = await import('../AudioService');
    audioService.startCapture();
    expect(mockStore.setIsCapturing).toHaveBeenCalledWith(true);
    audioService.stopCapture();
  });

  it('stopCapture sets isCapturing to false and resets audio levels', async () => {
    const mockStore = makeMockStore();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as ReturnType<typeof useSessionStore.getState>);

    vi.stubGlobal('AudioContext', makeMockAudioContext());

    const { audioService } = await import('../AudioService');
    audioService.startCapture();
    audioService.stopCapture();

    expect(mockStore.setIsCapturing).toHaveBeenCalledWith(false);
    expect(mockStore.setAudioLevels).toHaveBeenCalledWith({ mic: 0, system: 0, mixed: 0 });
  });

  it('destroy() closes the AudioContext if open', async () => {
    const mockStore = makeMockStore();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as ReturnType<typeof useSessionStore.getState>);

    const closeFn = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('AudioContext', makeMockAudioContext(closeFn));

    const { audioService } = await import('../AudioService');
    audioService.ensureAudioGraph();
    audioService.destroy();

    expect(closeFn).toHaveBeenCalled();
  });

  it('initMic sets error when getUserMedia is denied', async () => {
    const mockStore = makeMockStore();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as ReturnType<typeof useSessionStore.getState>);

    vi.stubGlobal('AudioContext', makeMockAudioContext());
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new Error('Permission denied')),
        getDisplayMedia: vi.fn().mockRejectedValue(new Error('Permission denied')),
      },
    });

    const { audioService } = await import('../AudioService');
    await audioService.initMic();

    expect(mockStore.setAudioError).toHaveBeenCalledWith(
      expect.stringContaining('Microphone init failed'),
    );
    expect(mockStore.setAudioReady).toHaveBeenCalledWith('mic', false);
  });

  it('startCapture then stopCapture leaves isCapturing false', async () => {
    const mockStore = makeMockStore();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as ReturnType<typeof useSessionStore.getState>);

    vi.stubGlobal('AudioContext', makeMockAudioContext());

    const { audioService } = await import('../AudioService');
    audioService.startCapture();
    audioService.stopCapture();

    // Last call to setIsCapturing should be false
    const calls = mockStore.setIsCapturing.mock.calls;
    expect(calls[calls.length - 1][0]).toBe(false);
  });

  // ── R6-audio: Settings preview (single capture source) ──

  it('startPreview during a live session is a no-op (never a second getUserMedia)', async () => {
    const mockStore = { ...makeMockStore(), isCapturing: true };
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as unknown as ReturnType<typeof useSessionStore.getState>);

    vi.stubGlobal('AudioContext', makeMockAudioContext());
    const getUserMedia = vi.fn().mockResolvedValue(makeMockMicStream());
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { audioService } = await import('../AudioService');
    await audioService.startPreview();

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(mockStore.setIsCapturing).not.toHaveBeenCalled();
  });

  it('startPreview (idle) opens the mic WITHOUT a PCM processor and never sets isCapturing', async () => {
    const mockStore = { ...makeMockStore(), isCapturing: false };
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as unknown as ReturnType<typeof useSessionStore.getState>);

    const MockCtx = makeMockAudioContext();
    vi.stubGlobal('AudioContext', MockCtx);
    const getUserMedia = vi.fn().mockResolvedValue(makeMockMicStream());
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { audioService } = await import('../AudioService');
    await audioService.startPreview();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(mockStore.setAudioReady).toHaveBeenCalledWith('mic', true);
    // Preview never marks the session as capturing (PiP / warnings hang off it) and
    // never creates the PCM processor (no chunks can reach the WS).
    expect(mockStore.setIsCapturing).not.toHaveBeenCalledWith(true);
    const { wsService } = await import('../WebSocketService');
    expect(vi.mocked(wsService.sendAudioChunk)).not.toHaveBeenCalled();

    audioService.stopPreview();
  });

  it('a superseded preview initMic (getUserMedia resolves after destroy) stops its stream and mutates nothing', async () => {
    const mockStore = { ...makeMockStore(), isCapturing: false };
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as unknown as ReturnType<typeof useSessionStore.getState>);

    const closeFn = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('AudioContext', makeMockAudioContext(closeFn));

    // getUserMedia stays pending until we release it, so we can interleave destroy().
    const micStream = makeMockMicStream();
    let releaseGum: (s: unknown) => void = () => {};
    const gumPromise = new Promise((resolve) => { releaseGum = resolve; });
    const getUserMedia = vi.fn().mockReturnValue(gumPromise);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { audioService } = await import('../AudioService');
    const initPromise = audioService.initMic(true);   // preview init, GUM pending
    audioService.destroy();                            // superseded mid-flight (bumps token)
    releaseGum(micStream);                             // now the mic prompt resolves
    await initPromise;

    // The orphaned stream is stopped (no mic-indicator leak) and readiness was NOT flipped
    // true by the stale continuation.
    expect(micStream.track.stop).toHaveBeenCalled();
    expect(mockStore.setAudioReady).not.toHaveBeenCalledWith('mic', true);
  });

  it('stopPreview during a live session never tears down capture; when idle it releases everything', async () => {
    const mockStore = { ...makeMockStore(), isCapturing: true };
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue(mockStore as unknown as ReturnType<typeof useSessionStore.getState>);

    const closeFn = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('AudioContext', makeMockAudioContext(closeFn));

    const { audioService } = await import('../AudioService');
    audioService.ensureAudioGraph();

    // Live session → stopPreview must not close the shared AudioContext.
    audioService.stopPreview();
    expect(closeFn).not.toHaveBeenCalled();

    // Idle → stopPreview tears the graph down (mic released on leaving Settings).
    (mockStore as { isCapturing: boolean }).isCapturing = false;
    audioService.stopPreview();
    expect(closeFn).toHaveBeenCalled();
  });
});
