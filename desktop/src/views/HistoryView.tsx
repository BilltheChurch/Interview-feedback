import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  Clock,
  User,
  Users,
  FileText,
  Search,
  ChevronRight,
  ArrowLeft,
  Trash2,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { StoredSessionRecord } from '../types/stored-session';

/* ─── Types ─────────────────────────────────── */

type SessionRecord = {
  id: string;
  name: string;
  date: string;
  mode: '1v1' | 'group';
  participantCount: number;
  status: 'completed' | 'finalized' | 'draft' | 'failed';
};

type FilterStatus = 'all' | 'completed' | 'finalized' | 'draft' | 'failed';

/* ─── localStorage helpers ──────────────────── */

function getStoredSessions(): SessionRecord[] {
  try {
    const stored = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
    return stored.map((s: StoredSessionRecord) => ({
      id: s.id,
      name: s.name,
      date: s.date,
      mode: s.mode || '1v1',
      participantCount: s.participantCount || 0,
      status: s.status === 'in_progress' ? 'draft' as const
        : (s.status === 'finalized' || s.status === 'completed' || s.status === 'draft' || s.status === 'failed')
          ? s.status as SessionRecord['status']
          : 'completed' as const,
    }));
  } catch {
    return [];
  }
}

function removeSessionFromStorage(sessionId: string): void {
  try {
    const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
    const updated = sessions.filter((s: StoredSessionRecord) => s.id !== sessionId);
    localStorage.setItem('ifb_sessions', JSON.stringify(updated));
  } catch { /* ignore */ }
  try {
    localStorage.removeItem(`ifb_session_data_${sessionId}`);
  } catch { /* ignore */ }
}

function clearAllSessionsFromStorage(sessionIds: string[]): void {
  try {
    localStorage.setItem('ifb_sessions', '[]');
  } catch { /* ignore */ }
  for (const id of sessionIds) {
    try {
      localStorage.removeItem(`ifb_session_data_${id}`);
    } catch { /* ignore */ }
  }
}

/* ─── Date grouping helper ─────────────────── */

function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  if (date >= weekAgo) return 'This Week';
  return 'Earlier';
}

function groupByDate(sessions: SessionRecord[]): { label: string; sessions: SessionRecord[] }[] {
  const order = ['Today', 'Yesterday', 'This Week', 'Earlier'];
  const groups = new Map<string, SessionRecord[]>();

  for (const session of sessions) {
    const label = getDateGroup(session.date);
    const arr = groups.get(label) || [];
    arr.push(session);
    groups.set(label, arr);
  }

  return order
    .filter((label) => groups.has(label))
    .map((label) => ({ label, sessions: groups.get(label)! }));
}

/* ─── Status config ─────────────────────────── */

const statusConfig: Record<SessionRecord['status'], { label: string; variant: 'success' | 'warning' | 'error' | 'default' }> = {
  completed: { label: 'Completed', variant: 'default' },
  finalized: { label: 'Finalized', variant: 'success' },
  draft: { label: 'Draft', variant: 'warning' },
  failed: { label: 'Failed', variant: 'error' },
};

/* ─── Filter Chips ──────────────────────────── */

const filterOptions: { value: FilterStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'finalized', label: 'Finalized' },
  { value: 'completed', label: 'Completed' },
  { value: 'draft', label: 'Draft' },
  { value: 'failed', label: 'Failed' },
];

