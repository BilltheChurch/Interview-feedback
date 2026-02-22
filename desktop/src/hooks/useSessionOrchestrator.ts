import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import type { SessionConfig } from '../stores/sessionStore';
import { audioService } from '../services/AudioService';
import { wsService } from '../services/WebSocketService';
import { timerService } from '../services/TimerService';
import { acsCaptionService } from '../services/ACSCaptionService';

export function useSessionOrchestrator() {
  const navigate = useNavigate();

  // ── Fix SF-6: Clean up stale localStorage session data on mount ──
  useEffect(() => {
    try {
      const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const fresh = sessions.filter((s: any) => {
        const created = new Date(s.date).getTime();
        return !isNaN(created) && created > thirtyDaysAgo;
      });
      if (fresh.length < sessions.length) {
        // Remove stale session data entries
        const freshIds = new Set(fresh.map((s: any) => s.id));
        sessions.forEach((s: any) => {
          if (!freshIds.has(s.id)) {
            localStorage.removeItem(`ifb_session_data_${s.id}`);
          }
        });
        localStorage.setItem('ifb_sessions', JSON.stringify(fresh));
      }
    } catch { /* ignore cleanup errors */ }
  }, []);

  const start = async (config: SessionConfig) => {
    // Wait one animation frame for React Router to process navigate()
    // before setting status='recording', which prevents PiP flash
    await new Promise(resolve => requestAnimationFrame(resolve));
    const store = useSessionStore.getState();
    store.startSession(config);

    // Start timer immediately so elapsed time is tracked even if
    // audio or WebSocket setup fails or is slow
    timerService.start();

    try {
      await audioService.initMic();
    } catch {
      // Mic init may fail in dev mode; non-fatal for timer
    }
    try {
      await audioService.initSystem();
    } catch {
      // System audio is non-fatal (user may cancel screen picker)
    }
    audioService.startCapture();

    try {
      await wsService.connect({
        baseWsUrl: config.baseApiUrl.replace(/^http/, 'ws'),
        sessionId: config.sessionId,
        interviewerName: config.interviewerName,
        teamsInterviewerName: config.teamsInterviewerName,
        participants: config.participants,
      });
    } catch {
      // WS connect may fail in dev mode; non-fatal for session UI
    }

    // ── ACS Caption Integration ──
    const isTeamsMeeting = config.teamsJoinUrl?.includes('teams.microsoft.com');
    if (isTeamsMeeting) {
      try {
        const acsEnabled = await window.desktopAPI.acsGetEnabled();
        if (acsEnabled) {
          const acsResult = await window.desktopAPI.acsGetToken();
          if (acsResult.ok && acsResult.token) {
            await acsCaptionService.connect(
              config.teamsJoinUrl!,
              acsResult.token,
              (caption) => {
                // Forward caption to Worker via existing WebSocket (teacher channel)
                const ws = wsService.getSocket('teacher');
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'caption',
                    speaker: caption.speaker,
                    text: caption.text,
                    language: caption.language,
                    timestamp: caption.timestamp,
                    resultType: caption.resultType,
                    teamsUserId: caption.teamsUserId,
                  }));
                }
              },
            );
            // Notify Worker to switch to caption mode
            const teacherWs = wsService.getSocket('teacher');
            if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
              teacherWs.send(JSON.stringify({ type: 'session_config', captionSource: 'acs-teams' }));
            }
          }
        }
      } catch {
        // ACS connection is non-fatal; falls back to audio ASR
        console.warn('[Orchestrator] ACS caption connection failed, using audio ASR');
      }
    }
  };

  const end = () => {
    const store = useSessionStore.getState();
    const sessionId = store.sessionId;

    // Capture ALL session data before any cleanup resets state
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
    // even when navigated from History (no location.state)
    try {
      const key = `ifb_session_data_${sessionId}`;
      localStorage.setItem(key, JSON.stringify(sessionData));
    } catch { /* ignore storage errors */ }

    // Disconnect ACS caption service if connected or still connecting
    const acsStatus = acsCaptionService.getStatus();
    if (acsStatus === 'connected' || acsStatus === 'connecting') {
      acsCaptionService.disconnect().catch(() => {});
    }

    timerService.stop();
    wsService.disconnect();
    audioService.stopCapture();

    // endSession() sets status='feedback_draft', which immediately hides PiP
    store.endSession();
    navigate(`/feedback/${sessionId}`, { state: sessionData });

    // Destroy audio immediately — no longer needed after recording ends
    audioService.destroy();

    // After navigate, trigger finalization in background and then reset store.
    // IMPORTANT: reset() is deferred to ensure FeedbackView has fully mounted
    // via React Router before Zustand state is cleared (React 18 concurrent rendering
    // means navigate() does NOT synchronously mount the target route).
    const capturedSessionId = sessionData.sessionId;
    if (sessionData.baseApiUrl && capturedSessionId) {
      // Guard against double finalization: check finalizeRequested flag
      const currentState = useSessionStore.getState();
      if (currentState.finalizeRequested) {
        // Finalization already in progress (e.g. FeedbackView triggered it) — skip
        // Still defer reset so FeedbackView has time to mount
        Promise.resolve().then(() => {
          const current = useSessionStore.getState();
          if (current.sessionId === capturedSessionId || current.sessionId === null) {
            current.reset();
          }
        });
      } else {
        // Mark finalization as requested before calling
        useSessionStore.getState().setFinalizeRequested(true);
        // Use microtask instead of arbitrary 500ms setTimeout — fires after
        // React Router has committed the navigation
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
            // Finalization failure is non-fatal — user can retry from FeedbackView
          }
          // Only reset store if the user hasn't started a new session
          const current = useSessionStore.getState();
          if (current.sessionId === capturedSessionId || current.sessionId === null) {
            current.reset();
          }
        });
      }
    } else {
      // No finalization needed — still defer reset by one frame
      requestAnimationFrame(() => {
        const current = useSessionStore.getState();
        if (current.sessionId === capturedSessionId || current.sessionId === null) {
          current.reset();
        }
      });
    }
  };

  return { start, end };
}
