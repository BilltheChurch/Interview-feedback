import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import type { SessionConfig, PersistedSession, AcsStatus } from '../stores/sessionStore';
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
    console.log('[Orchestrator] Teams meeting check:', { isTeamsMeeting, teamsJoinUrl: config.teamsJoinUrl });
    if (isTeamsMeeting) {
      try {
        const acsEnabled = await window.desktopAPI.acsGetEnabled();
        console.log('[Orchestrator] ACS enabled:', acsEnabled);
        if (acsEnabled) {
          const acsResult = await window.desktopAPI.acsGetToken();
          console.log('[Orchestrator] ACS token result:', { ok: acsResult.ok, hasToken: !!acsResult.token, error: acsResult.error });
          if (acsResult.ok && acsResult.token) {
            console.log('[Orchestrator] Connecting ACS caption service...');
            // Map CaptionStatus → AcsStatus for the store
            const mapStatus = (s: string): AcsStatus => {
              if (s === 'connecting') return 'connecting';
              if (s === 'connected') return 'connected';
              if (s === 'error') return 'error';
              return 'off';
            };
            useSessionStore.getState().setAcsStatus('connecting');
            await acsCaptionService.connect(
              config.teamsJoinUrl!,
              acsResult.token,
              (caption) => {
                // Forward caption to Worker via existing WebSocket (teacher channel)
                const ws = wsService.getSocket('teacher');
                // Mark as 'receiving' on first caption arrival
                const store = useSessionStore.getState();
                if (store.acsStatus === 'connected') {
                  store.setAcsStatus('receiving');
                }
                store.incrementAcsCaptionCount();
                // Store Final captions locally for UI display
                if (caption.resultType === 'Final') {
                  store.addCaption({
                    speaker: caption.speaker,
                    text: caption.text,
                    timestamp: caption.timestamp,
                    language: caption.language,
                  });
                }
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
                } else {
                  console.warn('[Orchestrator] Caption dropped: teacher WS not open', {
                    hasWs: !!ws,
                    readyState: ws?.readyState,
                    speaker: caption.speaker,
                    text: caption.text?.slice(0, 40),
                  });
                }
              },
              undefined, // displayName — use default
              (captionStatus) => {
                useSessionStore.getState().setAcsStatus(mapStatus(captionStatus));
              },
            );
            console.log('[Orchestrator] ACS caption connected successfully');
            // Notify Worker to switch to caption mode
            const teacherWs = wsService.getSocket('teacher');
            if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
              teacherWs.send(JSON.stringify({ type: 'session_config', captionSource: 'acs-teams' }));
              console.log('[Orchestrator] Sent session_config captionSource=acs-teams to Worker');
            } else {
              console.error('[Orchestrator] FAILED to send session_config: teacher WS not open', {
                hasWs: !!teacherWs,
                readyState: teacherWs?.readyState,
              });
            }
          }
        }
      } catch (acsErr) {
        // ACS connection is non-fatal; falls back to audio ASR
        console.error('[Orchestrator] ACS caption connection failed:', acsErr);
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
    useSessionStore.getState().setAcsStatus('off');

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

  const resume = async (persisted: PersistedSession) => {
    // Restore store state first (synchronous — UI updates immediately)
    const store = useSessionStore.getState();
    store.restoreSession(persisted);

    // Navigate to session view with location state matching what SetupView passes
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

    // Wait one frame for the route to mount before starting services
    await new Promise(resolve => requestAnimationFrame(resolve));

    // Restart timer — it will continue from the restored elapsedSeconds
    timerService.start();

    // Re-init audio capture (mic + system)
    try {
      await audioService.initMic();
    } catch {
      // Non-fatal in dev mode
    }
    try {
      await audioService.initSystem();
    } catch {
      // System audio is non-fatal
    }
    audioService.startCapture();

    // Reconnect WebSocket to resume streaming
    try {
      await wsService.connect({
        baseWsUrl: persisted.baseApiUrl.replace(/^http/, 'ws'),
        sessionId: persisted.sessionId,
        interviewerName: persisted.interviewerName,
        teamsInterviewerName: persisted.teamsInterviewerName,
        participants: persisted.participants,
      });
    } catch {
      // WS connect may fail; non-fatal for session UI
    }

    // Re-connect ACS caption service if this was a Teams meeting
    const isTeamsMeeting = persisted.teamsJoinUrl?.includes('teams.microsoft.com');
    if (isTeamsMeeting) {
      try {
        const acsEnabled = await window.desktopAPI.acsGetEnabled();
        if (acsEnabled) {
          const acsResult = await window.desktopAPI.acsGetToken();
          if (acsResult.ok && acsResult.token) {
            const mapStatus = (s: string): AcsStatus => {
              if (s === 'connecting') return 'connecting';
              if (s === 'connected') return 'connected';
              if (s === 'error') return 'error';
              return 'off';
            };
            useSessionStore.getState().setAcsStatus('connecting');
            await acsCaptionService.connect(
              persisted.teamsJoinUrl,
              acsResult.token,
              (caption) => {
                const ws = wsService.getSocket('teacher');
                const store = useSessionStore.getState();
                if (store.acsStatus === 'connected') {
                  store.setAcsStatus('receiving');
                }
                store.incrementAcsCaptionCount();
                // Store Final captions locally for UI display
                if (caption.resultType === 'Final') {
                  store.addCaption({
                    speaker: caption.speaker,
                    text: caption.text,
                    timestamp: caption.timestamp,
                    language: caption.language,
                  });
                }
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
                } else {
                  console.warn('[Orchestrator] Resume caption dropped: teacher WS not open');
                }
              },
              undefined,
              (captionStatus) => {
                useSessionStore.getState().setAcsStatus(mapStatus(captionStatus));
              },
            );
            const teacherWs = wsService.getSocket('teacher');
            if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
              teacherWs.send(JSON.stringify({ type: 'session_config', captionSource: 'acs-teams' }));
              console.log('[Orchestrator] Resume: sent session_config captionSource=acs-teams');
            } else {
              console.error('[Orchestrator] Resume: FAILED to send session_config, WS not open');
            }
          }
        }
      } catch {
        // ACS reconnection is non-fatal
      }
    }

    console.log('[Orchestrator] Session resumed:', persisted.sessionId);
  };

  return { start, end, resume };
}
