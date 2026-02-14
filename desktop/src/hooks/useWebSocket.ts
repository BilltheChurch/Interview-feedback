import { useState, useRef, useCallback, useEffect } from 'react';

/* ── Types ─────────────────────────────────── */

export type WebSocketStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export type StreamRole = 'teacher' | 'students';

export type UseWebSocketOptions = {
  baseWsUrl: string;
  sessionId: string;
  sampleRate?: number;
  channels?: number;
  format?: string;
  interviewerName?: string;
  teamsInterviewerName?: string;
  participants?: Array<{ name: string }>;
};

export type UseWebSocketReturn = {
  status: Record<StreamRole, WebSocketStatus>;
  connect: () => Promise<void>;
  disconnect: (reason?: string) => void;
  sendAudioChunk: (role: StreamRole, chunk: ArrayBuffer, seq: number) => void;
  sendMark: (role: StreamRole, mark: Record<string, unknown>) => void;
  sendEnrollment: (role: StreamRole, data: Record<string, unknown>) => void;
  isConnected: boolean;
  lastError: string | null;
};

/* ── Constants ─────────────────────────────── */

const STREAM_ROLES: StreamRole[] = ['teacher', 'students'];
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000];

/* ── Helpers ───────────────────────────────── */

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function buildWsUrl(baseWsUrl: string, sessionId: string, role: StreamRole): string {
  const base = baseWsUrl.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(sessionId)}/${role}`;
}

/* ── Hook ──────────────────────────────────── */

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const {
    baseWsUrl,
    sessionId,
    sampleRate = 16000,
    channels = 1,
    format = 'pcm_s16le',
    interviewerName,
    teamsInterviewerName,
    participants,
  } = options;

  const [status, setStatus] = useState<Record<StreamRole, WebSocketStatus>>({
    teacher: 'disconnected',
    students: 'disconnected',
  });
  const [lastError, setLastError] = useState<string | null>(null);

  // Mutable refs for WebSocket instances and reconnection state
  const socketsRef = useRef<Record<StreamRole, WebSocket | null>>({
    teacher: null,
    students: null,
  });
  const readyRef = useRef<Record<StreamRole, boolean>>({
    teacher: false,
    students: false,
  });
  const reconnectAttemptsRef = useRef<Record<StreamRole, number>>({
    teacher: 0,
    students: 0,
  });
  const reconnectTimersRef = useRef<Record<StreamRole, ReturnType<typeof setTimeout> | null>>({
    teacher: null,
    students: null,
  });
  const closingRef = useRef<Record<StreamRole, boolean>>({
    teacher: false,
    students: false,
  });
  const mountedRef = useRef(true);

  /* -- status setter (safe for unmounted) -- */
  const setRoleStatus = useCallback((role: StreamRole, s: WebSocketStatus) => {
    if (!mountedRef.current) return;
    setStatus((prev) => (prev[role] === s ? prev : { ...prev, [role]: s }));
  }, []);

  /* -- open a single stream -- */
  const openSocket = useCallback(
    (role: StreamRole): Promise<void> => {
      return new Promise((resolve, reject) => {
        const url = buildWsUrl(baseWsUrl, sessionId, role);
        setRoleStatus(role, 'connecting');

        const ws = new WebSocket(url);
        socketsRef.current[role] = ws;
        readyRef.current[role] = false;
        closingRef.current[role] = false;

        let settled = false;

        const onOpen = () => {
          if (settled) return;
          settled = true;
          ws.removeEventListener('error', onError);

          // Send hello handshake
          ws.send(
            JSON.stringify({
              type: 'hello',
              stream_role: role,
              meeting_id: sessionId,
              sample_rate: sampleRate,
              channels,
              format,
              capture_mode: 'dual_stream',
              interviewer_name: interviewerName,
              teams_interviewer_name: teamsInterviewerName,
              teams_participants: participants,
            }),
          );
          resolve();
        };

        const onError = () => {
          if (settled) return;
          settled = true;
          ws.removeEventListener('open', onOpen);
          setRoleStatus(role, 'error');
          setLastError(`${role} websocket open failed`);
          reject(new Error(`${role} websocket open failed`));
        };

        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });

        // Bind ongoing events
        ws.addEventListener('message', (event: MessageEvent) => {
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(event.data as string);
          } catch {
            return;
          }

          if (payload.type === 'ready') {
            readyRef.current[role] = true;
            reconnectAttemptsRef.current[role] = 0;
            setRoleStatus(role, 'connected');
          }
        });

        ws.addEventListener('close', () => {
          if (socketsRef.current[role] !== ws) return;
          socketsRef.current[role] = null;
          readyRef.current[role] = false;

          if (closingRef.current[role]) {
            // Intentional close
            setRoleStatus(role, 'disconnected');
            closingRef.current[role] = false;
          } else {
            // Unexpected close — schedule reconnect
            scheduleReconnect(role);
          }
        });

        ws.addEventListener('error', () => {
          if (!settled) return; // Initial error already handled
          setLastError(`${role} websocket error`);
          setRoleStatus(role, 'error');
        });
      });
    },
    [baseWsUrl, sessionId, sampleRate, channels, format, interviewerName, teamsInterviewerName, participants, setRoleStatus],
  );

  /* -- reconnection with exponential backoff -- */
  const scheduleReconnect = useCallback(
    (role: StreamRole) => {
      if (!mountedRef.current || closingRef.current[role]) return;

      const attempts = reconnectAttemptsRef.current[role];
      const idx = Math.min(RECONNECT_BACKOFF_MS.length - 1, attempts);
      const delay = RECONNECT_BACKOFF_MS[idx];
      reconnectAttemptsRef.current[role] = attempts + 1;

      setRoleStatus(role, 'reconnecting');

      reconnectTimersRef.current[role] = setTimeout(() => {
        if (!mountedRef.current || closingRef.current[role]) return;
        openSocket(role).catch(() => {
          // openSocket rejection will trigger error state,
          // next close event will schedule another reconnect
        });
      }, delay);
    },
    [openSocket, setRoleStatus],
  );

  /* -- close a single stream -- */
  const closeSocket = useCallback(
    (role: StreamRole, reason: string) => {
      // Cancel pending reconnection
      if (reconnectTimersRef.current[role]) {
        clearTimeout(reconnectTimersRef.current[role]!);
        reconnectTimersRef.current[role] = null;
      }

      const ws = socketsRef.current[role];
      if (!ws) {
        setRoleStatus(role, 'disconnected');
        return;
      }

      closingRef.current[role] = true;

      // Best-effort: send close frame to server
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'close', stream_role: role, reason }));
        }
      } catch {
        // noop
      }

      try {
        ws.close(1000, reason.slice(0, 120));
      } catch {
        // noop
      }

      // Fallback timer in case close event never fires
      setTimeout(() => {
        if (socketsRef.current[role] === ws) {
          socketsRef.current[role] = null;
          readyRef.current[role] = false;
          closingRef.current[role] = false;
          setRoleStatus(role, 'disconnected');
        }
      }, 1500);
    },
    [setRoleStatus],
  );

  /* ── Public API ─────────────────────────── */

  const connect = useCallback(async () => {
    setLastError(null);
    await Promise.all(STREAM_ROLES.map((role) => openSocket(role)));
  }, [openSocket]);

  const disconnect = useCallback(
    (reason = 'client-stop') => {
      STREAM_ROLES.forEach((role) => closeSocket(role, reason));
    },
    [closeSocket],
  );

  const sendAudioChunk = useCallback(
    (role: StreamRole, chunk: ArrayBuffer, seq: number) => {
      const ws = socketsRef.current[role];
      if (!ws || ws.readyState !== WebSocket.OPEN || !readyRef.current[role]) return;

      ws.send(
        JSON.stringify({
          type: 'chunk',
          stream_role: role,
          meeting_id: sessionId,
          seq,
          timestamp_ms: Date.now(),
          sample_rate: sampleRate,
          channels,
          format,
          content_b64: arrayBufferToBase64(chunk),
        }),
      );
    },
    [sessionId, sampleRate, channels, format],
  );

  const sendMark = useCallback(
    (role: StreamRole, mark: Record<string, unknown>) => {
      const ws = socketsRef.current[role];
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'mark', stream_role: role, ...mark }));
    },
    [],
  );

  const sendEnrollment = useCallback(
    (role: StreamRole, data: Record<string, unknown>) => {
      const ws = socketsRef.current[role];
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'enrollment', stream_role: role, ...data }));
    },
    [],
  );

  const isConnected =
    status.teacher === 'connected' && status.students === 'connected';

  /* ── Cleanup on unmount ─────────────────── */

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      STREAM_ROLES.forEach((role) => {
        if (reconnectTimersRef.current[role]) {
          clearTimeout(reconnectTimersRef.current[role]!);
        }
        const ws = socketsRef.current[role];
        if (ws) {
          try {
            ws.close(1000, 'unmount');
          } catch {
            // noop
          }
          socketsRef.current[role] = null;
        }
      });
    };
  }, []);

  return {
    status,
    connect,
    disconnect,
    sendAudioChunk,
    sendMark,
    sendEnrollment,
    isConnected,
    lastError,
  };
}
