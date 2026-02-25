import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  User,
  Users,
  Play,
  Calendar,
  Clock,
  CheckCircle,
  ArrowRight,
  CalendarPlus,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { EmptyState } from '../components/ui/EmptyState';
import { staggerContainer, staggerItem } from '../lib/animations';
import { useCalendar } from '../hooks/useCalendar';
import { getPersistedSession, clearPersistedSession } from '../stores/sessionStore';
import type { PersistedSession } from '../stores/sessionStore';
import { useSessionOrchestrator } from '../hooks/useSessionOrchestrator';

type SessionMode = '1v1' | 'group';

/* --- localStorage session type ------------ */

type StoredSession = {
  id: string;
  name: string;
  date: string;
  mode?: '1v1' | 'group';
  participantCount?: number;
  participants?: string[];
  status?: string;
};

function getCompletedSessions(): StoredSession[] {
  try {
    const raw = JSON.parse(localStorage.getItem('ifb_sessions') || '[]') as StoredSession[];
    return raw.filter((s) => s.status === 'completed');
  } catch {
    return [];
  }
}

/* --- StartInterviewCard (merged Quick Start + New Session) --- */

function StartInterviewCard({
  mode,
  onModeChange,
  sessionName,
  onSessionNameChange,
  onStart,
}: {
  mode: SessionMode;
  onModeChange: (m: SessionMode) => void;
  sessionName: string;
  onSessionNameChange: (v: string) => void;
  onStart: () => void;
}) {
  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold text-ink-secondary mb-4">
        Start Interview
      </h3>

      {/* Mode toggle */}
      <div className="flex rounded-[--radius-button] border border-border overflow-hidden mb-4">
        <button
          type="button"
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors duration-150 cursor-pointer ${
            mode === '1v1'
              ? 'bg-accent text-white'
              : 'bg-surface text-ink-secondary hover:bg-surface-hover'
          }`}
          onClick={() => onModeChange('1v1')}
        >
          <User className="w-3.5 h-3.5" />
          1 v 1
        </button>
        <button
          type="button"
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors duration-150 cursor-pointer ${
            mode === 'group'
              ? 'bg-accent text-white'
              : 'bg-surface text-ink-secondary hover:bg-surface-hover'
          }`}
          onClick={() => onModeChange('group')}
        >
          <Users className="w-3.5 h-3.5" />
          Group
        </button>
      </div>

      <TextField
        label="Session name (optional)"
        placeholder={mode === '1v1' ? 'e.g. John Doe Interview' : 'e.g. Panel Round 2'}
        value={sessionName}
        onChange={(e) => onSessionNameChange(e.target.value)}
        className="mb-5"
      />

      <Button
        variant="primary"
        className="w-full py-3 text-sm font-semibold"
        onClick={onStart}
      >
        <Play className="w-4 h-4" />
        Start Session
      </Button>
    </Card>
  );
}

/* --- ActiveSessionCard -------------------- */

