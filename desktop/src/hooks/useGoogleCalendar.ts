import { useState, useEffect, useCallback, useRef } from 'react';

type CalendarMeeting = {
  id: string;
  subject: string;
  startTime: string;
  endTime: string;
  joinUrl?: string;
};

type GoogleStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type UseGoogleCalendarReturn = {
  status: GoogleStatus;
  email: string;
  meetings: CalendarMeeting[];
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

function toCalendarMeeting(raw: Record<string, unknown>): CalendarMeeting {
  return {
    id: String(raw.meeting_id ?? raw.id ?? ''),
    subject: String(raw.title ?? raw.subject ?? ''),
    startTime: String(raw.start_at ?? raw.startTime ?? ''),
    endTime: String(raw.end_at ?? raw.endTime ?? ''),
    joinUrl: raw.join_url ? String(raw.join_url) : undefined,
  };
}

export function useGoogleCalendar(): UseGoogleCalendarReturn {
  const [status, setStatus] = useState<GoogleStatus>('disconnected');
  const [email, setEmail] = useState('');
  const [meetings, setMeetings] = useState<CalendarMeeting[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const result = await window.desktopAPI.googleGetStatus();
        if (mountedRef.current) {
          setStatus(result?.connected ? 'connected' : 'disconnected');
          setEmail(result?.account?.email || '');
        }
      } catch {
        if (mountedRef.current) setStatus('error');
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const connect = useCallback(async () => {
    try {
      setStatus('connecting');
      const result = await window.desktopAPI.googleConnect();
      if (mountedRef.current) {
        setStatus('connected');
        setEmail(result?.account?.email || '');
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await window.desktopAPI.googleDisconnect();
      if (mountedRef.current) {
        setStatus('disconnected');
        setEmail('');
        setMeetings([]);
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = (await window.desktopAPI.googleGetUpcomingMeetings({
        days: 3,
      })) as { meetings?: Record<string, unknown>[] };
      if (mountedRef.current && Array.isArray(result?.meetings)) {
        setMeetings(result.meetings.map(toCalendarMeeting));
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  return {
    status,
    email,
    meetings,
    connect,
    disconnect,
    refresh,
  };
}
