import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock react-router-dom — partial mock preserving MemoryRouter etc.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the session store
const mockStoreState = {
  sessionId: null as string | null,
  sessionName: '',
  mode: '1v1' as const,
  participants: [] as Array<{ name: string; speakerId?: string }>,
  memos: [] as Array<{ id: string; type: string; text: string; timestamp: number; stageIndex: number; stage?: string }>,
  stages: [] as string[],
  notes: '',
  stageArchives: [] as unknown[],
  elapsedSeconds: 0,
  startedAt: null as number | null,
  baseApiUrl: '',
  finalizeRequested: false,
  startSession: vi.fn(),
  endSession: vi.fn(),
  restoreSession: vi.fn(),
  reset: vi.fn(),
  setFinalizeRequested: vi.fn(),
};

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => mockStoreState,
  },
}));

// Mock window.desktopAPI
const mockFinalizeV2 = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(globalThis, 'window', {
  value: {
    desktopAPI: {
      finalizeV2: mockFinalizeV2,
    },
  },
  writable: true,
});

// Mock requestAnimationFrame
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
  cb(0);
  return 0;
};

import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { useSessionFlow } from './useSessionFlow';

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children);
}

describe('useSessionFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.sessionId = null;
    mockStoreState.sessionName = '';
    mockStoreState.participants = [];
    mockStoreState.memos = [];
    mockStoreState.stages = [];
    mockStoreState.notes = '';
    mockStoreState.stageArchives = [];
    mockStoreState.elapsedSeconds = 0;
    mockStoreState.startedAt = null;
    mockStoreState.baseApiUrl = '';
    mockStoreState.finalizeRequested = false;
    mockStoreState.startSession.mockClear();
    mockStoreState.endSession.mockClear();
    mockStoreState.restoreSession.mockClear();
    mockStoreState.reset.mockClear();
    mockStoreState.setFinalizeRequested.mockClear();
    mockFinalizeV2.mockClear();
    mockNavigate.mockClear();
  });

  it('returns beginSession, endSession, and restoreSession functions', () => {
    const { result } = renderHook(() => useSessionFlow(), { wrapper });
    expect(typeof result.current.beginSession).toBe('function');
    expect(typeof result.current.endSession).toBe('function');
    expect(typeof result.current.restoreSession).toBe('function');
  });

  it('beginSession calls store.startSession with the provided config', async () => {
    const { result } = renderHook(() => useSessionFlow(), { wrapper });
    const config = {
      sessionId: 'sess_abc',
      sessionName: 'My Interview',
      mode: '1v1' as const,
      participants: [{ name: 'Alice' }],
      stages: ['Intro', 'Q1'],
      baseApiUrl: 'http://localhost:8787',
    };
    await result.current.beginSession(config);
    expect(mockStoreState.startSession).toHaveBeenCalledWith(config);
  });

  it('endSession calls stopServicesFirst before store.endSession', () => {
    const callOrder: string[] = [];
    const stopServicesFirst = vi.fn(() => { callOrder.push('stop'); });
    mockStoreState.endSession.mockImplementation(() => { callOrder.push('end'); });
    mockStoreState.sessionId = 'sess_123';
    mockStoreState.sessionName = 'Interview X';
    mockStoreState.mode = '1v1';
    mockStoreState.participants = [{ name: 'Bob' }];
    mockStoreState.stages = ['Intro'];
    mockStoreState.baseApiUrl = ''; // no baseApiUrl → skip finalization

    const { result } = renderHook(() => useSessionFlow(), { wrapper });
    result.current.endSession(stopServicesFirst);

    expect(callOrder.indexOf('stop')).toBeLessThan(callOrder.indexOf('end'));
  });

  it('endSession navigates to /feedback/:sessionId', () => {
    mockStoreState.sessionId = 'sess_nav_test';
    mockStoreState.sessionName = 'Nav Test';
    mockStoreState.mode = '1v1';
    mockStoreState.participants = [];
    mockStoreState.stages = [];
    mockStoreState.baseApiUrl = '';

    const { result } = renderHook(() => useSessionFlow(), { wrapper });
    result.current.endSession(vi.fn());

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining('/feedback/sess_nav_test'),
      expect.any(Object),
    );
  });

  it('endSession triggers finalizeV2 when baseApiUrl is set', async () => {
    mockStoreState.sessionId = 'sess_finalize';
    mockStoreState.sessionName = 'Finalize Test';
    mockStoreState.mode = '1v1';
    mockStoreState.participants = [{ name: 'Charlie' }];
    mockStoreState.stages = ['Intro'];
    mockStoreState.baseApiUrl = 'http://localhost:8787';
    mockStoreState.finalizeRequested = false;

    const { result } = renderHook(() => useSessionFlow(), { wrapper });
    result.current.endSession(vi.fn());

    expect(mockStoreState.setFinalizeRequested).toHaveBeenCalledWith(true);

    // Allow microtask queue to flush
    await Promise.resolve();
    expect(mockFinalizeV2).toHaveBeenCalled();
  });

  it('restoreSession calls store.restoreSession and navigates to /session', async () => {
    const persisted = {
      sessionId: 'sess_restored',
      sessionName: 'Restored Interview',
      mode: '1v1' as const,
      participants: [{ name: 'Dana' }],
      elapsedSeconds: 300,
      stages: ['Intro', 'Q1'],
      baseApiUrl: 'http://localhost:8787',
      startedAt: Date.now(),
    };

    const { result } = renderHook(() => useSessionFlow(), { wrapper });
    await result.current.restoreSession(persisted);

    expect(mockStoreState.restoreSession).toHaveBeenCalledWith(persisted);
    expect(mockNavigate).toHaveBeenCalledWith(
      '/session',
      expect.objectContaining({
        state: expect.objectContaining({ sessionId: 'sess_restored' }),
      }),
    );
  });

  it('endSession persists session data to localStorage', () => {
    mockStoreState.sessionId = 'sess_persist';
    mockStoreState.sessionName = 'Persist Test';
    mockStoreState.mode = 'group';
    mockStoreState.participants = [{ name: 'Eve' }];
    mockStoreState.stages = ['Intro'];
    mockStoreState.baseApiUrl = '';
    mockStoreState.memos = [];

    const { result } = renderHook(() => useSessionFlow(), { wrapper });
    result.current.endSession(vi.fn());

    const stored = localStorage.getItem('ifb_session_data_sess_persist');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.sessionName).toBe('Persist Test');
  });
});