function FilterChips({
  active,
  onChange,
  counts,
}: {
  active: FilterStatus;
  onChange: (v: FilterStatus) => void;
  counts: Record<FilterStatus, number>;
}) {
  return (
    <div className="flex gap-2 mb-4">
      {filterOptions.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={`
            inline-flex items-center gap-1 rounded-[--radius-pill] border
            text-xs font-medium px-3 py-1.5 transition-colors duration-150 cursor-pointer
            ${active === value
              ? 'bg-accent text-white border-accent'
              : 'bg-surface text-ink-secondary border-border hover:bg-surface-hover'
            }
          `}
        >
          {label}
          <span className={`text-xs ${active === value ? 'text-white/70' : 'text-ink-tertiary'}`}>
            {counts[value]}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ─── Confirm Delete Dialog ────────────────── */

function ConfirmDeleteDialog({
  title,
  message,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
    >
      <motion.div
        className="bg-surface rounded-[--radius-card] border border-border shadow-lg p-6 max-w-sm w-full mx-4"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-ink mb-2">{title}</h3>
        <p className="text-sm text-ink-secondary mb-5">{message}</p>
        <div className="flex gap-3 justify-end">
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ─── SessionRow ────────────────────────────── */

function SessionRow({
  session,
  onClick,
  onDelete,
}: {
  session: SessionRecord;
  onClick: () => void;
  onDelete: () => void;
}) {
  const ModeIcon = session.mode === '1v1' ? User : Users;
  const cfg = statusConfig[session.status];

  return (
    <motion.div
      whileHover={{ y: -2, transition: { duration: 0.15 } }}
    >
      <Card
        hoverable
        className="p-5 flex items-center gap-4 cursor-pointer group"
        onClick={onClick}
      >
        {/* Mode icon */}
        <div className="w-9 h-9 rounded-lg bg-accent-soft flex items-center justify-center shrink-0">
          <ModeIcon className="w-4 h-4 text-accent" />
        </div>

        {/* Session info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink truncate">{session.name}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-ink-tertiary">{session.date}</span>
            <span className="text-xs text-ink-tertiary">·</span>
            <span className="text-xs text-ink-tertiary">
              {session.participantCount} {session.participantCount === 1 ? 'participant' : 'participants'}
            </span>
          </div>
        </div>

        {/* Status label */}
        <Chip variant={cfg.variant}>{cfg.label}</Chip>

        {/* Delete button — visible on hover */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-tertiary
                     opacity-0 group-hover:opacity-100 hover:text-error hover:bg-red-50
                     transition-all duration-150 cursor-pointer shrink-0"
          aria-label={`Delete ${session.name}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>

        {/* Arrow */}
        <ChevronRight className="w-4 h-4 text-ink-tertiary shrink-0" />
      </Card>
    </motion.div>
  );
}

/* ─── HistoryView (main export) ─────────────── */

export function HistoryView() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterStatus>('all');

  // Reactive session list — useState instead of useMemo so deletes cause re-render
  const [allSessions, setAllSessions] = useState<SessionRecord[]>(() => getStoredSessions());

  // Confirm dialog state
  const [confirmDelete, setConfirmDelete] = useState<{
    type: 'single' | 'all';
    session?: SessionRecord;
  } | null>(null);

  const counts = useMemo<Record<FilterStatus, number>>(() => ({
    all: allSessions.length,
    finalized: allSessions.filter((s) => s.status === 'finalized').length,
    completed: allSessions.filter((s) => s.status === 'completed').length,
    draft: allSessions.filter((s) => s.status === 'draft').length,
    failed: allSessions.filter((s) => s.status === 'failed').length,
  }), [allSessions]);

  const filtered = useMemo(() => {
    let result = allSessions;
    if (filter !== 'all') {
      result = result.filter((s) => s.status === filter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((s) => s.name.toLowerCase().includes(q));
    }
    return result;
  }, [allSessions, filter, search]);

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);

  const handleDeleteSession = useCallback((session: SessionRecord) => {
    setConfirmDelete({ type: 'single', session });
  }, []);

  const handleClearAll = useCallback(() => {
    setConfirmDelete({ type: 'all' });
  }, []);

  const executeDelete = useCallback(() => {
    if (!confirmDelete) return;

    if (confirmDelete.type === 'single' && confirmDelete.session) {
      removeSessionFromStorage(confirmDelete.session.id);
      setAllSessions((prev) => prev.filter((s) => s.id !== confirmDelete.session!.id));
    } else if (confirmDelete.type === 'all') {
      clearAllSessionsFromStorage(allSessions.map((s) => s.id));
      setAllSessions([]);
    }

    setConfirmDelete(null);
  }, [confirmDelete, allSessions]);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        {/* Header */}
        <motion.div
          className="mb-6 flex items-start gap-3"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <button
            onClick={() => navigate('/')}
            className="text-ink-tertiary hover:text-ink transition-colors duration-150 cursor-pointer mt-1"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-semibold text-ink">Session History</h1>
            <p className="text-sm text-ink-secondary">Review past interview sessions and reports</p>
          </div>
          {allSessions.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleClearAll}>
              <Trash2 className="w-3.5 h-3.5" />
              Clear All
            </Button>
          )}
        </motion.div>

        {/* Search */}
        <div className="mb-4 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-tertiary pointer-events-none" />
          <input
            type="text"
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-[--radius-pill] bg-surface text-ink placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-all duration-200"
          />
        </div>

        {/* Filter chips */}
        <FilterChips active={filter} onChange={setFilter} counts={counts} />

        {/* Session list grouped by date */}
        {filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <EmptyState
              icon={Clock}
              title={allSessions.length === 0 ? 'No sessions yet' : 'No sessions found'}
              description={
                allSessions.length === 0
                  ? 'Your completed sessions will appear here after your first interview'
                  : search
                    ? 'Try a different search term'
                    : 'No sessions match this filter'
              }
            />
          </motion.div>
        ) : (
          <motion.div
            className="space-y-6"
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
          >
            {grouped.map(({ label, sessions }) => (
              <div key={label}>
                <motion.h2
                  variants={staggerItem}
                  className="text-xs font-semibold text-ink-tertiary uppercase tracking-wider mb-2 px-1"
                >
                  {label}
                </motion.h2>
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {sessions.map((session) => (
                      <motion.div
                        key={session.id}
                        variants={staggerItem}
                        exit={{ opacity: 0, x: -20, transition: { duration: 0.2 } }}
                        layout
                      >
                        <SessionRow
                          session={session}
                          onClick={() => {
                            let sessionData: Record<string, unknown> = { sessionName: session.name };
                            try {
                              const stored = localStorage.getItem(`ifb_session_data_${session.id}`);
                              if (stored) {
                                sessionData = JSON.parse(stored);
                              }
                            } catch { /* use minimal data */ }
                            navigate(`/feedback/${session.id}`, { state: sessionData });
                          }}
                          onDelete={() => handleDeleteSession(session)}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            ))}
          </motion.div>
        )}

        {/* Summary strip */}
        {allSessions.length > 0 && (
          <Card glass className="mt-6 px-5 py-3 flex items-center gap-4 text-xs text-ink-tertiary">
            <span className="flex items-center gap-1">
              <FileText className="w-3.5 h-3.5" />
              {allSessions.length} total {allSessions.length === 1 ? 'session' : 'sessions'}
            </span>
            <span>·</span>
            <span>
              {counts.completed} completed
            </span>
          </Card>
        )}
      </div>

      {/* Confirm delete dialog */}
      <AnimatePresence>
        {confirmDelete && (
          <ConfirmDeleteDialog
            title={confirmDelete.type === 'all' ? 'Clear All Sessions?' : 'Delete Session?'}
            message={
              confirmDelete.type === 'all'
                ? `This will permanently remove all ${allSessions.length} sessions and their data from this device.`
                : `This will permanently remove "${confirmDelete.session?.name}" and its data from this device.`
            }
            onConfirm={executeDelete}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
