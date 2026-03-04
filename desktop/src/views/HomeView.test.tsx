import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HomeView } from './HomeView';

// Mock motion/react to avoid animation complexity in tests
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock hooks that have external dependencies
vi.mock('../hooks/useCalendar', () => ({
  useCalendar: () => ({
    status: 'disconnected',
    meetings: [],
    connectMicrosoft: vi.fn(),
    connectGoogle: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('../hooks/useSessionOrchestrator', () => ({
  useSessionOrchestrator: () => ({
    resume: vi.fn(),
  }),
}));

vi.mock('../stores/sessionStore', () => ({
  getPersistedSession: vi.fn(() => null),
  clearPersistedSession: vi.fn(),
  useSessionStore: vi.fn(),
}));

vi.mock('../lib/animations', () => ({
  staggerContainer: {},
  staggerItem: {},
}));

function renderHomeView() {
  return render(
    <MemoryRouter>
      <HomeView />
    </MemoryRouter>,
  );
}

describe('HomeView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the Chorus brand name', () => {
    renderHomeView();
    expect(screen.getByText('Chorus')).toBeInTheDocument();
  });

  it('renders the Start Interview card', () => {
    renderHomeView();
    expect(screen.getByText('Start Interview')).toBeInTheDocument();
  });

  it('renders mode toggle with 1v1 and Group options', () => {
    renderHomeView();
    expect(screen.getByText('1 v 1')).toBeInTheDocument();
    expect(screen.getByText('Group')).toBeInTheDocument();
  });

  it('renders the session name input field', () => {
    renderHomeView();
    expect(screen.getByPlaceholderText(/e\.g\. John Doe Interview/i)).toBeInTheDocument();
  });

  it('renders the Start Session button', () => {
    renderHomeView();
    expect(screen.getByRole('button', { name: /start session/i })).toBeInTheDocument();
  });

  it('switches mode to Group when Group button is clicked', async () => {
    const user = userEvent.setup();
    renderHomeView();
    const groupBtn = screen.getByText('Group');
    await user.click(groupBtn);
    // After clicking Group, the placeholder should change
    expect(screen.getByPlaceholderText(/e\.g\. Panel Round 2/i)).toBeInTheDocument();
  });

  it('renders Upcoming Meetings section', () => {
    renderHomeView();
    expect(screen.getByText('Upcoming Meetings')).toBeInTheDocument();
  });

  it('renders Pending Feedback section', () => {
    renderHomeView();
    expect(screen.getByText('Pending Feedback')).toBeInTheDocument();
  });

  it('shows calendar not connected state when calendar is disconnected', () => {
    renderHomeView();
    expect(screen.getByText('Calendar not connected')).toBeInTheDocument();
  });

  it('shows "All caught up" when no pending sessions', () => {
    renderHomeView();
    expect(screen.getByText('All caught up')).toBeInTheDocument();
  });

  it('shows greeting text based on time of day', () => {
    renderHomeView();
    // Greeting should be one of: Good morning, Good afternoon, Good evening
    const greetingEl = screen.getByText(/good (morning|afternoon|evening)/i);
    expect(greetingEl).toBeInTheDocument();
  });

  it('does not show ActiveSessionCard when no recoverable session', () => {
    renderHomeView();
    expect(screen.queryByText('Recoverable Session')).not.toBeInTheDocument();
  });

  it('shows ActiveSessionCard when a recoverable session exists', async () => {
    const { getPersistedSession } = await import('../stores/sessionStore');
    vi.mocked(getPersistedSession).mockReturnValue({
      sessionId: 'sess_1',
      sessionName: 'Interrupted Interview',
      mode: '1v1',
      participants: [{ name: 'Bob' }],
      elapsedSeconds: 125,
      stages: [],
      baseApiUrl: 'http://localhost:8787',
      startedAt: Date.now(),
    });

    renderHomeView();
    expect(screen.getByText('Recoverable Session')).toBeInTheDocument();
    expect(screen.getByText('Interrupted Interview')).toBeInTheDocument();
  });
});
