import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the session store before importing the service
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: vi.fn(() => ({ tick: vi.fn() })),
  },
}));

describe('TimerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls tick every second after start()', async () => {
    const tickFn = vi.fn();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue({ tick: tickFn } as ReturnType<typeof useSessionStore.getState>);

    const { timerService } = await import('../TimerService');
    timerService.start();

    vi.advanceTimersByTime(3000);
    expect(tickFn).toHaveBeenCalledTimes(3);
    timerService.stop();
  });

  it('does not call tick after stop()', async () => {
    const tickFn = vi.fn();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue({ tick: tickFn } as ReturnType<typeof useSessionStore.getState>);

    const { timerService } = await import('../TimerService');
    timerService.start();
    vi.advanceTimersByTime(1000);
    timerService.stop();

    const callsBefore = tickFn.mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(tickFn.mock.calls.length).toBe(callsBefore);
  });

  it('does not start a second interval if start() is called twice', async () => {
    const tickFn = vi.fn();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue({ tick: tickFn } as ReturnType<typeof useSessionStore.getState>);

    const { timerService } = await import('../TimerService');
    timerService.start();
    timerService.start(); // second call should be a no-op

    vi.advanceTimersByTime(2000);
    // Only 2 ticks (one per second), not 4 (two intervals * 2s)
    expect(tickFn).toHaveBeenCalledTimes(2);
    timerService.stop();
  });

  it('reset() stops the timer', async () => {
    const tickFn = vi.fn();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue({ tick: tickFn } as ReturnType<typeof useSessionStore.getState>);

    const { timerService } = await import('../TimerService');
    timerService.start();
    vi.advanceTimersByTime(1000);

    timerService.reset();

    const callsBefore = tickFn.mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(tickFn.mock.calls.length).toBe(callsBefore);
  });

  it('can be restarted after stop()', async () => {
    const tickFn = vi.fn();
    const { useSessionStore } = await import('../../stores/sessionStore');
    vi.mocked(useSessionStore.getState).mockReturnValue({ tick: tickFn } as ReturnType<typeof useSessionStore.getState>);

    const { timerService } = await import('../TimerService');
    timerService.start();
    vi.advanceTimersByTime(1000);
    timerService.stop();

    tickFn.mockClear();

    timerService.start();
    vi.advanceTimersByTime(2000);
    expect(tickFn).toHaveBeenCalledTimes(2);
    timerService.stop();
  });
});
