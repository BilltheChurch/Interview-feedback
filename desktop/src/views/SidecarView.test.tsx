import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock motion/react — cover all element types (div, span, button, etc.)
vi.mock('motion/react', async () => {
  const { createElement } = await import('react');
  return {
    motion: new Proxy({}, {
      get: (_t: unknown, tag: string) =>
        ({ children, ...props }: Record<string, unknown>) => createElement(tag, props as object, children),
    }),
    AnimatePresence: ({ children }: { children: unknown }) => children,
  };
});

// Mock all lucide-react icons as simple spans to avoid undefined component errors
vi.mock('lucide-react', () => ({
  Star: () => <span data-icon="Star" />,
  AlertTriangle: () => <span data-icon="AlertTriangle" />,
  HelpCircle: () => <span data-icon="HelpCircle" />,
  Link2: () => <span data-icon="Link2" />,
  ChevronLeft: () => <span data-icon="ChevronLeft" />,
  ChevronRight: () => <span data-icon="ChevronRight" />,
  ChevronDown: () => <span data-icon="ChevronDown" />,
  ChevronUp: () => <span data-icon="ChevronUp" />,
  Check: () => <span data-icon="Check" />,
  X: () => <span data-icon="X" />,
  BookOpen: () => <span data-icon="BookOpen" />,
  Mic: () => <span data-icon="Mic" />,
  Volume2: () => <span data-icon="Volume2" />,
  AudioLines: () => <span data-icon="AudioLines" />,
  ArrowLeft: () => <span data-icon="ArrowLeft" />,
  ArrowRight: () => <span data-icon="ArrowRight" />,
  Radio: () => <span data-icon="Radio" />,
  Plus: () => <span data-icon="Plus" />,
  Trash2: () => <span data-icon="Trash2" />,
  RefreshCw: () => <span data-icon="RefreshCw" />,
  Pencil: () => <span data-icon="Pencil" />,
  Flag: () => <span data-icon="Flag" />,
  Clock: () => <span data-icon="Clock" />,
}));

// Mock UI components that may have CSS/animation issues in jsdom
vi.mock('../components/ui/StatusDot', () => ({
  StatusDot: ({ status }: { status: string }) => <span data-testid="status-dot" data-status={status} />,
}));
vi.mock('../components/ui/MeterBar', () => ({
  MeterBar: () => <div data-testid="meter-bar" />,
}));
vi.mock('../components/ui/ConfidenceBadge', () => ({
  ConfidenceBadge: ({ score }: { score: number }) => <span data-testid="confidence-badge">{score}</span>,
}));
vi.mock('../components/ui/Button', () => ({
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: string; size?: string }) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));
vi.mock('../components/ui/Chip', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-testid="chip">{children}</span>,
}));

vi.mock('../hooks/useSessionOrchestrator', () => ({
  useSessionOrchestrator: () => ({
    endSession: vi.fn(),
    startSession: vi.fn(),
  }),
}));

// useSessionStore is called with selector functions: useSessionStore((s) => s.field)
// Simulate Zustand's selector API by running the selector against a mock state object.
const mockState: Record<string, unknown> = {};

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) => selector(mockState)),
}));

vi.mock('../components/RichNoteEditor', () => ({
  RichNoteEditor: ({ onChange }: { onChange?: (html: string, text: string) => void }) => (
    <div data-testid="rich-note-editor">
      <textarea
        onChange={(e) => onChange?.(e.target.value, e.target.value)}
        placeholder="Session notes"
      />
    </div>
  ),
}));

vi.mock('../components/CaptionPanel', () => ({
  CaptionPanel: () => <div data-testid="caption-panel">CaptionPanel</div>,
}));

vi.mock('../lib/sanitize', () => ({
  sanitizeHtml: (html: string) => html,
}));

vi.mock('../lib/animations', () => ({
  staggerContainer: {},
  staggerItem: {},
}));

import { SidecarView } from './SidecarView';

