import { useState, useEffect, useCallback, useRef } from 'react';

type CalendarMeeting = {
  id: string;
  subject: string;
  startTime: string;
  endTime: string;
  organizer: string;
  joinUrl?: string;
};

type CalendarStatus = 'loading' | 'disconnected' | 'connecting' | 'connected' | 'error';
type CalendarProvider = 'microsoft' | 'google' | null;

type UseCalendarReturn = {
  status: CalendarStatus;
  provider: CalendarProvider;
  meetings: CalendarMeeting[];
  connectMicrosoft: () => Promise<void>;
  connectGoogle: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

function toCalendarMeeting(raw: Record<string, unknown>): CalendarMeeting {
  return {
    id: String(raw.meeting_id ?? raw.id ?? ''),
    subject: String(raw.title ?? raw.subject ?? raw.summary ?? ''),
    startTime: String(raw.start_at ?? raw.startTime ?? raw.start ?? ''),
    endTime: String(raw.end_at ?? raw.endTime ?? raw.end ?? ''),
    organizer: String(raw.organizer ?? ''),
    joinUrl: raw.join_url ? String(raw.join_url) : (raw.joinUrl ? String(raw.joinUrl) : undefined),
  };
}

// Module-level cache to avoid re-fetching on every navigation
let cachedStatus: CalendarStatus | null = null;
let cachedProvider: CalendarProvider = null;
let cachedMeetings: CalendarMeeting[] = [];
let cacheTimestamp = 0;
const CACHE_TTL = 30_000; // 30 seconds (reduced for auto-refresh)
const POLL_INTERVAL = 30_000; // Poll every 30 seconds

export function useCalendar(): UseCalendarReturn {
  const [status, setStatus] = useState<CalendarStatus>(cachedStatus ?? 'loading');
  const [provider, setProvider] = useState<CalendarProvider>(cachedProvider);
  const [meetings, setMeetings] = useState<CalendarMeeting[]>(cachedMeetings);
  const mountedRef = useRef(true);
  const providerRef = useRef(provider);
  providerRef.current = provider;

  // Check auth state on mount — determines which provider (if any) is connected.
  // Uses module-level cache to avoid flicker on repeated navigation.
  useEffect(() => {
    mountedRef.current = true;

    // If cache is fresh, skip the auth check
    if (cachedStatus && Date.now() - cacheTimestamp < CACHE_TTL) {
      return () => { mountedRef.current = false; };
    }

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved && mountedRef.current) {
        resolved = true;
        setStatus('disconnected');
        cachedStatus = 'disconnected';
      }
    }, 5000);

    (async () => {
      try {
        const state = await window.desktopAPI.authGetState();
        if (resolved || !mountedRef.current) return;
        resolved = true;

        if (state?.microsoft?.connected) {
          setProvider('microsoft');
          setStatus('connected');
          cachedProvider = 'microsoft';
          cachedStatus = 'connected';
        } else if (state?.google?.connected) {
          setProvider('google');
          setStatus('connected');
          cachedProvider = 'google';
          cachedStatus = 'connected';
        } else {
          setStatus('disconnected');
          cachedStatus = 'disconnected';
        }
        cacheTimestamp = Date.now();
      } catch {
        if (!resolved && mountedRef.current) {
          resolved = true;
          setStatus('disconnected');
          cachedStatus = 'disconnected';
        }
      }
    })();
    return () => {
      mountedRef.current = false;
      clearTimeout(timeout);
    };
  }, []);

  // Shared fetch logic (used by refresh, auto-poll, and focus handler)
  const fetchMeetings = useCallback(async () => {
    const p = providerRef.current;
    if (!p) return;
    try {
      let result: { meetings?: Record<string, unknown>[] } | undefined;
      if (p === 'microsoft') {
        result = await window.desktopAPI.calendarGetUpcomingMeetings({ days: 3 }) as typeof result;
      } else {
        result = await window.desktopAPI.googleGetUpcomingMeetings({ days: 3 }) as typeof result;
      }
      if (mountedRef.current && Array.isArray(result?.meetings)) {
        const mapped = result.meetings.map(toCalendarMeeting);
        setMeetings(mapped);
        cachedMeetings = mapped;
        cacheTimestamp = Date.now();
      }
    } catch {
      // Non-fatal: keep current meetings list
    }
  }, []);

  // Manual refresh — invalidates cache then fetches
  const refresh = useCallback(async () => {
    cacheTimestamp = 0;
    await fetchMeetings();
  }, [fetchMeetings]);

  // Auto-fetch on first connect or stale cache
  useEffect(() => {
    if (status === 'connected' && (cachedMeetings.length === 0 || Date.now() - cacheTimestamp > CACHE_TTL)) {
      fetchMeetings();
    }
  }, [status, fetchMeetings]);

  // ── Auto-refresh: poll every 30s when connected ──
  useEffect(() => {
    if (status !== 'connected') return;

    const interval = setInterval(() => {
      if (mountedRef.current) fetchMeetings();
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [status, fetchMeetings]);

  // ── Refresh on window focus (user switches back from Teams) ──
  useEffect(() => {
    if (status !== 'connected') return;

    const handleFocus = () => {
      // Only refresh if cache is older than 10 seconds (debounce rapid focus events)
      if (mountedRef.current && Date.now() - cacheTimestamp > 10_000) {
        fetchMeetings();
      }
    };

    window.addEventListener('focus', handleFocus);
    // Also handle visibility change (e.g. minimized → restored)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') handleFocus();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [status, fetchMeetings]);

  const connectMicrosoft = useCallback(async () => {
    try {
      setStatus('connecting');
      await window.desktopAPI.calendarConnectMicrosoft();
      if (mountedRef.current) {
        setProvider('microsoft');
        setStatus('connected');
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  const connectGoogle = useCallback(async () => {
    try {
      setStatus('connecting');
      await window.desktopAPI.googleConnect();
      if (mountedRef.current) {
        setProvider('google');
        setStatus('connected');
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      if (provider === 'microsoft') {
        await window.desktopAPI.calendarDisconnectMicrosoft();
      } else if (provider === 'google') {
        await window.desktopAPI.googleDisconnect();
      }
      if (mountedRef.current) {
        setProvider(null);
        setStatus('disconnected');
        setMeetings([]);
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, [provider]);

  return { status, provider, meetings, connectMicrosoft, connectGoogle, disconnect, refresh };
}
