import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EnrollmentPanel, ParticipationSignals } from './ParticipantPanel';
import type { Participant } from './types';

// Mock motion/react so animated wrappers render as plain elements in jsdom.
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

vi.mock('lucide-react', () => ({
  Check: () => <span data-icon="Check" />,
  AlertTriangle: () => <span data-icon="AlertTriangle" />,
  X: () => <span data-icon="X" />,
}));

vi.mock('../ui/StatusDot', () => ({
  StatusDot: ({ status }: { status: string }) => <span data-testid="status-dot" data-status={status} />,
}));
vi.mock('../ui/ConfidenceBadge', () => ({
  ConfidenceBadge: ({ score }: { score: number }) => <span data-testid="confidence-badge">{score}</span>,
}));

function p(over: Partial<Participant> & { name: string }): Participant {
  return { status: 'pending', talkTimePct: 0, turnCount: 0, ...over };
}

/**
 * Empty-state guard: both signal panels render a plain `participants.map`. With no
 * participants the section title would otherwise sit above an empty body, so each
 * panel must render a hint instead.
 */
describe('EnrollmentPanel — empty state', () => {
  it('shows a hint when there are no participants', () => {
    render(<EnrollmentPanel participants={[]} onEnroll={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText(/no participants yet/i)).toBeInTheDocument();
  });

  it('renders participant rows when present (no hint)', () => {
    render(
      <EnrollmentPanel participants={[p({ name: 'Alice' })]} onEnroll={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText(/no participants yet/i)).not.toBeInTheDocument();
  });
});

describe('ParticipationSignals — empty state', () => {
  it('shows a hint when there are no participants', () => {
    render(<ParticipationSignals participants={[]} />);
    expect(screen.getByText(/no participants yet/i)).toBeInTheDocument();
  });

  it('renders talk-time rows when present (no hint)', () => {
    render(
      <ParticipationSignals participants={[p({ name: 'Alice', talkTimePct: 40, turnCount: 3 })]} />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('40% / 3t')).toBeInTheDocument();
    expect(screen.queryByText(/no participants yet/i)).not.toBeInTheDocument();
  });
});
