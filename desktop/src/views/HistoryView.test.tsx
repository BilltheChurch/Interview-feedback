import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HistoryView } from './HistoryView';

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...props}>{children}</h2>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../lib/animations', () => ({
  staggerContainer: {},
  staggerItem: {},
}));

function renderHistoryView() {
  return render(
    <MemoryRouter>
      <HistoryView />
    </MemoryRouter>,
  );
}

function seedSessions(sessions: object[]) {
  localStorage.setItem('ifb_sessions', JSON.stringify(sessions));
}

describe('HistoryView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the Session History heading', () => {
    renderHistoryView();
    expect(screen.getByText('Session History')).toBeInTheDocument();
  });

  it('shows empty state when no sessions exist', () => {
    renderHistoryView();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });

  it('renders session names from localStorage', () => {
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
    ]);
    renderHistoryView();
    expect(screen.getByText('Alice Interview')).toBeInTheDocument();
  });

  it('renders search input', () => {
    renderHistoryView();
    expect(screen.getByPlaceholderText('Search sessions...')).toBeInTheDocument();
  });

  it('filters sessions by search query', async () => {
    const user = userEvent.setup();
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
      { id: 's2', name: 'Bob Panel', date: new Date().toISOString(), mode: 'group', participantCount: 3, status: 'finalized' },
    ]);
    renderHistoryView();
    const searchInput = screen.getByPlaceholderText('Search sessions...');
    await user.type(searchInput, 'alice');
    expect(screen.getByText('Alice Interview')).toBeInTheDocument();
    expect(screen.queryByText('Bob Panel')).not.toBeInTheDocument();
  });

  it('renders filter chips for all statuses', () => {
    renderHistoryView();
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Finalized')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('filters sessions by status chip', async () => {
    const user = userEvent.setup();
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
      { id: 's2', name: 'Bob Panel', date: new Date().toISOString(), mode: 'group', participantCount: 3, status: 'draft' },
    ]);
    renderHistoryView();
    // Click the Finalized filter chip
    const chips = screen.getAllByRole('button', { name: /finalized/i });
    await user.click(chips[0]);
    expect(screen.getByText('Alice Interview')).toBeInTheDocument();
    expect(screen.queryByText('Bob Panel')).not.toBeInTheDocument();
  });

  it('renders a summary strip with total session count', () => {
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
    ]);
    renderHistoryView();
    expect(screen.getByText(/1 total session/)).toBeInTheDocument();
  });

  it('shows Clear All button when sessions exist', () => {
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
    ]);
    renderHistoryView();
    expect(screen.getByRole('button', { name: /clear all/i })).toBeInTheDocument();
  });

  it('does not show Clear All button when no sessions', () => {
    renderHistoryView();
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
  });

  it('shows confirm dialog when delete button is triggered', async () => {
    const user = userEvent.setup();
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
    ]);
    renderHistoryView();
    const deleteBtn = screen.getByLabelText('Delete Alice Interview');
    await user.click(deleteBtn);
    expect(screen.getByText('Delete Session?')).toBeInTheDocument();
  });

  it('shows confirm dialog when Clear All is clicked', async () => {
    const user = userEvent.setup();
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
    ]);
    renderHistoryView();
    await user.click(screen.getByRole('button', { name: /clear all/i }));
    expect(screen.getByText('Clear All Sessions?')).toBeInTheDocument();
  });

  it('cancels deletion when Cancel is clicked in dialog', async () => {
    const user = userEvent.setup();
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
    ]);
    renderHistoryView();
    await user.click(screen.getByRole('button', { name: /clear all/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByText('Clear All Sessions?')).not.toBeInTheDocument();
    expect(screen.getByText('Alice Interview')).toBeInTheDocument();
  });

  it('shows "No sessions found" when search has no results', async () => {
    const user = userEvent.setup();
    seedSessions([
      { id: 's1', name: 'Alice Interview', date: new Date().toISOString(), mode: '1v1', participantCount: 1, status: 'finalized' },
    ]);
    renderHistoryView();
    await user.type(screen.getByPlaceholderText('Search sessions...'), 'zzz_no_match');
    expect(screen.getByText('No sessions found')).toBeInTheDocument();
  });
});
