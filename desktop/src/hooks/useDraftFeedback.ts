import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Draft feedback for instant first-screen render (<1s target).
 *
 * Architecture:
 * 1. During recording, the Worker DO builds a lightweight draft report every 60s
 * 2. On "End Session", the desktop immediately fetches the cached draft
 * 3. The draft renders instantly while full LLM finalization runs in background
 * 4. When the full report arrives, it seamlessly replaces the draft
 */

type DraftStatus = 'idle' | 'loading_draft' | 'draft_ready' | 'finalizing' | 'final_ready' | 'error';

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
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

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
    } catch (err) {
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
  }, [baseUrl, sessionId, pollIntervalMs]);

  return {
    status,
    report,
    isDraft,
    error,
    fetchDraft,
    startFinalization,
  };
}