function ActiveSessionCard({
  session,
  onResume,
  onDiscard,
}: {
  session: PersistedSession;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const mins = Math.floor(session.elapsedSeconds / 60);
  const secs = session.elapsedSeconds % 60;
  const elapsed = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  return (
    <Card className="p-5 border-accent/30 border">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink">Recoverable Session</h3>
        <span className="flex items-center gap-1.5 text-xs text-warning font-medium">
          <span className="w-2 h-2 rounded-full bg-warning" />
          Interrupted
        </span>
      </div>
      <div className="mb-3">
        <p className="text-sm text-ink truncate">
          {session.sessionName || 'Untitled Session'}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-ink-tertiary">{session.mode === '1v1' ? '1 v 1' : 'Group'}</span>
          <span className="text-xs text-ink-tertiary flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {elapsed}
          </span>
          <span className="text-xs text-ink-tertiary">
            {session.participants.length} participant{session.participants.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" className="flex-1" onClick={onResume}>
          <ArrowRight className="w-3.5 h-3.5" />
          Resume
        </Button>
        <Button variant="ghost" size="sm" onClick={onDiscard} title="Discard session">
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </Card>
  );
}

/* --- PendingFeedbackCard ------------------ */

function PendingFeedbackCard({
  navigate,
}: {
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [pending, setPending] = useState<StoredSession[]>([]);

  useEffect(() => {
    setPending(getCompletedSessions());
  }, []);

  if (pending.length === 0) {
    return (
      <Card className="p-5 h-full">
        <h3 className="text-sm font-semibold text-ink-secondary mb-2">
          Pending Feedback
        </h3>
        <EmptyState
          icon={CheckCircle}
          title="All caught up"
          description="No sessions awaiting finalization"
        />
      </Card>
    );
  }

  return (
    <Card className="p-5 h-full flex flex-col">
      <h3 className="text-sm font-semibold text-ink-secondary mb-3">
        Pending Feedback
      </h3>
      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-lg font-bold text-accent">{pending.length}</span>
        <span className="text-sm text-ink-secondary">
          {pending.length === 1 ? 'session' : 'sessions'} awaiting report
        </span>
      </div>
      <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto">
        {pending.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between border border-border rounded-[--radius-button] px-3 py-2"
          >
            <div className="min-w-0 mr-2">
              <p className="text-sm text-ink truncate">{s.name}</p>
              <p className="text-xs text-ink-tertiary">
                {s.date} &middot; {s.participantCount ?? s.participants?.length ?? 0} participants
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => {
                // Load full session data from localStorage (includes memos/notes/stages)
                let sessionData: Record<string, unknown> = {
                  sessionName: s.name,
                  participants: s.participants ?? [],
                };
                try {
                  const stored = localStorage.getItem(`ifb_session_data_${s.id}`);
                  if (stored) sessionData = JSON.parse(stored);
                } catch { /* use minimal data */ }
                navigate(`/feedback/${s.id}`, { state: sessionData });
              }}
            >
              View Draft
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* --- Date grouping helpers ---------------- */

type MeetingWithTime = { startTime: string };

function getMeetingDateGroup(isoTime: string): string {
  const date = new Date(isoTime);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(today);
  dayAfter.setDate(dayAfter.getDate() + 2);

  if (date >= today && date < tomorrow) return 'Today';
  if (date >= tomorrow && date < dayAfter) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function groupMeetingsByDate<T extends MeetingWithTime>(meetings: T[]): { label: string; meetings: T[] }[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];

  for (const m of meetings) {
    const label = getMeetingDateGroup(m.startTime);
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(m);
  }

  return order.map(label => ({ label, meetings: groups.get(label)! }));
}

/* --- UpcomingMeetings --------------------- */

function UpcomingMeetings({ onQuickStart }: { onQuickStart: (meeting: { subject: string; joinUrl?: string; startTime?: string; endTime?: string }) => void }) {
  const { status, meetings, connectMicrosoft, connectGoogle, refresh } = useCalendar();
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleConnect = async (provider: 'microsoft' | 'google') => {
    setConnecting(true);
    try {
      if (provider === 'microsoft') {
        await connectMicrosoft();
      } else {
        await connectGoogle();
      }
    } finally {
      setConnecting(false);
    }
  };

  if (status === 'loading') {
    return (
      <Card className="p-5 h-full">
        <h3 className="text-sm font-semibold text-ink-secondary mb-2">
          Upcoming Meetings
        </h3>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-accent" />
        </div>
      </Card>
    );
  }

  if (status !== 'connected') {
    return (
      <Card className="p-5 h-full">
        <h3 className="text-sm font-semibold text-ink-secondary mb-2">
          Upcoming Meetings
        </h3>
        <EmptyState
          icon={Calendar}
          title="Calendar not connected"
          description="Connect your calendar to see upcoming meetings and quick-start sessions"
          action={
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleConnect('microsoft')}
                disabled={connecting}
              >
                {connecting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CalendarPlus className="w-3.5 h-3.5" />
                )}
                {connecting ? 'Connecting...' : 'Connect Microsoft'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleConnect('google')}
                disabled={connecting}
              >
                {connecting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CalendarPlus className="w-3.5 h-3.5" />
                )}
                {connecting ? 'Connecting...' : 'Connect Google'}
              </Button>
            </div>
          }
        />
      </Card>
    );
  }

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  };

  if (meetings.length === 0) {
    return (
      <Card className="p-5 h-full">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-ink-secondary">
            Upcoming Meetings
          </h3>
          <button onClick={handleRefresh} className="p-1 rounded hover:bg-border/50 text-ink-tertiary" title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <EmptyState
          icon={Calendar}
          title="No upcoming meetings"
          description="Your calendar is clear for the next few days"
        />
      </Card>
    );
  }

  return (
    <Card className="p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink-secondary">
          Upcoming Meetings
        </h3>
        <button onClick={handleRefresh} className="p-1 rounded hover:bg-border/50 text-ink-tertiary" title="Refresh">
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="space-y-4 flex-1 min-h-0 overflow-y-auto">
        {groupMeetingsByDate(meetings).map((group) => (
          <div key={group.label}>
            <h4 className="text-xs font-medium text-ink-tertiary uppercase tracking-wide mb-1.5 px-1">
              {group.label}
            </h4>
            <ul className="space-y-2">
              {group.meetings.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between border border-border rounded-[--radius-button] px-3 py-2"
                >
                  <div className="min-w-0 mr-2">
                    <p className="text-sm text-ink truncate">{m.subject}</p>
                    <p className="text-xs text-ink-tertiary">
                      {new Date(m.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {' — '}
                      {new Date(m.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {m.organizer ? ` · ${m.organizer}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => onQuickStart({ subject: m.subject, joinUrl: m.joinUrl, startTime: m.startTime, endTime: m.endTime })}
                  >
                    Quick Start
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* --- Greeting helper ---------------------- */

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/* --- HomeView (main export) --------------- */

export function HomeView() {
  const navigate = useNavigate();
  const { resume } = useSessionOrchestrator();
  const [mode, setMode] = useState<SessionMode>('1v1');
  const [sessionName, setSessionName] = useState('');
  const [recoverable, setRecoverable] = useState<PersistedSession | null>(null);

  // Check for recoverable session on mount
  useEffect(() => {
    setRecoverable(getPersistedSession());
  }, []);

  const handleStart = () => {
    navigate('/setup', { state: { mode, sessionName } });
  };

  const handleResume = async () => {
    if (!recoverable) return;
    await resume(recoverable);
    setRecoverable(null);
  };

  const handleDiscard = () => {
    clearPersistedSession();
    setRecoverable(null);
  };

  const handleQuickStart = (meeting: { subject: string; joinUrl?: string; startTime?: string; endTime?: string }) => {
    setSessionName(meeting.subject);
    navigate('/setup', { state: { mode, sessionName: meeting.subject, teamsJoinUrl: meeting.joinUrl, startTime: meeting.startTime, endTime: meeting.endTime } });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Compact greeting line */}
      <motion.div
        className="flex items-center gap-3 px-6 pt-5 pb-2"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className="text-sm text-ink-tertiary">{getGreeting()}</span>
        <span className="flex-1 h-px bg-border" />
        <span className="text-sm font-semibold text-ink">Chorus</span>
      </motion.div>

      {/* Main grid — no page-level scroll; each card handles its own overflow */}
      <div className="flex-1 min-h-0 px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full">
          {/* Left column: session controls */}
          <motion.div
            className="flex flex-col gap-4 min-h-0"
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
          >
            <motion.div variants={staggerItem}>
              <StartInterviewCard
                mode={mode}
                onModeChange={setMode}
                sessionName={sessionName}
                onSessionNameChange={setSessionName}
                onStart={handleStart}
              />
            </motion.div>

            {recoverable && (
              <motion.div variants={staggerItem}>
                <ActiveSessionCard
                  session={recoverable}
                  onResume={handleResume}
                  onDiscard={handleDiscard}
                />
              </motion.div>
            )}

            <motion.div variants={staggerItem} className="flex-1 min-h-0">
              <PendingFeedbackCard navigate={navigate} />
            </motion.div>
          </motion.div>

          {/* Right column: calendar */}
          <motion.div
            className="min-h-0"
            variants={staggerItem}
            initial="hidden"
            animate="visible"
          >
            <UpcomingMeetings onQuickStart={handleQuickStart} />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
