import { useState, useEffect, useCallback, useRef } from 'react';

type CalendarMeeting = {
  id: string;
  subject: string;
  startTime: string;
  endTime: string;
  organizer: string;
  joinUrl?: string;
};

type GraphStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type UseGraphCalendarReturn = {
  status: GraphStatus;
  meetings: CalendarMeeting[];
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  createMeeting: (opts: {
    subject: string;
    startAt: string;
    endAt: string;
    participants?: string[];
  }) => Promise<CalendarMeeting | null>;
  setConfig: (clientId: string, tenantId?: string) => Promise<void>;
};

function toCalendarMeeting(raw: Record<string, unknown>): CalendarMeeting {
  return {
    id: String(raw.id ?? ''),
    subject: String(raw.subject ?? ''),
    startTime: String(raw.startTime ?? raw.start ?? ''),
    endTime: String(raw.endTime ?? raw.end ?? ''),
    organizer: String(raw.organizer ?? ''),
    joinUrl: raw.joinUrl ? String(raw.joinUrl) : undefined,
  };
}

export function useGraphCalendar(): UseGraphCalendarReturn {
  const [status, setStatus] = useState<GraphStatus>('disconnected');
  const [meetings, setMeetings] = useState<CalendarMeeting[]>([]);
  const mountedRef = useRef(true);

  // Fetch initial status on mount
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const result = (await window.desktopAPI.calendarGetStatus()) as {
          configured?: boolean;
          connected?: boolean;
        };
        if (mountedRef.current) {
          if (result?.connected) {
            setStatus('connected');
          } else if (result?.configured) {
            setStatus('disconnected');
          }
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
      await window.desktopAPI.calendarConnectMicrosoft();
      if (mountedRef.current) setStatus('connected');
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await window.desktopAPI.calendarDisconnectMicrosoft();
      if (mountedRef.current) {
        setStatus('disconnected');
        setMeetings([]);
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = (await window.desktopAPI.calendarGetUpcomingMeetings({
        days: 3,
      })) as { meetings?: Record<string, unknown>[] };
      if (mountedRef.current && Array.isArray(result?.meetings)) {
        setMeetings(result.meetings.map(toCalendarMeeting));
      }
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, []);

  const createMeeting = useCallback(
    async (opts: {
      subject: string;
      startAt: string;
      endAt: string;
      participants?: string[];
    }): Promise<CalendarMeeting | null> => {
      try {
        const payload = {
          ...opts,
          participants: opts.participants?.map((p) => ({ name: p })),
        };
        const result =
          (await window.desktopAPI.calendarCreateOnlineMeeting(payload)) as Record<
            string,
            unknown
          > | null;
        if (result) {
          const meeting = toCalendarMeeting(result);
          if (mountedRef.current) {
            setMeetings((prev) => [...prev, meeting]);
          }
          return meeting;
        }
        return null;
      } catch {
        if (mountedRef.current) setStatus('error');
        return null;
      }
    },
    [],
  );

  const setConfig = useCallback(
    async (clientId: string, tenantId?: string) => {
      try {
        await window.desktopAPI.calendarSetConfig({ clientId, tenantId });
      } catch {
        if (mountedRef.current) setStatus('error');
      }
    },
    [],
  );

  return {
    status,
    meetings,
    connect,
    disconnect,
    refresh,
    createMeeting,
    setConfig,
  };
}
