import { useState, useCallback } from 'react';

/* ── Types ─────────────────────────────────── */

export type SessionStatus =
  | 'idle'
  | 'setup'
  | 'recording'
  | 'feedback_draft'
  | 'feedback_final';

export type SessionState = {
  sessionId: string | null;
  sessionName: string;
  mode: '1v1' | 'group';
  status: SessionStatus;
  participants: Array<{ name: string; speakerId?: string }>;
  startedAt: Date | null;
  templateId: string;
  teamsJoinUrl: string;
  baseApiUrl: string;
};

export type UseSessionReturn = {
  state: SessionState;
  create: (config: Partial<SessionState>) => void;
  startRecording: () => void;
  stopRecording: () => void;
  finalize: () => Promise<void>;
  reset: () => void;
};

/* ── Initial state ─────────────────────────── */

const INITIAL_STATE: SessionState = {
  sessionId: null,
  sessionName: '',
  mode: '1v1',
  status: 'idle',
  participants: [],
  startedAt: null,
  templateId: '',
  teamsJoinUrl: '',
  baseApiUrl: '',
};

/* ── Hook ──────────────────────────────────── */

export function useSession(): UseSessionReturn {
  const [state, setState] = useState<SessionState>(INITIAL_STATE);

  /**
   * Initialize a new session and transition to 'setup'.
   * Generates a unique session ID using timestamp.
   */
  const create = useCallback((config: Partial<SessionState>) => {
    setState((prev) => {
      if (prev.status !== 'idle') return prev;
      return {
        ...INITIAL_STATE,
        ...config,
        sessionId: config.sessionId ?? `session-${Date.now()}`,
        status: 'setup',
      };
    });
  }, []);

  /**
   * Transition from 'setup' to 'recording' and record start time.
   */
  const startRecording = useCallback(() => {
    setState((prev) => {
      if (prev.status !== 'setup') return prev;
      return { ...prev, status: 'recording', startedAt: new Date() };
    });
  }, []);

  /**
   * Transition from 'recording' to 'feedback_draft'.
   */
  const stopRecording = useCallback(() => {
    setState((prev) => {
      if (prev.status !== 'recording') return prev;
      return { ...prev, status: 'feedback_draft' };
    });
  }, []);

  /**
   * Call the finalize endpoint via the preload bridge,
   * then transition to 'feedback_final'.
   */
  const finalize = useCallback(async () => {
    if (state.status !== 'feedback_draft') return;
    if (!state.sessionId || !state.baseApiUrl) {
      throw new Error('Cannot finalize: missing sessionId or baseApiUrl');
    }

    await window.desktopAPI.finalizeV2({
      baseUrl: state.baseApiUrl,
      sessionId: state.sessionId,
    });

    setState((prev) => {
      if (prev.status !== 'feedback_draft') return prev;
      return { ...prev, status: 'feedback_final' };
    });
  }, [state.status, state.sessionId, state.baseApiUrl]);

  /**
   * Reset back to idle state.
   */
  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return {
    state,
    create,
    startRecording,
    stopRecording,
    finalize,
    reset,
  };
}
