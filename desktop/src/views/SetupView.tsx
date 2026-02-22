import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useSessionOrchestrator } from '../hooks/useSessionOrchestrator';
import {
  User,
  Users,
  Plus,
  Trash2,
  Link as LinkIcon,
  ArrowLeft,
  ClipboardPaste,
  Layout,
  ChevronUp,
  ChevronDown,
  ClipboardList,
  Pencil,
  Check,
  Loader2,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { TextArea } from '../components/ui/TextArea';
import { Chip } from '../components/ui/Chip';
import { ShimmerButton } from '../components/magicui/shimmer-button';
import { RubricTemplateModal, type CustomTemplate } from '../components/RubricTemplateModal';

/* ─── Motion Variants ────────────────────────── */

const sectionVariant = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  }),
};

/* ─── Types ─────────────────────────────────── */

type SessionMode = '1v1' | 'group';

type Participant = {
  id: string;
  name: string;
};

/* ─── Built-in templates ─────────────────────── */

type BuiltInTemplate = {
  value: string;
  label: string;
  dimensions: { name: string; weight: number; description: string }[];
};

const BUILTIN_TEMPLATES: BuiltInTemplate[] = [
  {
    value: 'general',
    label: 'General Interview',
    dimensions: [
      { name: 'Communication', weight: 3, description: 'Clarity and articulation' },
      { name: 'Problem Solving', weight: 3, description: 'Analytical thinking' },
      { name: 'Cultural Fit', weight: 2, description: 'Alignment with team values' },
    ],
  },
  {
    value: 'technical',
    label: 'Technical Assessment',
    dimensions: [
      { name: 'Technical Skills', weight: 5, description: 'Core competency' },
      { name: 'Problem Solving', weight: 4, description: 'Algorithmic thinking' },
      { name: 'System Design', weight: 3, description: 'Architecture awareness' },
      { name: 'Communication', weight: 2, description: 'Explaining thought process' },
    ],
  },
  {
    value: 'behavioral',
    label: 'Behavioral Interview',
    dimensions: [
      { name: 'Communication', weight: 4, description: 'STAR method usage' },
      { name: 'Leadership', weight: 3, description: 'Initiative and ownership' },
      { name: 'Teamwork', weight: 3, description: 'Collaboration examples' },
      { name: 'Adaptability', weight: 2, description: 'Handling change' },
    ],
  },
  {
    value: 'panel',
    label: 'Panel Discussion',
    dimensions: [
      { name: 'Presentation', weight: 4, description: 'Poise and confidence' },
      { name: 'Technical Depth', weight: 3, description: 'Subject matter expertise' },
      { name: 'Q&A Handling', weight: 3, description: 'Responding to diverse questions' },
    ],
  },
];

const STORAGE_KEY = 'ifb_rubric_templates';

let participantIdCounter = 0;

/* ─── ModeSelector ──────────────────────────── */

