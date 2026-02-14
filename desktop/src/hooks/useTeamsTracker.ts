import { useState, useEffect, useCallback, useRef } from 'react';

type TeamsStatus =
  | 'detached'
  | 'searching'
  | 'attached'
  | 'teams_not_found'
  | 'permission_required'
  | 'error';

type UseTeamsTrackerReturn = {
  status: TeamsStatus;
  attach: () => Promise<void>;
  detach: () => Promise<void>;
  isAttached: boolean;
};

export function useTeamsTracker(
  options: { autoAttach?: boolean } = {},
): UseTeamsTrackerReturn {
  const { autoAttach = false } = options;
  const [status, setStatus] = useState<TeamsStatus>('detached');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const pollStatus = useCallback(async () => {
    try {
      const result = (await window.desktopAPI.getAttachStatus()) as {
        status?: TeamsStatus;
      };
      if (mountedRef.current && result?.status) {
        setStatus(result.status);
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(pollStatus, 2000);
  }, [pollStatus]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const attach = useCallback(async () => {
    try {
      setStatus('searching');
      await window.desktopAPI.attachToTeams();
      await pollStatus();
      startPolling();
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, [pollStatus, startPolling]);

  const detach = useCallback(async () => {
    try {
      stopPolling();
      await window.desktopAPI.detachFromTeams();
      if (mountedRef.current) setStatus('detached');
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, [stopPolling]);

  useEffect(() => {
    mountedRef.current = true;
    if (autoAttach) {
      attach();
    }
    return () => {
      mountedRef.current = false;
      stopPolling();
      window.desktopAPI.detachFromTeams().catch(() => {});
    };
  }, [autoAttach, attach, stopPolling]);

  return {
    status,
    attach,
    detach,
    isAttached: status === 'attached',
  };
}
