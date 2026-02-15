import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import type { SessionConfig } from '../stores/sessionStore';
import { audioService } from '../services/AudioService';
import { wsService } from '../services/WebSocketService';
import { timerService } from '../services/TimerService';

export function useSessionOrchestrator() {
  const navigate = useNavigate();

  const start = async (config: SessionConfig) => {
    const store = useSessionStore.getState();
    store.startSession(config);

    await audioService.initMic();
    try {
      await audioService.initSystem();
    } catch {
      // System audio is non-fatal (user may cancel screen picker)
    }
    audioService.startCapture();

    await wsService.connect({
      baseWsUrl: config.baseApiUrl.replace(/^http/, 'ws'),
      sessionId: config.sessionId,
      interviewerName: config.interviewerName,
      teamsInterviewerName: config.teamsInterviewerName,
      participants: config.participants,
    });

    timerService.start();
  };

  const end = () => {
    const store = useSessionStore.getState();
    const sessionId = store.sessionId;

    timerService.stop();
    wsService.disconnect();
    audioService.stopCapture();

    store.endSession();
    navigate(`/feedback/${sessionId}`);

    // Defer full cleanup so navigation completes first
    setTimeout(() => {
      audioService.destroy();
      useSessionStore.getState().reset();
    }, 100);
  };

  return { start, end };
}
