import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EvidenceDetailModal, EditClaimModal } from './FeedbackModals';
import type { Claim, EvidenceRef, FeedbackReport } from './types';

// Stub window.desktopAPI for regenerateFeedbackClaim
const mockRegenerateFeedbackClaim = vi.fn();

beforeEach(() => {
  // Patch desktopAPI onto the existing window object (preserves navigator.clipboard etc.)
  (window as unknown as Record<string, unknown>).desktopAPI = {
    regenerateFeedbackClaim: mockRegenerateFeedbackClaim,
  };
  // Stub navigator.clipboard inside beforeEach so window is fully initialised
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn(), readText: vi.fn() },
    writable: true,
    configurable: true,
  });
});

const mockEvidence: EvidenceRef = {
  id: 'ev_1',
  timestamp_ms: 5000,
  end_ms: 8000,
  speaker: 'Alice',
  text: 'She clearly identified the core issue.',
  confidence: 0.85,
};

const mockReport: FeedbackReport = {
  session_id: 'sess_1',
  session_name: 'Test Session',
  date: '2026-03-01',
  duration_ms: 120000,
  status: 'final',
  mode: '1v1',
  participants: ['Alice', 'Bob'],
  overall: {
    team_summary: 'Good session.',
    teacher_memos: [],
    interaction_events: [],
    team_dynamics: [],
    evidence_refs: [],
  },
  persons: [
    {
      person_name: 'Alice',
      dimensions: [
        {
          dimension: 'problem_solving',
          score: 8,
          claims: [
            {
              id: 'c1',
              text: 'Demonstrated strong analytical skills.',
              category: 'strength',
              confidence: 0.9,
              evidence_refs: ['ev_1'],
            },
          ],
        },
      ],
      summary: { strengths: 'Analytical', risks: '', actions: '' },
    },
  ],
  evidence: [mockEvidence],
  transcript: [
    { utterance_id: 'u1', speaker_name: 'Alice', text: 'She clearly identified the core issue.', start_ms: 5000, end_ms: 8000 },
  ],
  utteranceEvidenceMap: { u1: ['ev_1'] },
};

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'c1',
    text: 'Demonstrated strong analytical skills.',
    category: 'strength',
    confidence: 0.9,
    evidence_refs: ['ev_1'],
    ...overrides,
  };
}

const noop = vi.fn();

