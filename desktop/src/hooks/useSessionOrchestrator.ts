import type { SessionConfig, PersistedSession } from '../stores/sessionStore';
import { useServiceLifecycle } from './useServiceLifecycle';
import { useSessionFlow } from './useSessionFlow';

/**
 * Composes useServiceLifecycle + useSessionFlow to provide the unified
 * session orchestration API consumed by SidecarView and HomeView.
 *
 * Public API is unchanged: { start, end, resume }
 */
export function useSessionOrchestrator() {
  const { startServices, resumeServices, stopServices } = useServiceLifecycle();
  const { beginSession, endSession, restoreSession } = useSessionFlow();

  const start = async (config: SessionConfig) => {
    await beginSession(config);
    await startServices(config);
  };

  const end = () => {
    endSession(stopServices);
  };

  const resume = async (persisted: PersistedSession) => {
    await restoreSession(persisted);
    await resumeServices(persisted);
    console.log('[Orchestrator] Session resumed:', persisted.sessionId);
  };

  return { start, end, resume };
}
