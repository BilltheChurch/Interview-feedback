import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Draft feedback for instant first-screen render (<1s target).
 *
 * Architecture:
 * 1. During recording, the Worker DO builds a lightweight draft report every 60s
 * 2. On "End Session", the desktop immediately fetches the cached draft
 * 3. The draft renders instantly while full LLM finalization runs in background
 * 4. When the full report arrives, it seamlessly replaces the draft
 * 5. If Tier 2 is enabled, continues polling tier2-status after Tier 1 completes
 * 6. When Tier 2 completes, fetches the enhanced report and updates state
 */

type DraftStatus =
  | 'idle'
  | 'loading_draft'
  | 'draft_ready'
  | 'finalizing'
  | 'final_ready'
  | 'tier2_running'
  | 'tier2_ready'
  | 'error';

type Tier2Info = {
  enabled: boolean;
  status: string;
  progress: number;
  report_version: 'tier1_instant' | 'tier2_refined';
};

type UseDraftFeedbackOptions = {
  baseUrl: string;
  sessionId: string;
  /** Poll interval for checking finalization status (ms) */
  pollIntervalMs?: number;
};

type UseDraftFeedbackReturn = {
  status: DraftStatus;
  report: unknown | null;
  isDraft: boolean;
  isTier2Enhanced: boolean;
  tier2: Tier2Info | null;
  error: string | null;
  fetchDraft: () => Promise<void>;
  startFinalization: () => Promise<void>;
};

export function useDraftFeedback({
  baseUrl,
  sessionId,
  pollIntervalMs = 3000,
}: UseDraftFeedbackOptions): UseDraftFeedbackReturn {
  const [status, setStatus] = useState<DraftStatus>('idle');
  const [report, setReport] = useState<unknown | null>(null);
  const [isDraft, setIsDraft] = useState(false);
  const [isTier2Enhanced, setIsTier2Enhanced] = useState(false);
  const [tier2, setTier2] = useState<Tier2Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tier2PollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (tier2PollRef.current) clearInterval(tier2PollRef.current);
    };
  }, []);

  /**
   * Poll Tier 2 status after Tier 1 completes.
   * When Tier 2 finishes, fetch the refined report.
   */
  const startTier2Polling = useCallback(() => {
    if (!baseUrl || !sessionId) return;

    // Check initial tier2 status
    const checkTier2 = async () => {
      try {
        const result = await window.desktopAPI.getTier2Status({
          baseUrl,
          sessionId,
        });
        const data = result as Record<string, unknown>;
        if (!data || typeof data !== 'object') return;

        const tier2Status = data.status as string;
        const tier2Enabled = Boolean(data.enabled);
        const tier2Progress = typeof data.progress === 'number' ? data.progress : 0;
        const reportVersion = (data.report_version as string) || 'tier1_instant';

        setTier2({
          enabled: tier2Enabled,
          status: tier2Status,
          progress: tier2Progress,
          report_version: reportVersion as Tier2Info['report_version'],
        });

        if (!tier2Enabled || tier2Status === 'idle') {
          // Tier 2 not active — stop polling
          if (tier2PollRef.current) clearInterval(tier2PollRef.current);
          return;
        }

        if (tier2Status === 'succeeded') {
          if (tier2PollRef.current) clearInterval(tier2PollRef.current);

          // Fetch the enhanced report
          try {
            const fullResult = await window.desktopAPI.getResultV2({
              baseUrl,
              sessionId,
            });
            setReport(fullResult);
            setIsDraft(false);
            setIsTier2Enhanced(true);
            setStatus('tier2_ready');
          } catch {
            // If we can't fetch the enhanced report, keep tier1 report
          }
          return;
        }

        if (tier2Status === 'failed') {
          if (tier2PollRef.current) clearInterval(tier2PollRef.current);
          // Tier 2 failed, but tier1 report is still valid — just stop polling
          return;
        }

        // Still running — update UI status
        setStatus('tier2_running');
      } catch {
        // Tier 2 status not available — stop polling silently
        if (tier2PollRef.current) clearInterval(tier2PollRef.current);
      }
    };

    tier2PollRef.current = setInterval(checkTier2, pollIntervalMs);
    checkTier2(); // Initial check
  }, [baseUrl, sessionId, pollIntervalMs]);

  /**
   * Fetch the cached draft report for instant display.
   * Called immediately when the session ends.
   */
  const fetchDraft = useCallback(async () => {
    if (!baseUrl || !sessionId) return;

    setStatus('loading_draft');
    setError(null);

    try {
      const result = await window.desktopAPI.getFeedbackReady({
        baseUrl,
        sessionId,
      });

      const data = result as Record<string, unknown>;
      if (data && typeof data === 'object') {
        setReport(data);
        setIsDraft(true);
        setStatus('draft_ready');
      } else {
        // No draft available — go straight to finalization
        setStatus('idle');
      }
    } catch {
      // Draft not available is expected for short sessions
      setStatus('idle');
    }
  }, [baseUrl, sessionId]);

  /**
   * Trigger full LLM finalization and poll for completion.
   * The draft continues to display while this runs.
   */
  const startFinalization = useCallback(async () => {
    if (!baseUrl || !sessionId) return;

    setStatus('finalizing');
    setError(null);

    try {
      // Trigger finalization
      const finalizeResult = await window.desktopAPI.finalizeV2({
        baseUrl,
        sessionId,
      });

      const data = finalizeResult as Record<string, unknown>;
      jobIdRef.current = (data?.job_id as string) || null;

      // Start polling for completion
      pollRef.current = setInterval(async () => {
        try {
          const statusResult = await window.desktopAPI.getFinalizeStatus({
            baseUrl,
            sessionId,
            jobId: jobIdRef.current || undefined,
          });

          const statusData = statusResult as Record<string, unknown>;
          const finalizeStatus = statusData?.status as string;

          if (finalizeStatus === 'succeeded') {
            // Fetch the full result
            if (pollRef.current) clearInterval(pollRef.current);

            const fullResult = await window.desktopAPI.getResultV2({
              baseUrl,
              sessionId,
            });

            setReport(fullResult);
            setIsDraft(false);
            setStatus('final_ready');

            // Start Tier 2 polling after Tier 1 succeeds
            startTier2Polling();
          } else if (finalizeStatus === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            setError('Finalization failed');
            setStatus('error');
          }
          // Otherwise keep polling (status is 'running' or 'queued')
        } catch {
          // Poll error — keep trying
        }
      }, pollIntervalMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Finalization failed');
      setStatus('error');
    }
  }, [baseUrl, sessionId, pollIntervalMs, startTier2Polling]);

  return {
    status,
    report,
    isDraft,
    isTier2Enhanced,
    tier2,
    error,
    fetchDraft,
    startFinalization,
  };
}