function ModeSelector({
  mode,
  onModeChange,
}: {
  mode: SessionMode;
  onModeChange: (m: SessionMode) => void;
}) {
  const options: { value: SessionMode; icon: typeof User; title: string; desc: string }[] = [
    { value: '1v1', icon: User, title: '1 v 1', desc: 'Single candidate interview' },
    { value: 'group', icon: Users, title: 'Group', desc: 'Multiple participants' },
  ];

  return (
    <div>
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2">
        Interview Mode
      </h3>
      <div className="grid grid-cols-2 gap-3">
        {options.map(({ value, icon: Icon, title, desc }) => (
          <button
            key={value}
            type="button"
            onClick={() => onModeChange(value)}
            className={`
              flex flex-col items-center gap-1.5 p-3 rounded-[--radius-card] border-2 transition-all cursor-pointer
              ${
                mode === value
                  ? 'border-accent bg-accent-soft'
                  : 'border-border bg-surface hover:border-ink-tertiary'
              }
            `}
          >
            <Icon className={`w-6 h-6 ${mode === value ? 'text-accent' : 'text-ink-secondary'}`} />
            <span className={`text-sm font-medium ${mode === value ? 'text-accent' : 'text-ink'}`}>
              {title}
            </span>
            <span className="text-xs text-ink-tertiary text-center">{desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── ParticipantEditor ─────────────────────── */

function ParticipantEditor({
  participants,
  onAdd,
  onRemove,
  onImport,
}: {
  participants: Participant[];
  onAdd: (name: string) => void;
  onRemove: (id: string) => void;
  onImport: (text: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  const handleAdd = () => {
    const trimmed = newName.trim();
    if (trimmed) {
      onAdd(trimmed);
      setNewName('');
    }
  };

  const handleImport = () => {
    if (importText.trim()) {
      onImport(importText);
      setImportText('');
      setShowImport(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider">
          Participants
        </h3>
        <button
          onClick={() => setShowImport(!showImport)}
          className="text-xs text-accent font-medium hover:underline flex items-center gap-1 cursor-pointer"
        >
          <ClipboardPaste className="w-3 h-3" />
          Paste list
        </button>
      </div>

      {showImport && (
        <div className="mb-3">
          <TextArea
            label="Paste names (one per line)"
            placeholder="John Doe&#10;Jane Smith&#10;Bob Williams"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={3}
          />
          <div className="flex gap-2 mt-2">
            <Button size="sm" onClick={handleImport}>Import</Button>
            <Button variant="ghost" size="sm" onClick={() => setShowImport(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Add single */}
      <div className="flex gap-2 mb-3">
        <TextField
          placeholder="Participant name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          className="flex-1"
        />
        <Button variant="secondary" size="sm" onClick={handleAdd}>
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* List */}
      {participants.length > 0 && (
        <ul className="space-y-1.5">
          <AnimatePresence>
            {participants.map((p) => (
              <motion.li
                key={p.id}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16, height: 0 }}
                transition={{ duration: 0.25 }}
                layout
                className="flex items-center justify-between px-3 py-2 rounded-[--radius-button] border border-border bg-surface"
              >
                <span className="text-sm text-ink">{p.name}</span>
                <button
                  onClick={() => onRemove(p.id)}
                  className="text-ink-tertiary hover:text-error cursor-pointer transition-colors"
                  aria-label={`Remove ${p.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

/* ─── FlowEditor ───────────────────────────── */

function FlowEditor({
  stages,
  onStagesChange,
}: {
  stages: string[];
  onStagesChange: (stages: string[]) => void;
}) {
  const [newStage, setNewStage] = useState('');

  const presets: { label: string; stages: string[] }[] = [
    { label: '1v1 Interview', stages: ['Intro', 'Q1', 'Q2', 'Q3', 'Wrap-up'] },
    { label: 'Group (2 Questions)', stages: ['Intro', 'Q1', 'Q2', 'Wrap-up'] },
    { label: 'Group (3 Questions)', stages: ['Intro', 'Q1', 'Q2', 'Q3', 'Wrap-up'] },
    { label: 'Panel Discussion', stages: ['Opening', 'Discussion', 'Q&A', 'Closing'] },
  ];

  const addStage = () => {
    const trimmed = newStage.trim();
    if (trimmed) {
      onStagesChange([...stages, trimmed]);
      setNewStage('');
    }
  };

  const removeStage = (index: number) => {
    onStagesChange(stages.filter((_, i) => i !== index));
  };

  const moveStage = (index: number, direction: -1 | 1) => {
    const newStages = [...stages];
    const target = index + direction;
    if (target < 0 || target >= newStages.length) return;
    [newStages[index], newStages[target]] = [newStages[target], newStages[index]];
    onStagesChange(newStages);
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2">
        Interview Flow
      </h3>

      {/* Preset buttons */}
      <div className="flex flex-wrap gap-2 mb-3">
        {presets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onStagesChange(preset.stages)}
            className="text-xs px-2.5 py-1 rounded-[--radius-chip] border border-border text-ink-secondary hover:border-accent hover:text-accent transition-colors cursor-pointer"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Current stages list */}
      <div className="space-y-1.5 mb-3">
        <AnimatePresence>
          {stages.map((stage, i) => (
            <motion.div
              key={`${stage}-${i}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.2 }}
              layout
              className="flex items-center gap-2 px-3 py-1.5 rounded-[--radius-button] border border-border bg-surface"
            >
              <span className="text-xs text-ink-tertiary tabular-nums w-5">{i + 1}.</span>
              <span className="text-sm text-ink flex-1">{stage}</span>
              <button onClick={() => moveStage(i, -1)} disabled={i === 0} className="text-ink-tertiary hover:text-ink disabled:opacity-30 cursor-pointer" aria-label="Move up">
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => moveStage(i, 1)} disabled={i === stages.length - 1} className="text-ink-tertiary hover:text-ink disabled:opacity-30 cursor-pointer" aria-label="Move down">
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => removeStage(i)} className="text-ink-tertiary hover:text-error cursor-pointer" aria-label={`Remove ${stage}`}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Add custom stage */}
      <div className="flex gap-2">
        <TextField
          placeholder="Custom stage name"
          value={newStage}
          onChange={(e) => setNewStage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addStage()}
          className="flex-1"
        />
        <Button variant="secondary" size="sm" onClick={addStage}>
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

/* ─── MeetingConnector ──────────────────────── */

function MeetingConnector({
  teamsUrl,
  onTeamsUrlChange,
  sessionName,
  participants,
}: {
  teamsUrl: string;
  onTeamsUrlChange: (v: string) => void;
  sessionName: string;
  participants: Participant[];
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleCreateMeeting = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await window.desktopAPI.calendarCreateOnlineMeeting({
        subject: sessionName || 'Mock Interview Session',
        participants: participants
          .filter((p) => p.name.trim())
          .map((p) => ({ name: p.name })),
      });
      onTeamsUrlChange(result.join_url);

      // Build invite text
      const lines = [`Mock Interview: ${result.title}`];
      lines.push(
        `Time: ${new Date(result.start_at).toLocaleString()} - ${new Date(result.end_at).toLocaleString()}`
      );
      lines.push(`Join: ${result.join_url}`);
      if (result.meeting_code) lines.push(`Meeting ID: ${result.meeting_code}`);
      if (result.passcode) lines.push(`Passcode: ${result.passcode}`);
      const inviteText = lines.join('\n');

      await window.desktopAPI.copyToClipboard(inviteText);
      setCopied(true);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create meeting');
    } finally {
      setCreating(false);
    }
  };

  const handleCopyInvite = async () => {
    if (!teamsUrl) return;
    try {
      await window.desktopAPI.copyToClipboard(teamsUrl);
      setCopied(true);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 3000);
    } catch {
      // silently ignore clipboard errors
    }
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2">
        Meeting Link
      </h3>
      <div className="space-y-2">
        <TextField
          label="Teams join URL"
          placeholder="Paste Teams meeting link or create new below..."
          value={teamsUrl}
          onChange={(e) => onTeamsUrlChange(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCreateMeeting}
            disabled={creating}
          >
            {creating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LinkIcon className="w-3.5 h-3.5" />
            )}
            {creating ? 'Creating...' : 'Create Meeting'}
          </Button>
          {teamsUrl && (
            <Button variant="ghost" size="sm" onClick={handleCopyInvite}>
              <ClipboardPaste className="w-3.5 h-3.5" />
              Copy Invite
            </Button>
          )}
        </div>
        {error && <p className="text-error text-xs">{error}</p>}
        {copied && <p className="text-accent text-xs">Invite copied to clipboard!</p>}
      </div>
    </div>
  );
}

/* ─── SetupSummary ──────────────────────────── */

function SetupSummary({
  mode,
  sessionName,
  templateLabel,
  participants,
  teamsUrl,
  stages,
}: {
  mode: SessionMode;
  sessionName: string;
  templateLabel: string;
  participants: Participant[];
  teamsUrl: string;
  stages: string[];
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleCopyInvite = async () => {
    if (!teamsUrl) return;
    try {
      await window.desktopAPI.copyToClipboard(teamsUrl);
      setCopied(true);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 3000);
    } catch {
      // silently ignore clipboard errors
    }
  };

  return (
    <div className="border border-border rounded-[--radius-card] bg-surface-hover p-4">
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-3">
        Review
      </h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-ink-tertiary text-xs">Mode</span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Chip variant="accent">{mode === '1v1' ? '1 v 1' : 'Group'}</Chip>
          </div>
        </div>
        <div>
          <span className="text-ink-tertiary text-xs">Session</span>
          <p className="text-ink mt-0.5">{sessionName || '(untitled)'}</p>
        </div>
        <div>
          <span className="text-ink-tertiary text-xs">Template</span>
          <p className="text-ink mt-0.5">{templateLabel}</p>
        </div>
        <div>
          <span className="text-ink-tertiary text-xs">Participants</span>
          <p className="text-ink mt-0.5">{participants.length} people</p>
        </div>
        <div>
          <span className="text-ink-tertiary text-xs">Flow</span>
          <p className="text-ink mt-0.5">{stages.length} stages</p>
        </div>
        {teamsUrl && (
          <div className="col-span-2">
            <span className="text-ink-tertiary text-xs">Teams URL</span>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-ink text-xs truncate flex-1">{teamsUrl}</p>
              <button
                onClick={handleCopyInvite}
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline cursor-pointer shrink-0"
              >
                <ClipboardPaste className="w-3 h-3" />
                {copied ? 'Copied!' : 'Copy Invite'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── SetupView (main export) ───────────────── */

export function SetupView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { start: startSession } = useSessionOrchestrator();
  const locationState = location.state as { mode?: SessionMode; sessionName?: string; stages?: string[] } | null;
  const [mode, setMode] = useState<SessionMode>(locationState?.mode || '1v1');
  const [sessionName, setSessionName] = useState(locationState?.sessionName || '');
  const [template, setTemplate] = useState('general');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [teamsUrl, setTeamsUrl] = useState('');
  const [stages, setStages] = useState<string[]>(
    locationState?.stages || ['Intro', 'Q1', 'Q2', 'Wrap-up']
  );

  // Custom template state
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>([]);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<CustomTemplate | null>(null);

  // Load custom templates from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setCustomTemplates(JSON.parse(stored));
      }
    } catch {
      // ignore corrupt data
    }
  }, []);

  // Persist custom templates to localStorage
  const saveCustomTemplates = (templates: CustomTemplate[]) => {
    setCustomTemplates(templates);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  };

  const handleSaveTemplate = (tpl: CustomTemplate) => {
    const existing = customTemplates.findIndex((t) => t.id === tpl.id);
    let updated: CustomTemplate[];
    if (existing >= 0) {
      updated = customTemplates.map((t) => (t.id === tpl.id ? tpl : t));
    } else {
      updated = [...customTemplates, tpl];
    }
    saveCustomTemplates(updated);
    setTemplate(tpl.id);
    setTemplateModalOpen(false);
    setEditingTemplate(null);
  };

  const handleEditTemplate = (templateId: string) => {
    // Check if it's a custom template
    const custom = customTemplates.find((t) => t.id === templateId);
    if (custom) {
      setEditingTemplate(custom);
    } else {
      // Built-in template: pre-fill modal but save as new custom
      const builtin = BUILTIN_TEMPLATES.find((t) => t.value === templateId);
      if (builtin) {
        setEditingTemplate({
          id: `custom_${Date.now()}`,
          name: `${builtin.label} (Custom)`,
          description: '',
          dimensions: builtin.dimensions.map((d) => ({ ...d })),
        });
      }
    }
    setTemplateModalOpen(true);
  };

  const handleCreateTemplate = () => {
    setEditingTemplate(null);
    setTemplateModalOpen(true);
  };

  // Helper to resolve template display name
  const getTemplateLabel = (): string => {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.value === template);
    if (builtin) return builtin.label;
    const custom = customTemplates.find((t) => t.id === template);
    if (custom) return custom.name;
    return template;
  };

  // Helper to get dimension count for a template
  const getDimensionCount = (templateId: string): number => {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.value === templateId);
    if (builtin) return builtin.dimensions.length;
    const custom = customTemplates.find((t) => t.id === templateId);
    if (custom) return custom.dimensions.length;
    return 0;
  };

  const addParticipant = (name: string) => {
    setParticipants((prev) => [...prev, { id: String(++participantIdCounter), name }]);
  };

  const removeParticipant = (id: string) => {
    setParticipants((prev) => prev.filter((p) => p.id !== id));
  };

  const importParticipants = (text: string) => {
    const names = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const newOnes = names.map((name) => ({ id: String(++participantIdCounter), name }));
    setParticipants((prev) => [...prev, ...newOnes]);
  };

  const handleStart = useCallback(async () => {
    const sessionId = `sess_${Date.now()}`;
    const displayName = sessionName || 'Untitled Session';

    // Save to localStorage for History (deduplicate by session ID)
    const sessionRecord = {
      id: sessionId,
      name: displayName,
      date: new Date().toISOString().slice(0, 10),
      mode,
      participantCount: participants.length,
      participants: participants.map(p => p.name),
      template,
      status: 'in_progress',
    };
    const existing = JSON.parse(localStorage.getItem('ifb_sessions') || '[]') as { id: string }[];
    const alreadyExists = existing.some((s) => s.id === sessionId);
    if (!alreadyExists) {
      existing.unshift(sessionRecord);
      localStorage.setItem('ifb_sessions', JSON.stringify(existing));
    }

    // Navigate first to prevent PiP flash (status will change before we leave /setup)
    navigate('/session', {
      state: {
        sessionId,
        sessionName: displayName,
        mode,
        participants: participants.map(p => p.name),
        template,
        teamsUrl,
        stages,
      },
    });

    // Orchestrator handles: audio init, WS connect, timer start, store update (non-blocking)
    startSession({
      sessionId,
      sessionName: displayName,
      mode,
      participants: participants.map(p => ({ name: p.name })),
      stages,
      baseApiUrl: import.meta.env.VITE_EDGE_BASE_URL || '',
      interviewerName: '',
      teamsJoinUrl: teamsUrl,
      templateId: template,
    });
  }, [sessionName, mode, participants, template, stages, teamsUrl, startSession, navigate]);

  // Wizard step state
  const [step, setStep] = useState(0);
  const stepLabels = ['Basics', 'Template & Flow', 'Review'];

  const canAdvance = step === 0
    ? true // No required fields on step 1 (session name defaults to "Untitled")
    : step === 1
    ? stages.length > 0
    : true;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Fixed Header: Title + Stepper ── */}
      <div className="shrink-0 border-b border-border bg-background">
        <div className="max-w-xl w-full mx-auto px-6 pt-4 pb-3">
          {/* Title row */}
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={() => step > 0 ? setStep(step - 1) : navigate('/')}
              className="text-ink-tertiary hover:text-ink transition-colors cursor-pointer"
              aria-label={step > 0 ? 'Previous step' : 'Back to home'}
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex-1">
              <h1 className="text-xl font-semibold text-ink">Session Setup</h1>
              <p className="text-sm text-ink-secondary">Step {step + 1} of {stepLabels.length}</p>
            </div>
          </div>

          {/* Step Indicator */}
          <div className="flex items-center gap-2">
            {stepLabels.map((label, i) => (
              <div key={label} className="flex items-center gap-2 flex-1">
                <button
                  onClick={() => i < step && setStep(i)}
                  className={`flex items-center gap-2 ${i <= step ? 'cursor-pointer' : 'cursor-default'}`}
                  disabled={i > step}
                >
                  <div className={`
                    w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors
                    ${i < step ? 'bg-accent text-white' : i === step ? 'bg-accent text-white' : 'bg-border text-ink-tertiary'}
                  `}>
                    {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
                  </div>
                  <span className={`text-sm font-medium hidden sm:inline ${i <= step ? 'text-ink' : 'text-ink-tertiary'}`}>
                    {label}
                  </span>
                </button>
                {i < stepLabels.length - 1 && (
                  <div className={`flex-1 h-0.5 rounded-full ${i < step ? 'bg-accent' : 'bg-border'}`} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Scrollable Content Area ── */}
      <div className="flex-1 overflow-y-auto scroll-smooth min-h-0">
        <div className="max-w-xl w-full mx-auto px-6 py-4">
          <AnimatePresence mode="wait">
            {step === 0 && (
              <motion.div
                key="step-0"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-3"
              >
                <Card className="p-4">
                  <ModeSelector mode={mode} onModeChange={setMode} />
                </Card>

                <Card className="p-4">
                  <TextField
                    label="Session name"
                    placeholder={mode === '1v1' ? 'e.g. John Doe Interview' : 'e.g. Panel Round 2'}
                    value={sessionName}
                    onChange={(e) => setSessionName(e.target.value)}
                  />
                </Card>

                <Card className="p-4">
                  <ParticipantEditor
                    participants={participants}
                    onAdd={addParticipant}
                    onRemove={removeParticipant}
                    onImport={importParticipants}
                  />
                </Card>

                <Card className="p-4">
                  <MeetingConnector
                    teamsUrl={teamsUrl}
                    onTeamsUrlChange={setTeamsUrl}
                    sessionName={sessionName}
                    participants={participants}
                  />
                </Card>

                <Card className="p-4 opacity-60">
                  <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2">
                    Schedule from DualSync
                  </h3>
                  <p className="text-xs text-ink-tertiary mb-3">
                    Import participants and meeting link from your DualSync scheduling platform.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled
                    title="Coming in Phase 2"
                  >
                    <Layout className="w-3.5 h-3.5" />
                    Import from DualSync
                  </Button>
                </Card>
              </motion.div>
            )}

            {step === 1 && (
              <motion.div
                key="step-1"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-3"
              >
                <Card className="p-4">
                  <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2">
                    Rubric Template
                  </h3>
                  <div className="grid grid-cols-2 gap-2.5">
                    {BUILTIN_TEMPLATES.map((t) => (
                      <motion.div
                        key={t.value}
                        layout
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.98 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                      >
                        <Card
                          hoverable
                          className={`
                            p-2.5 relative cursor-pointer transition-all
                            ${template === t.value ? 'border-accent border-2' : ''}
                          `}
                          onClick={() => setTemplate(t.value)}
                        >
                          <ClipboardList className="absolute top-2.5 right-2.5 w-4 h-4 text-ink-tertiary" />
                          <div className="pr-6">
                            <p className={`text-sm font-medium ${template === t.value ? 'text-accent' : 'text-ink'}`}>
                              {t.label}
                            </p>
                            <p className="text-xs text-ink-tertiary mt-0.5">
                              {t.dimensions.length} dimensions
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditTemplate(t.value);
                            }}
                            className="mt-1.5 inline-flex items-center gap-1 text-xs text-ink-secondary hover:text-accent transition-colors cursor-pointer"
                            aria-label={`Edit ${t.label}`}
                          >
                            <Pencil className="w-3 h-3" />
                            Edit
                          </button>
                        </Card>
                      </motion.div>
                    ))}

                    {customTemplates.map((t) => (
                      <motion.div
                        key={t.id}
                        layout
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.98 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                      >
                        <Card
                          hoverable
                          className={`
                            p-2.5 relative cursor-pointer transition-all
                            ${template === t.id ? 'border-accent border-2' : ''}
                          `}
                          onClick={() => setTemplate(t.id)}
                        >
                          <ClipboardList className="absolute top-2.5 right-2.5 w-4 h-4 text-accent" />
                          <div className="pr-6">
                            <p className={`text-sm font-medium ${template === t.id ? 'text-accent' : 'text-ink'}`}>
                              {t.name}
                            </p>
                            <p className="text-xs text-ink-tertiary mt-0.5">
                              {t.dimensions.length} dimensions
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditTemplate(t.id);
                            }}
                            className="mt-1.5 inline-flex items-center gap-1 text-xs text-ink-secondary hover:text-accent transition-colors cursor-pointer"
                            aria-label={`Edit ${t.name}`}
                          >
                            <Pencil className="w-3 h-3" />
                            Edit
                          </button>
                        </Card>
                      </motion.div>
                    ))}

                    <motion.div
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                    >
                      <button
                        type="button"
                        onClick={handleCreateTemplate}
                        className="
                          w-full flex flex-col items-center justify-center gap-2 p-2.5
                          border-dashed border-2 border-border rounded-[--radius-card]
                          text-ink-secondary hover:border-accent hover:text-accent
                          transition-all cursor-pointer min-h-[76px]
                        "
                      >
                        <Plus className="w-5 h-5" />
                        <span className="text-xs font-medium">Create Custom Template</span>
                      </button>
                    </motion.div>
                  </div>
                </Card>

                <Card className="p-4">
                  <FlowEditor stages={stages} onStagesChange={setStages} />
                </Card>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step-2"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-3"
              >
                <SetupSummary
                  mode={mode}
                  sessionName={sessionName}
                  templateLabel={getTemplateLabel()}
                  participants={participants}
                  teamsUrl={teamsUrl}
                  stages={stages}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Fixed Bottom Navigation ── */}
      <div className="shrink-0 border-t border-border bg-surface px-6 py-3">
        <div className="max-w-xl mx-auto flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => step > 0 ? setStep(step - 1) : navigate('/')}
          >
            {step > 0 ? 'Back' : 'Cancel'}
          </Button>

          {step < stepLabels.length - 1 ? (
            <Button
              onClick={() => setStep(step + 1)}
              disabled={!canAdvance}
            >
              Continue
            </Button>
          ) : (
            <ShimmerButton onClick={handleStart} className="w-auto">
              <Layout className="w-4 h-4" />
              Join & Start Session
            </ShimmerButton>
          )}
        </div>
      </div>

      {/* Rubric Template Modal */}
      <RubricTemplateModal
        open={templateModalOpen}
        onClose={() => {
          setTemplateModalOpen(false);
          setEditingTemplate(null);
        }}
        onSave={handleSaveTemplate}
        editTemplate={editingTemplate}
      />
    </div>
  );
}
