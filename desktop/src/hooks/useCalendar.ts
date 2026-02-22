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
    id: String(raw.id ?? ''),
    subject: String(raw.subject ?? raw.summary ?? ''),
    startTime: String(raw.startTime ?? raw.start ?? ''),
    endTime: String(raw.endTime ?? raw.end ?? ''),
    organizer: String(raw.organizer ?? ''),
    joinUrl: raw.joinUrl ? String(raw.joinUrl) : undefined,
  };
}

export function useCalendar(): UseCalendarReturn {
  const [status, setStatus] = useState<CalendarStatus>('loading');
  const [provider, setProvider] = useState<CalendarProvider>(null);
  const [meetings, setMeetings] = useState<CalendarMeeting[]>([]);
  const mountedRef = useRef(true);

  // Check auth state on mount — determines which provider (if any) is connected.
  // Falls back to 'disconnected' after 5s if IPC never resolves.
  useEffect(() => {
    mountedRef.current = true;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved && mountedRef.current) {
        resolved = true;
        setStatus('disconnected');
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
        } else if (state?.google?.connected) {
          setProvider('google');
          setStatus('connected');
        } else {
          setStatus('disconnected');
        }
      } catch {
        if (!resolved && mountedRef.current) {
          resolved = true;
          setStatus('disconnected');
        }
      }
    })();
    return () => {
      mountedRef.current = false;
      clearTimeout(timeout);
    };
  }, []);

  // Auto-fetch meetings when connected
  const refresh = useCallback(async () => {
    if (!provider) return;
    try {
      let result: { meetings?: Record<string, unknown>[] } | undefined;
      if (provider === 'microsoft') {
        result = await window.desktopAPI.calendarGetUpcomingMeetings({ days: 3 }) as typeof result;
      } else {
        result = await window.desktopAPI.googleGetUpcomingMeetings({ days: 3 }) as typeof result;
      }
      if (mountedRef.current && Array.isArray(result?.meetings)) {
        setMeetings(result.meetings.map(toCalendarMeeting));
      }
    } catch {
      // Non-fatal: keep current meetings list
    }
  }, [provider]);

  useEffect(() => {
    if (status === 'connected') {
      refresh();
    }
  }, [status, refresh]);

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
