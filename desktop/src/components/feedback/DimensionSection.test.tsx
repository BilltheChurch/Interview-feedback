import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DimensionSection } from './DimensionSection';
import type { DimensionFeedback, FeedbackReport } from './types';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

const mockReport: FeedbackReport = {
  session_id: 'sess_1',
  session_name: 'Test',
  date: '2026-01-01',
  duration_ms: 60000,
  status: 'final',
  mode: '1v1',
  participants: ['Alice'],
  overall: {
    team_summary: '',
    teacher_memos: [],
    interaction_events: [],
    team_dynamics: [],
    evidence_refs: [],
  },
  persons: [],
  evidence: [],
  transcript: [],
  utteranceEvidenceMap: {},
};

function makeDim(overrides: Partial<DimensionFeedback> = {}): DimensionFeedback {
  return {
    dimension: 'leadership',
    label_zh: '领导力',
    score: 7.5,
    claims: [
      { id: 'c1', text: 'Strong presence', category: 'strength', confidence: 0.9, evidence_refs: [] },
      { id: 'c2', text: 'Needs improvement in delegation', category: 'risk', confidence: 0.7, evidence_refs: [] },
    ],
    ...overrides,
  };
}

const noop = vi.fn();

describe('DimensionSection', () => {
  it('renders dimension label', () => {
    render(
      <DimensionSection
        dim={makeDim()}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    expect(screen.getByText('领导力')).toBeInTheDocument();
  });

  it('renders score when provided', () => {
    render(
      <DimensionSection
        dim={makeDim({ score: 7.5 })}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    expect(screen.getByText('7.5')).toBeInTheDocument();
  });

  it('renders score rationale when provided', () => {
    render(
      <DimensionSection
        dim={makeDim({ score_rationale: 'Excellent leadership shown.' })}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    expect(screen.getByText('Excellent leadership shown.')).toBeInTheDocument();
  });

  it('shows claim counts in header (1S 1R)', () => {
    render(
      <DimensionSection
        dim={makeDim()}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    expect(screen.getByText('1S')).toBeInTheDocument();
    expect(screen.getByText('1R')).toBeInTheDocument();
  });

  it('claims are hidden until the section is expanded', () => {
    render(
      <DimensionSection
        dim={makeDim()}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    expect(screen.queryByText('Strong presence')).not.toBeInTheDocument();
  });

  it('expands claims when the header button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <DimensionSection
        dim={makeDim()}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('Strong presence')).toBeInTheDocument();
    expect(screen.getByText('Needs improvement in delegation')).toBeInTheDocument();
  });

  it('collapses claims when header is clicked twice', async () => {
    const user = userEvent.setup();
    render(
      <DimensionSection
        dim={makeDim()}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    const btn = screen.getByRole('button');
    await user.click(btn);
    expect(screen.getByText('Strong presence')).toBeInTheDocument();
    await user.click(btn);
    expect(screen.queryByText('Strong presence')).not.toBeInTheDocument();
  });

  it('shows dimension improvement advice when provided and expanded', async () => {
    const user = userEvent.setup();
    render(
      <DimensionSection
        dim={makeDim()}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
        dimensionImprovement={{
          dimension: 'leadership',
          advice: 'Use the STAR framework more consistently.',
          framework: 'STAR',
          example_response: 'In situation X, I took action Y...',
        }}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('Use the STAR framework more consistently.')).toBeInTheDocument();
    expect(screen.getByText('推荐框架: STAR')).toBeInTheDocument();
  });

  it('shows 不适用 label when dimension is not applicable', () => {
    render(
      <DimensionSection
        dim={makeDim({ not_applicable: true })}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    expect(screen.getByText('不适用')).toBeInTheDocument();
  });

  it('falls back to capitalized dimension name when label_zh is absent', () => {
    render(
      <DimensionSection
        dim={makeDim({ dimension: 'initiative', label_zh: undefined })}
        report={mockReport}
        onClaimEdit={noop}
        onEvidenceClick={noop}
        onNeedsEvidence={noop}
      />,
    );
    expect(screen.getByText('Initiative')).toBeInTheDocument();
  });
});
