import { useState, useRef, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useSessionStore } from '../stores/sessionStore';
import { StatusDot } from './ui/StatusDot';
import { MeterBar } from './ui/MeterBar';

/* ── Helpers ────────────────────────────────── */

function formatTimer(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ── PipOverlay ─────────────────────────────── */

export function PipOverlay() {
  const status = useSessionStore((s) => s.status);
  const elapsed = useSessionStore((s) => s.elapsedSeconds);
  const audioLevels = useSessionStore((s) => s.audioLevels);
  const currentStage = useSessionStore((s) => s.currentStage);
  const stages = useSessionStore((s) => s.stages);

  const location = useLocation();
  const navigate = useNavigate();

  // Suppress PiP for 300ms when status transitions to 'recording' to avoid
  // flash before React Router processes the navigate('/session') call
  const [suppressed, setSuppressed] = useState(false);
  const prevStatusRef = useRef(status);

  useEffect(() => {
    if (prevStatusRef.current !== 'recording' && status === 'recording') {
      setSuppressed(true);
      prevStatusRef.current = status;
      const t = setTimeout(() => setSuppressed(false), 300);
      return () => clearTimeout(t);
    }
    prevStatusRef.current = status;
  }, [status]);

  const visible = status === 'recording' && location.pathname !== '/session' && !suppressed;

  // Drag state
  const [pos, setPos] = useState({ x: 16, y: 16 }); // offset from bottom-right
  const dragging = useRef(false);
  const dragStart = useRef({ px: 0, py: 0, ox: 0, oy: 0 });
  const didDrag = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      didDrag.current = false;
      dragStart.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = dragStart.current.px - e.clientX;
    const dy = dragStart.current.py - e.clientY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
    setPos({
      x: Math.max(0, dragStart.current.ox + dx),
      y: Math.max(0, dragStart.current.oy + dy),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    if (!didDrag.current) {
      navigate('/session');
    }
  }, [navigate]);

  const stageName = stages[currentStage] ?? '';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.85, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.85, y: 20 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="fixed z-50 w-[240px] select-none bg-surface/90 backdrop-blur-md border border-border shadow-lg rounded-2xl p-3 cursor-grab active:cursor-grabbing"
          style={{ bottom: pos.y, right: pos.x }}
        >
          {/* Row 1: status dot + timer */}
          <div className="flex items-center gap-2 mb-2">
            <StatusDot status="recording" />
            <span className="text-xs font-medium text-ink">Recording</span>
            <span className="ml-auto text-sm font-mono text-ink-secondary tabular-nums">
              {formatTimer(elapsed)}
            </span>
          </div>

          {/* Row 2-3: audio meters (compact) */}
          <div className="space-y-1 mb-2">
            <MeterBar label="Mic" value={audioLevels.mic} />
            <MeterBar label="System" value={audioLevels.system} />
          </div>

          {/* Row 4: current stage */}
          {stageName && (
            <div className="text-xs text-ink-tertiary truncate">
              Stage: <span className="text-accent font-medium">{stageName}</span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
