import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    close = closeFn;
  }

  return MockAudioContext;
}

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
});
