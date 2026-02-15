import { useSessionStore } from '../stores/sessionStore';

class TimerService {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      useSessionStore.getState().tick();
    }, 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  reset(): void {
    this.stop();
  }
}

export const timerService = new TimerService();
