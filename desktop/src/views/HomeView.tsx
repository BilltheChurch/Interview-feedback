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
  Wifi,
  Mic,
  ArrowRight,
  CalendarPlus,
  Monitor,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { StatusDot } from '../components/ui/StatusDot';
import { Chip } from '../components/ui/Chip';
import { EmptyState } from '../components/ui/EmptyState';
import { TextAnimate } from '../components/magicui/text-animate';
import { ShimmerButton } from '../components/magicui/shimmer-button';
import { NumberTicker } from '../components/magicui/number-ticker';

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
    <Card className="p-5 border-2 border-border">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-ink mb-4">
        Start Interview
      </h3>

      {/* Mode toggle */}
      <div className="flex rounded-[--radius-button] border-2 border-border overflow-hidden mb-4">
        <button
          type="button"
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors cursor-pointer ${
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
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors cursor-pointer ${
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
        className="mb-4"
      />

      <ShimmerButton className="w-full" onClick={onStart}>
        <Play className="w-4 h-4" />
        Start Session
      </ShimmerButton>
    </Card>
  );
}

/* --- ActiveSessionCard -------------------- */

function ActiveSessionCard({ onResume }: { onResume: () => void }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-ink">Active Session</h3>
        <StatusDot status="recording" />
      </div>
      <div className="mb-3">
        <p className="text-sm text-ink">Mock Interview - Jane S.</p>
        <div className="flex items-center gap-2 mt-1">
          <Chip variant="accent">1 v 1</Chip>
          <span className="text-xs text-ink-tertiary flex items-center gap-1">
            <Clock className="w-3 h-3" />
            12:34
          </span>
        </div>
      </div>
      <Button variant="secondary" size="sm" className="w-full" onClick={onResume}>
        <ArrowRight className="w-3.5 h-3.5" />
        Resume
      </Button>
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
      <Card className="p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-ink mb-2">
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
    <Card className="p-5">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-ink mb-3">
        Pending Feedback
      </h3>
      <div className="flex items-center mb-3">
        <NumberTicker value={pending.length} className="text-lg font-bold text-accent" />
        <span className="text-sm text-ink-secondary ml-1">sessions pending</span>
      </div>
      <ul className="space-y-2">
        {pending.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between border border-border rounded-[--radius-button] px-3 py-2"
          >
            <div>
              <p className="text-sm text-ink">{s.name}</p>
              <p className="text-xs text-ink-tertiary">
                {s.date} &middot; {s.participantCount ?? s.participants?.length ?? 0} participants
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                navigate(`/feedback/${s.id}`, {
                  state: {
                    sessionName: s.name,
                    participants: s.participants ?? [],
                  },
                })
              }
            >
              Finalize
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* --- UpcomingMeetings --------------------- */

function UpcomingMeetings({ onQuickStart }: { onQuickStart: (meeting: { subject: string }) => void }) {
  const connected = false;
  const meetings: { id: string; subject: string; time: string; organizer: string }[] = [];
  const navigate = useNavigate();

  if (!connected) {
    return (
      <Card className="p-5 h-full">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-ink mb-2">
          Upcoming Meetings
        </h3>
        <EmptyState
          icon={Calendar}
          title="Calendar not connected"
          description="Connect Microsoft Graph to see upcoming meetings and quick-start sessions"
          action={
            <Button variant="secondary" size="sm" onClick={() => navigate('/settings')}>
              <CalendarPlus className="w-3.5 h-3.5" />
              Connect Calendar
            </Button>
          }
        />
      </Card>
    );
  }

  if (meetings.length === 0) {
    return (
      <Card className="p-5 h-full">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-ink mb-2">
          Upcoming Meetings
        </h3>
        <EmptyState
          icon={Calendar}
          title="No upcoming meetings"
          description="Your calendar is clear for today"
        />
      </Card>
    );
  }

  return (
    <Card className="p-5 h-full">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-ink mb-3">
        Upcoming Meetings
      </h3>
      <ul className="space-y-2">
        {meetings.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between border border-border rounded-[--radius-button] px-3 py-2"
          >
            <div>
              <p className="text-sm text-ink">{m.subject}</p>
              <p className="text-xs text-ink-tertiary">
                {m.time} &middot; {m.organizer}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onQuickStart({ subject: m.subject })}
            >
              Quick Start
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* --- HealthIndicator ---------------------- */

function HealthIndicator() {
  return (
    <div className="flex items-center gap-4 px-5 py-3 border-t border-border">
      <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
        <Mic className="w-3.5 h-3.5" />
        <span>Audio</span>
        <StatusDot status="idle" />
      </div>
      <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
        <Wifi className="w-3.5 h-3.5" />
        <span>Backend</span>
        <StatusDot status="idle" />
      </div>
      <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
        <Monitor className="w-3.5 h-3.5" />
        <span>Teams</span>
        <StatusDot status="idle" />
      </div>
    </div>
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
  const [mode, setMode] = useState<SessionMode>('1v1');
  const [sessionName, setSessionName] = useState('');

  // Static flag -- no active session yet
  const hasActiveSession = false;

  const handleStart = () => {
    navigate('/setup', { state: { mode, sessionName } });
  };

  const handleResume = () => {
    navigate('/session');
  };

  const handleQuickStart = (meeting: { subject: string }) => {
    setSessionName(meeting.subject);
    navigate('/setup', { state: { mode, sessionName: meeting.subject } });
  };

  const staggerContainer = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.1 } },
  };
  const staggerItem = {
    hidden: { opacity: 0, y: 16 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const } },
  };

  return (
    <div className="flex flex-col h-full">
      {/* Hero / Greeting -- Neo-Brutalist bold block */}
      <motion.div
        className="relative bg-accent border-2 border-white/20 px-8 py-8 mx-4 mt-4 mb-2 rounded-[--radius-card] overflow-hidden"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* Decorative sound-wave pattern via repeating gradient */}
        <div
          className="absolute inset-0 opacity-[0.07] pointer-events-none"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent, transparent 8px, white 8px, white 10px)',
          }}
        />
        <div className="relative z-10">
          <p className="text-sm text-white/60 mb-1">{getGreeting()}</p>
          <TextAnimate animation="blurIn" by="character" className="text-4xl font-bold text-white leading-tight" staggerDelay={0.04}>
            Chorus
          </TextAnimate>
          <TextAnimate animation="fadeIn" by="word" delay={0.5} className="text-base text-white/70 mt-1">
            Every voice counts
          </TextAnimate>
        </div>
      </motion.div>

      {/* Main grid */}
      <div className="flex-1 px-6 py-4 overflow-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left column: session controls */}
          <motion.div className="flex flex-col gap-4" variants={staggerContainer} initial="hidden" animate="visible">
            {/* Start Interview (merged Quick Start + New Session) */}
            <motion.div variants={staggerItem} whileHover={{ y: -4, transition: { duration: 0.2 } }}>
              <StartInterviewCard
                mode={mode}
                onModeChange={setMode}
                sessionName={sessionName}
                onSessionNameChange={setSessionName}
                onStart={handleStart}
              />
            </motion.div>

            {hasActiveSession && (
              <motion.div variants={staggerItem} whileHover={{ y: -4, transition: { duration: 0.2 } }}>
                <ActiveSessionCard onResume={handleResume} />
              </motion.div>
            )}

            <motion.div variants={staggerItem} whileHover={{ y: -4, transition: { duration: 0.2 } }}>
              <PendingFeedbackCard navigate={navigate} />
            </motion.div>
          </motion.div>

          {/* Right column: calendar */}
          <motion.div
            variants={staggerItem}
            initial="hidden"
            animate="visible"
            whileHover={{ y: -4, transition: { duration: 0.2 } }}
          >
            <UpcomingMeetings onQuickStart={handleQuickStart} />
          </motion.div>
        </div>
      </div>

      {/* Health strip */}
      <HealthIndicator />
    </div>
  );
}
