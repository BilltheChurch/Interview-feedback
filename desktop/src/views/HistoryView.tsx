import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clock,
  User,
  Users,
  FileText,
  Search,
  ChevronRight,
  ArrowLeft,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { TextField } from '../components/ui/TextField';
import { EmptyState } from '../components/ui/EmptyState';

/* ─── Types ─────────────────────────────────── */

type SessionRecord = {
  id: string;
  name: string;
  date: string;
  mode: '1v1' | 'group';
  participantCount: number;
  status: 'completed' | 'draft' | 'failed';
};

/* ─── localStorage reader ──────────────────── */

function getStoredSessions(): SessionRecord[] {
  try {
    const stored = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
    return stored.map((s: any) => ({
      id: s.id,
      name: s.name,
      date: s.date,
      mode: s.mode || '1v1',
      participantCount: s.participantCount || 0,
      status: s.status === 'in_progress' ? 'draft' as const : (s.status || 'completed') as SessionRecord['status'],
    }));
  } catch {
    return [];
  }
}

/* ─── Mock data ─────────────────────────────── */

const MOCK_SESSIONS: SessionRecord[] = [
  { id: 's-001', name: 'John Doe — Technical Interview', date: '2026-02-14', mode: '1v1', participantCount: 1, status: 'completed' },
  { id: 's-002', name: 'Panel Round 2 — Engineering Team', date: '2026-02-13', mode: 'group', participantCount: 4, status: 'completed' },
  { id: 's-003', name: 'Jane Smith — Behavioral', date: '2026-02-12', mode: '1v1', participantCount: 1, status: 'draft' },
  { id: 's-004', name: 'Design Review Panel', date: '2026-02-11', mode: 'group', participantCount: 3, status: 'completed' },
  { id: 's-005', name: 'Bob Williams — Final Round', date: '2026-02-10', mode: '1v1', participantCount: 1, status: 'failed' },
];

/* ─── Status config ─────────────────────────── */

const statusConfig: Record<SessionRecord['status'], { label: string; variant: 'success' | 'warning' | 'error' }> = {
  completed: { label: 'Completed', variant: 'success' },
  draft: { label: 'Draft', variant: 'warning' },
  failed: { label: 'Failed', variant: 'error' },
};

/* ─── SessionRow ────────────────────────────── */

function SessionRow({ session, onClick }: { session: SessionRecord; onClick: () => void }) {
  const ModeIcon = session.mode === '1v1' ? User : Users;
  const cfg = statusConfig[session.status];

  return (
    <Card
      hoverable
      className="p-4 flex items-center gap-4 cursor-pointer"
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

      {/* Status */}
      <Chip variant={cfg.variant}>{cfg.label}</Chip>

      {/* Arrow */}
      <ChevronRight className="w-4 h-4 text-ink-tertiary shrink-0 transition-all duration-200" />
    </Card>
  );
}

/* ─── HistoryView (main export) ─────────────── */

export function HistoryView() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const allSessions = [...getStoredSessions(), ...MOCK_SESSIONS];

  const filtered = allSessions.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 animate-fade-in">
        {/* Header */}
        <div className="mb-6 flex items-start gap-3">
          <button
            onClick={() => navigate('/')}
            className="text-ink-tertiary hover:text-ink transition-colors cursor-pointer mt-1"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-ink">Session History</h1>
            <p className="text-sm text-ink-secondary">Review past interview sessions and reports</p>
          </div>
        </div>

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

        {/* Session list */}
        {filtered.length === 0 ? (
          <div className="animate-scale-in">
            <EmptyState
              icon={Clock}
              title="No sessions found"
              description={search ? 'Try a different search term' : 'Your completed sessions will appear here'}
            />
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((session, index) => (
              <div key={session.id} className="animate-slide-up" style={{ animationDelay: `${index * 0.1}s` }}>
                <SessionRow
                  session={session}
                  onClick={() => navigate(`/feedback/${session.id}`, { state: { sessionName: session.name } })}
                />
              </div>
            ))}
          </div>
        )}

        {/* Summary strip */}
        <Card glass className="mt-6 px-4 py-3 flex items-center gap-4 text-xs text-ink-tertiary">
          <span className="flex items-center gap-1">
            <FileText className="w-3.5 h-3.5" />
            {allSessions.length} total sessions
          </span>
          <span>·</span>
          <span>
            {allSessions.filter((s) => s.status === 'completed').length} completed
          </span>
        </Card>
      </div>
    </div>
  );
}
