import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClaimCard } from './ClaimCard';
import type { Claim, FeedbackReport } from './types';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

const mockReport: FeedbackReport = {
  session_id: 'sess_1',
  session_name: 'Test Session',
  date: '2026-01-01',
  duration_ms: 60000,
  status: 'final',
  mode: '1v1',
  participants: ['Alice'],
  overall: {
    team_summary: 'Good session',
    teacher_memos: [],
    interaction_events: [],
    team_dynamics: [],
    evidence_refs: [],
  },
  persons: [],
  evidence: [
    {
      id: 'ev_1',
      timestamp_ms: 5000,
      speaker: 'Alice',
      text: 'She clearly explained the problem.',
      confidence: 0.9,
    },
  ],
  transcript: [],
  utteranceEvidenceMap: {},
};

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'c1',
    text: 'Demonstrated strong leadership.',
    category: 'strength',
    confidence: 0.8,
    evidence_refs: [],
    ...overrides,
  };
}

const noop = vi.fn();

describe('ClaimCard', () => {
  it('renders the claim text', () => {
    render(
      <ClaimCard
        claim={makeClaim()}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
      />,
    );
    expect(screen.getByText('Demonstrated strong leadership.')).toBeInTheDocument();
  });

  it('shows "Needs Evidence" chip when claim has no evidence refs', () => {
    render(
      <ClaimCard
        claim={makeClaim({ evidence_refs: [] })}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
      />,
    );
    expect(screen.getByText('Needs Evidence')).toBeInTheDocument();
  });

  it('calls onNeedsEvidenceClick when "Needs Evidence" is clicked', async () => {
    const user = userEvent.setup();
    const onNeedsEvidenceClick = vi.fn();
    render(
      <ClaimCard
        claim={makeClaim({ evidence_refs: [] })}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={onNeedsEvidenceClick}
      />,
    );
    await user.click(screen.getByText('Needs Evidence'));
    expect(onNeedsEvidenceClick).toHaveBeenCalledOnce();
  });

  it('shows edit button', () => {
    render(
      <ClaimCard
        claim={makeClaim()}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
      />,
    );
    expect(screen.getByLabelText('Edit claim')).toBeInTheDocument();
  });

  it('calls onEditClick when edit button is clicked', async () => {
    const user = userEvent.setup();
    const onEditClick = vi.fn();
    render(
      <ClaimCard
        claim={makeClaim()}
        report={mockReport}
        onEditClick={onEditClick}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
      />,
    );
    await user.click(screen.getByLabelText('Edit claim'));
    expect(onEditClick).toHaveBeenCalledOnce();
  });

  it('shows evidence chip when claim has evidence refs', () => {
    render(
      <ClaimCard
        claim={makeClaim({ evidence_refs: ['ev_1'] })}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
      />,
    );
    // EvidenceChip renders timestamp (00:05) and speaker ('Alice')
    // Text may be split across spans — use getAllByText with regex
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it('renders improvement advice when improvement is provided', () => {
    render(
      <ClaimCard
        claim={makeClaim()}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
        improvement={{
          claim_id: 'c1',
          advice: 'Provide more specific examples.',
          suggested_wording: 'She led the team through a complex migration.',
          before_after: null,
        }}
      />,
    );
    expect(screen.getByText('Provide more specific examples.')).toBeInTheDocument();
    expect(screen.getByText('"She led the team through a complex migration."')).toBeInTheDocument();
  });

  it('renders before/after section when improvement has before_after', () => {
    render(
      <ClaimCard
        claim={makeClaim()}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
        improvement={{
          claim_id: 'c1',
          advice: 'Be more specific.',
          suggested_wording: '',
          before_after: { before: 'She led.', after: 'She led a team of 5 engineers.' },
        }}
      />,
    );
    expect(screen.getByText('She led.')).toBeInTheDocument();
    expect(screen.getByText('She led a team of 5 engineers.')).toBeInTheDocument();
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
  });

  it('applies strength border style for strength category', () => {
    const { container } = render(
      <ClaimCard
        claim={makeClaim({ category: 'strength' })}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
      />,
    );
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-l-emerald-400');
  });

  it('applies risk border style for risk category', () => {
    const { container } = render(
      <ClaimCard
        claim={makeClaim({ category: 'risk' })}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
      />,
    );
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-l-amber-400');
  });

  it('applies action border style for action category', () => {
    const { container } = render(
      <ClaimCard
        claim={makeClaim({ category: 'action' })}
        report={mockReport}
        onEditClick={noop}
        onEvidenceClick={noop}
        onNeedsEvidenceClick={noop}
      />,
    );
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-l-blue-400');
  });
});
