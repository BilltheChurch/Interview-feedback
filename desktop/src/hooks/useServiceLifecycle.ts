import { useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import type { SessionConfig, PersistedSession, AcsStatus } from '../stores/sessionStore';
import { audioService } from '../services/AudioService';
import { wsService } from '../services/WebSocketService';
import { timerService } from '../services/TimerService';
import { acsCaptionService } from '../services/ACSCaptionService';
import type { StoredSessionRecord } from '../types/stored-session';

/**
 * Handles stale localStorage cleanup on mount and exposes ACS connection
 * helpers used by both start() and resume() flows.
 */
export function useServiceLifecycle() {
  // Clean up stale localStorage session data on mount (SF-6 fix)
  useEffect(() => {
    try {
      const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const fresh = sessions.filter((s: StoredSessionRecord) => {
        const created = new Date(s.date || '').getTime();
        return !isNaN(created) && created > thirtyDaysAgo;
      });
      if (fresh.length < sessions.length) {
        const freshIds = new Set(fresh.map((s: StoredSessionRecord) => s.id));
        sessions.forEach((s: StoredSessionRecord) => {
          if (!freshIds.has(s.id)) {
            localStorage.removeItem(`ifb_session_data_${s.id}`);
          }
        });
        localStorage.setItem('ifb_sessions', JSON.stringify(fresh));
      }
    } catch { /* ignore cleanup errors */ }
  }, []);

  const connectAcs = async (
    teamsJoinUrl: string,
    interviewerName?: string,
  ) => {
    const mapStatus = (s: string): AcsStatus => {
      if (s === 'connecting') return 'connecting';
      if (s === 'connected') return 'connected';
      if (s === 'error') return 'error';
      return 'off';
    };

    const acsEnabled = await window.desktopAPI.acsGetEnabled();
    if (!acsEnabled) return;

    const acsResult = await window.desktopAPI.acsGetToken();
    console.log('[ServiceLifecycle] ACS token result:', { ok: acsResult.ok, hasToken: !!acsResult.token, error: acsResult.error });
    if (!acsResult.ok || !acsResult.token) return;

    useSessionStore.getState().setAcsStatus('connecting');
    await acsCaptionService.connect(
      teamsJoinUrl,
      acsResult.token,
      (caption) => {
        const ws = wsService.getSocket('teacher');
        const store = useSessionStore.getState();
        if (store.acsStatus === 'connected') store.setAcsStatus('receiving');
        store.incrementAcsCaptionCount();
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
          console.warn('[ServiceLifecycle] Caption dropped: teacher WS not open', {
            hasWs: !!ws,
            readyState: ws?.readyState,
            speaker: caption.speaker,
            text: caption.text?.slice(0, 40),
          });
        }
      },
      interviewerName,
      (captionStatus) => {
        useSessionStore.getState().setAcsStatus(mapStatus(captionStatus));
      },
    );

    // Notify Worker to switch to caption mode
    const teacherWs = wsService.getSocket('teacher');
    if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
      teacherWs.send(JSON.stringify({ type: 'session_config', captionSource: 'acs-teams' }));
      console.log('[ServiceLifecycle] Sent session_config captionSource=acs-teams');
    } else {
      console.error('[ServiceLifecycle] FAILED to send session_config: teacher WS not open');
    }
  };

  const startServices = async (config: SessionConfig) => {
    timerService.start();

    try { await audioService.initMic(); } catch { /* non-fatal */ }
    try { await audioService.initSystem(); } catch { /* non-fatal */ }
    audioService.startCapture();

    try {
      await wsService.connect({
        baseWsUrl: config.baseApiUrl.replace(/^http/, 'ws'),
        sessionId: config.sessionId,
        interviewerName: config.interviewerName,
        teamsInterviewerName: config.teamsInterviewerName,
        participants: config.participants,
      });
    } catch { /* non-fatal */ }

    const isTeamsMeeting = config.teamsJoinUrl?.includes('teams.microsoft.com');
    console.log('[ServiceLifecycle] Teams meeting check:', { isTeamsMeeting, teamsJoinUrl: config.teamsJoinUrl });
    if (isTeamsMeeting) {
      try {
        await connectAcs(config.teamsJoinUrl!, config.teamsInterviewerName);
        console.log('[ServiceLifecycle] ACS caption connected successfully');
      } catch (acsErr) {
        console.error('[ServiceLifecycle] ACS caption connection failed:', acsErr);
      }
    }
  };

  const resumeServices = async (persisted: PersistedSession) => {
    timerService.start();

    try { await audioService.initMic(); } catch { /* non-fatal */ }
    try { await audioService.initSystem(); } catch { /* non-fatal */ }
    audioService.startCapture();

    try {
      await wsService.connect({
        baseWsUrl: persisted.baseApiUrl.replace(/^http/, 'ws'),
        sessionId: persisted.sessionId,
        interviewerName: persisted.interviewerName,
        teamsInterviewerName: persisted.teamsInterviewerName,
        participants: persisted.participants,
      });
    } catch { /* non-fatal */ }

    const isTeamsMeeting = persisted.teamsJoinUrl?.includes('teams.microsoft.com');
    if (isTeamsMeeting) {
      try {
        await connectAcs(persisted.teamsJoinUrl, persisted.teamsInterviewerName);
        console.log('[ServiceLifecycle] Resume: ACS caption reconnected');
      } catch {
        // Non-fatal
      }
    }
  };

  const stopServices = () => {
    const acsStatus = acsCaptionService.getStatus();
    if (acsStatus === 'connected' || acsStatus === 'connecting') {
      acsCaptionService.disconnect().catch(() => {});
    }
    useSessionStore.getState().setAcsStatus('off');

    timerService.stop();
    wsService.disconnect();
    audioService.stopCapture();
    audioService.destroy();
  };

  return { startServices, resumeServices, stopServices };
}