function populateMockState(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    sessionId: 'sess_1',
    sessionName: 'Test Interview',
    mode: '1v1',
    status: 'recording',
    elapsedSeconds: 125,
    participants: [{ name: 'Alice' }, { name: 'Bob' }],
    stages: ['Intro', 'Q1', 'Q2', 'Wrap-up'],
    currentStage: 'Intro',
    currentStageIndex: 0,
    memos: [],
    notes: '',
    stageArchives: [],
    audioLevels: { mic: 0.4, system: 0.2, mixed: 0.5 },
    micActiveSeconds: 10,
    sysActiveSeconds: 5,
    wsStatus: 'connected',
    wsStatusStudents: 'connected',
    acsStatus: 'off',
    acsCaptionCount: 0,
    captions: [],
    baseApiUrl: 'http://localhost:8787',
    speakerResolutions: {},
    incrementalDiarization: null,
    finalizeRequested: false,
    addMemo: vi.fn(),
    setNotes: vi.fn(),
    setCurrentStageIndex: vi.fn(),
    advanceStage: vi.fn(),
    addStageArchive: vi.fn(),
    archiveStage: vi.fn(),
    reset: vi.fn(),
    endSession: vi.fn(),
  };
  // Clear and repopulate mockState
  Object.keys(mockState).forEach((k) => delete mockState[k]);
  Object.assign(mockState, defaults, overrides);
}

function renderSidecarView(storeOverrides: Record<string, unknown> = {}) {
  populateMockState(storeOverrides);
  return render(
    <MemoryRouter>
      <SidecarView />
    </MemoryRouter>,
  );
}

describe('SidecarView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the session name in the header', () => {
    renderSidecarView();
    expect(screen.getByText('Test Interview')).toBeInTheDocument();
  });

  it('renders the elapsed timer in MM:SS format', () => {
    renderSidecarView({ elapsedSeconds: 125 });
    // 125 seconds = 02:05
    expect(screen.getByText('02:05')).toBeInTheDocument();
  });

  it('renders memo type buttons (Highlight, Issue, Question, Evidence)', () => {
    renderSidecarView();
    // Buttons use aria-label="Highlight (Cmd+1)" etc. — not visible text
    expect(screen.getByLabelText(/highlight/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/issue/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/question/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/evidence/i)).toBeInTheDocument();
  });

  it('renders participant names from location state', () => {
    // Participants come from router location.state, not the store.
    populateMockState();
    render(
      <MemoryRouter initialEntries={[{ pathname: '/session', state: { participants: ['Alice', 'Bob'], stages: ['Intro'] } }]}>
        <SidecarView />
      </MemoryRouter>,
    );
    // Multiple Alice elements may appear (enrollment panel + participation panel) — just assert presence
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0);
  });

  it('renders the RichNoteEditor for notes', () => {
    renderSidecarView();
    expect(screen.getByTestId('rich-note-editor')).toBeInTheDocument();
  });

  it('renders the End Session button', () => {
    renderSidecarView();
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
  });

  it('renders stage navigation with stage names', () => {
    renderSidecarView();
    expect(screen.getByText('Intro')).toBeInTheDocument();
  });

  it('shows "0 memos" in the toggle button when no memos exist', () => {
    renderSidecarView({ memos: [] });
    // The memo toggle button always shows memo count — "0 memos" when empty
    expect(screen.getByText('0 memos')).toBeInTheDocument();
  });

  it('shows correct memo count in toggle button when memos exist', () => {
    renderSidecarView({
      memos: [
        {
          id: 'm1',
          type: 'highlight',
          text: 'Great answer on leadership',
          tags: [],
          timestamp: 60,
          stageIndex: 0,
          createdAt: new Date(),
        },
      ],
    });
    // The toggle button shows "1 memo" (singular)
    expect(screen.getByText('1 memo')).toBeInTheDocument();
  });

  it('renders the status dot indicating recording state', () => {
    renderSidecarView();
    expect(screen.getByTestId('status-dot')).toBeInTheDocument();
  });
});