describe('EvidenceDetailModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when open=false', () => {
    const { container } = render(
      <EvidenceDetailModal
        open={false}
        onClose={noop}
        evidence={mockEvidence}
        report={mockReport}
        mode="browse"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when evidence is null', () => {
    const { container } = render(
      <EvidenceDetailModal
        open={true}
        onClose={noop}
        evidence={null}
        report={mockReport}
        mode="browse"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the modal title when open', () => {
    render(
      <EvidenceDetailModal
        open={true}
        onClose={noop}
        evidence={mockEvidence}
        report={mockReport}
        mode="browse"
      />,
    );
    expect(screen.getByText('Evidence Detail')).toBeInTheDocument();
  });

  it('displays the evidence speaker name', () => {
    render(
      <EvidenceDetailModal
        open={true}
        onClose={noop}
        evidence={mockEvidence}
        report={mockReport}
        mode="browse"
      />,
    );
    // Alice appears as evidence speaker (may also appear in referenced claims section)
    const aliceEls = screen.getAllByText('Alice');
    expect(aliceEls.length).toBeGreaterThan(0);
  });

  it('displays the evidence quote text', () => {
    render(
      <EvidenceDetailModal
        open={true}
        onClose={noop}
        evidence={mockEvidence}
        report={mockReport}
        mode="browse"
      />,
    );
    // The quote appears in multiple contexts (evidence block + conversation context)
    const quoteEls = screen.getAllByText(/She clearly identified the core issue\./);
    expect(quoteEls.length).toBeGreaterThan(0);
  });

  it('shows "Use as Evidence" button in browse mode', () => {
    render(
      <EvidenceDetailModal
        open={true}
        onClose={noop}
        evidence={mockEvidence}
        report={mockReport}
        mode="browse"
        onUseAsEvidence={vi.fn()}
      />,
    );
    // May have multiple buttons with this text; at least one should exist
    const btns = screen.getAllByRole('button', { name: /use as evidence/i });
    expect(btns.length).toBeGreaterThan(0);
  });

  it('calls onUseAsEvidence when button is clicked', async () => {
    const user = userEvent.setup();
    const onUseAsEvidence = vi.fn();
    render(
      <EvidenceDetailModal
        open={true}
        onClose={noop}
        evidence={mockEvidence}
        report={mockReport}
        mode="browse"
        onUseAsEvidence={onUseAsEvidence}
      />,
    );
    const btns = screen.getAllByRole('button', { name: /use as evidence/i });
    await user.click(btns[0]);
    expect(onUseAsEvidence).toHaveBeenCalledOnce();
  });

  it('shows "Remove" button in claim-editor mode', () => {
    render(
      <EvidenceDetailModal
        open={true}
        onClose={noop}
        evidence={mockEvidence}
        report={mockReport}
        mode="claim-editor"
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  it('calls onClose when Close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <EvidenceDetailModal
        open={true}
        onClose={onClose}
        evidence={mockEvidence}
        report={mockReport}
        mode="browse"
      />,
    );
    // Use the visible Close text button (not the X icon button)
    const closeBtns = screen.getAllByRole('button', { name: /close/i });
    await user.click(closeBtns[closeBtns.length - 1]);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('EditClaimModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when open=false', () => {
    const { container } = render(
      <EditClaimModal
        open={false}
        onClose={noop}
        claim={makeClaim()}
        report={mockReport}
        onEvidenceClick={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when claim is null', () => {
    const { container } = render(
      <EditClaimModal
        open={true}
        onClose={noop}
        claim={null}
        report={mockReport}
        onEvidenceClick={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders modal title "Edit Claim" when open', () => {
    render(
      <EditClaimModal
        open={true}
        onClose={noop}
        claim={makeClaim()}
        report={mockReport}
        onEvidenceClick={noop}
      />,
    );
    expect(screen.getByText('Edit Claim')).toBeInTheDocument();
  });

  it('populates the textarea with the claim text', () => {
    render(
      <EditClaimModal
        open={true}
        onClose={noop}
        claim={makeClaim()}
        report={mockReport}
        onEvidenceClick={noop}
      />,
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Demonstrated strong analytical skills.');
  });

  it('shows Save and Cancel buttons', () => {
    render(
      <EditClaimModal
        open={true}
        onClose={noop}
        claim={makeClaim()}
        report={mockReport}
        onEvidenceClick={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
  });

  it('calls onSave with updated text when Save is clicked', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditClaimModal
        open={true}
        onClose={noop}
        claim={makeClaim({ evidence_refs: [] })}
        report={mockReport}
        onEvidenceClick={noop}
        onSave={onSave}
      />,
    );
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Updated claim text.');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith('c1', 'Updated claim text.', []);
  });

  it('calls onClose when Cancel button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <EditClaimModal
        open={true}
        onClose={onClose}
        claim={makeClaim()}
        report={mockReport}
        onEvidenceClick={noop}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows "No evidence linked" chip when claim has no refs', () => {
    render(
      <EditClaimModal
        open={true}
        onClose={noop}
        claim={makeClaim({ evidence_refs: [] })}
        report={mockReport}
        onEvidenceClick={noop}
      />,
    );
    expect(screen.getByText('No evidence linked')).toBeInTheDocument();
  });

  it('calls regenerateFeedbackClaim when Regenerate button is clicked', async () => {
    const user = userEvent.setup();
    mockRegenerateFeedbackClaim.mockResolvedValue({ text: 'Regenerated claim.', evidence_refs: [] });

    render(
      <EditClaimModal
        open={true}
        onClose={noop}
        claim={makeClaim()}
        report={mockReport}
        onEvidenceClick={noop}
        sessionId="sess_1"
        baseApiUrl="http://localhost:8787"
      />,
    );

    await user.click(screen.getByRole('button', { name: /regenerate with llm/i }));

    await waitFor(() => {
      expect(mockRegenerateFeedbackClaim).toHaveBeenCalled();
    });
  });

  it('updates textarea with regenerated text after successful regeneration', async () => {
    const user = userEvent.setup();
    mockRegenerateFeedbackClaim.mockResolvedValue({ text: 'Regenerated claim.', evidence_refs: [] });

    render(
      <EditClaimModal
        open={true}
        onClose={noop}
        claim={makeClaim()}
        report={mockReport}
        onEvidenceClick={noop}
        sessionId="sess_1"
        baseApiUrl="http://localhost:8787"
      />,
    );

    await user.click(screen.getByRole('button', { name: /regenerate with llm/i }));

    await waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Regenerated claim.');
    });
  });
});
