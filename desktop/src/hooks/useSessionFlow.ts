import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import type { SessionConfig, PersistedSession } from '../stores/sessionStore';

/**
 * Handles session state transitions: create → recording → finalizing → done.
 * Manages finalization API calls and store lifecycle (start, end, restore, reset).
 */
export function useSessionFlow() {
  const navigate = useNavigate();

  const beginSession = async (config: SessionConfig) => {
    // Wait one animation frame for React Router to process navigate()
    // before setting status='recording', preventing PiP flash
    await new Promise(resolve => requestAnimationFrame(resolve));
    const store = useSessionStore.getState();
    store.startSession(config);
  };

  const endSession = (stopServicesFirst: () => void) => {
    const store = useSessionStore.getState();
    const sessionId = store.sessionId;

    const sessionData = {
      sessionId,
      sessionName: store.sessionName,
      mode: store.mode,
      participants: store.participants.map(p => p.name),
      memos: store.memos.map(m => ({
        id: m.id,
        type: m.type,
        text: m.text,
        timestamp: m.timestamp,
        stage: store.stages[m.stageIndex] || 'General',
      })),
      stages: store.stages,
      notes: store.notes,
      stageArchives: store.stageArchives,
      elapsedSeconds: store.elapsedSeconds,
      date: store.startedAt
        ? new Date(store.startedAt).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      baseApiUrl: store.baseApiUrl,
    };

    // Persist session data to localStorage so FeedbackView can load it
    try {
      const key = `ifb_session_data_${sessionId}`;
      localStorage.setItem(key, JSON.stringify(sessionData));
    } catch { /* ignore storage errors */ }

    stopServicesFirst();

    // endSession() sets status='feedback_draft', which immediately hides PiP
    store.endSession();
    navigate(`/feedback/${sessionId}`, { state: sessionData });

    // Trigger finalization in background, then reset store
    const capturedSessionId = sessionData.sessionId;
    if (sessionData.baseApiUrl && capturedSessionId) {
      const currentState = useSessionStore.getState();
      if (currentState.finalizeRequested) {
        // Already in progress — just defer reset
        Promise.resolve().then(() => {
          const current = useSessionStore.getState();
          if (current.sessionId === capturedSessionId || current.sessionId === null) {
            current.reset();
          }
        });
      } else {
        useSessionStore.getState().setFinalizeRequested(true);
        Promise.resolve().then(async () => {
          try {
            await window.desktopAPI.finalizeV2({
              baseUrl: sessionData.baseApiUrl,
              sessionId: capturedSessionId!,
              metadata: {
                memos: sessionData.memos.map(m => ({
                  memo_id: m.id,
                  type: m.type,
                  text: m.text,
                  tags: [] as string[],
                  created_at_ms: Date.now(),
                  author_role: 'teacher' as const,
                  stage: m.stage,
                  stage_index: undefined,
                })),
                free_form_notes: sessionData.notes || null,
                stages: sessionData.stages,
                participants: sessionData.participants,
              },
            });
          } catch {
            // Non-fatal — user can retry from FeedbackView
          }
          const current = useSessionStore.getState();
          if (current.sessionId === capturedSessionId || current.sessionId === null) {
            current.reset();
          }
        });
      }
    } else {
      requestAnimationFrame(() => {
        const current = useSessionStore.getState();
        if (current.sessionId === capturedSessionId || current.sessionId === null) {
          current.reset();
        }
      });
    }
  };

  const restoreSession = async (persisted: PersistedSession) => {
    const store = useSessionStore.getState();
    store.restoreSession(persisted);

    navigate('/session', {
      state: {
        sessionId: persisted.sessionId,
        sessionName: persisted.sessionName,
        mode: persisted.mode,
        participants: persisted.participants.map(p => p.name),
        stages: persisted.stages,
        teamsUrl: persisted.teamsJoinUrl,
      },
    });

    // Wait one frame for the route to mount
    await new Promise(resolve => requestAnimationFrame(resolve));
  };

  return { beginSession, endSession, restoreSession };
}
