import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SetupView } from './SetupView';
import { getPresetByType } from '../lib/dimensionPresets';

// Mock motion/react to avoid animation complexity in tests.
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => <span {...props}>{children}</span>,
    li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => <li {...props}>{children}</li>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Capture the config passed to startSession.
const startMock = vi.fn();
vi.mock('../hooks/useSessionOrchestrator', () => ({
  useSessionOrchestrator: () => ({
    start: startMock,
  }),
}));

// Treat consent as already granted so "Join & Start" calls startSession directly.
vi.mock('../components/ConsentDialog', () => ({
  ConsentDialog: () => null,
  hasValidConsent: () => true,
}));

// Stub the desktop IPC bridge used during start.
beforeEach(() => {
  // @ts-expect-error — partial stub of the desktopAPI bridge for tests
  window.desktopAPI = {
    getEdgeBaseUrl: vi.fn(async () => 'http://localhost:8787'),
    openExternalUrl: vi.fn(async () => {}),
    copyToClipboard: vi.fn(async () => {}),
    calendarCreateCalendarEvent: vi.fn(),
  };
  localStorage.clear();
  startMock.mockClear();
});

function renderSetup() {
  return render(
    <MemoryRouter>
      <SetupView />
    </MemoryRouter>,
  );
}

// Navigate from Step 1 (Basics) to Step 2 (Template & Flow).
async function goToStep2(user: ReturnType<typeof userEvent.setup>) {
  const continueBtn = screen.getByRole('button', { name: /continue/i });
  await user.click(continueBtn);
}

describe('SetupView Step 2 — Evaluation Rubric consolidation', () => {
  it('renders the EvaluationRubricEditor and Interview Flow on Step 2', async () => {
    const user = userEvent.setup();
    renderSetup();
    await goToStep2(user);

    // EvaluationRubricEditor signature markers.
    expect(screen.getByText('Evaluation Dimensions')).toBeInTheDocument();
    expect(
      screen.getByText(/These dimensions are what the AI uses to score each candidate/i),
    ).toBeInTheDocument();

    // Interview Flow (FlowEditor) must still be present.
    expect(screen.getByText('Interview Flow')).toBeInTheDocument();
  });

  it('no longer renders the old "Rubric Template" or "面试类型" cards', async () => {
    const user = userEvent.setup();
    renderSetup();
    await goToStep2(user);

    expect(screen.queryByText('Rubric Template')).not.toBeInTheDocument();
    expect(screen.queryByText('面试类型')).not.toBeInTheDocument();
    expect(screen.queryByText('评估维度')).not.toBeInTheDocument();
    expect(screen.queryByText('General Interview')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Custom Template')).not.toBeInTheDocument();
  });

  it('seeds a populated default rubric immediately on Step 2', async () => {
    const user = userEvent.setup();
    renderSetup();
    await goToStep2(user);

    // The default rubric should already show dimension rows (not an empty editor).
    const rows = screen.getAllByTestId('dimension-row');
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('passes interviewType + non-empty dimensionPresets to startSession', async () => {
    const user = userEvent.setup();
    renderSetup();

    // Step 1 → Step 2.
    await goToStep2(user);
    // Step 2 → Step 3 (Review).
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Start the session.
    await user.click(screen.getByRole('button', { name: /join & start session/i }));

    expect(startMock).toHaveBeenCalledTimes(1);
    const cfg = startMock.mock.calls[0][0];
    expect(cfg).toHaveProperty('interviewType');
    expect(typeof cfg.interviewType).toBe('string');
    expect(cfg.interviewType.length).toBeGreaterThan(0);
    expect(Array.isArray(cfg.dimensionPresets)).toBe(true);
    expect(cfg.dimensionPresets.length).toBeGreaterThanOrEqual(3);
    // Each dimension carries the contract shape.
    for (const dim of cfg.dimensionPresets) {
      expect(dim).toHaveProperty('key');
      expect(dim).toHaveProperty('label_en');
      expect(dim).toHaveProperty('weight');
    }
  });

  it('seeds the academic preset as the default rubric type', async () => {
    const user = userEvent.setup();
    renderSetup();

    await goToStep2(user);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /join & start session/i }));

    const cfg = startMock.mock.calls[0][0];
    expect(cfg.interviewType).toBe('academic');
  });

  it('shows the rubric label in English (no CJK) on the Review step', async () => {
    const user = userEvent.setup();
    renderSetup();

    await goToStep2(user);
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Review step: locate the summary card via its "Rubric" field label, then
    // assert the rendered label is English with no CJK (D6 English-only).
    // The default type is academic → "Academic · N dimensions".
    const rubricFieldLabel = screen.getByText('Rubric');
    const reviewCard = rubricFieldLabel.closest('div.border')!;
    expect(reviewCard).not.toBeNull();
    expect(reviewCard.textContent).toMatch(/Academic/);
    expect(reviewCard.textContent ?? '').not.toMatch(/[一-鿿]/);
  });

  it('1v1: filling the Candidate name field seeds a non-empty participant to startSession', async () => {
    const user = userEvent.setup();
    renderSetup();

    // Default mode is 1v1. A dedicated "Candidate" field must exist so 1v1
    // users have a place to name the interviewee (Participants editor is
    // group-only).
    const candidateInput = screen.getByPlaceholderText(/candidate/i);
    await user.type(candidateInput, 'Alice Zhang');

    await goToStep2(user);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /join & start session/i }));

    expect(startMock).toHaveBeenCalledTimes(1);
    const cfg = startMock.mock.calls[0][0];
    expect(Array.isArray(cfg.participants)).toBe(true);
    expect(cfg.participants.length).toBeGreaterThanOrEqual(1);
    expect(cfg.participants.map((p: { name: string }) => p.name)).toContain('Alice Zhang');
  });

  it('1v1: an empty Candidate name still yields a non-empty participant (placeholder)', async () => {
    const user = userEvent.setup();
    renderSetup();

    // Do not fill the candidate name — 1v1 roster must never be empty.
    await goToStep2(user);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /join & start session/i }));

    expect(startMock).toHaveBeenCalledTimes(1);
    const cfg = startMock.mock.calls[0][0];
    expect(Array.isArray(cfg.participants)).toBe(true);
    expect(cfg.participants.length).toBeGreaterThanOrEqual(1);
    expect(cfg.participants[0].name.trim().length).toBeGreaterThan(0);
  });

  it('group mode: the Participants editor still drives the roster (no regression)', async () => {
    const user = userEvent.setup();
    renderSetup();

    // Switch to group mode. The 1v1 Candidate field must disappear and the
    // Participants editor must be the source of the roster.
    await user.click(screen.getByRole('button', { name: /group/i }));
    expect(screen.queryByPlaceholderText(/candidate/i)).not.toBeInTheDocument();

    // Add two participants via the Participants editor.
    const nameInput = screen.getByPlaceholderText(/participant name/i);
    await user.type(nameInput, 'Bob');
    await user.keyboard('{Enter}');
    await user.type(nameInput, 'Carol');
    await user.keyboard('{Enter}');

    await goToStep2(user);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /join & start session/i }));

    expect(startMock).toHaveBeenCalledTimes(1);
    const cfg = startMock.mock.calls[0][0];
    const names = cfg.participants.map((p: { name: string }) => p.name);
    expect(names).toContain('Bob');
    expect(names).toContain('Carol');
  });

  it('switching to the Technical pill flows interviewType + matching dimensions to startSession', async () => {
    const user = userEvent.setup();
    renderSetup();

    await goToStep2(user);

    // Click the "Technical" type pill inside the EvaluationRubricEditor.
    // This exercises onChange → setInterviewType/setDimensionPresets in SetupView.
    await user.click(screen.getByRole('button', { name: 'Technical' }));

    // Advance Step 2 → Review, then start.
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /join & start session/i }));

    expect(startMock).toHaveBeenCalledTimes(1);
    const cfg = startMock.mock.calls[0][0];
    expect(cfg.interviewType).toBe('technical');

    // dimensionPresets must mirror the Technical preset (keys from
    // getPresetByType('technical').dimensions).
    const technical = getPresetByType('technical')!;
    const expectedKeys = technical.dimensions.map((d) => d.key);
    const actualKeys = cfg.dimensionPresets.map((d: { key: string }) => d.key);
    expect(actualKeys).toEqual(expectedKeys);
    // Spot-check a couple of Technical-specific keys.
    expect(actualKeys).toContain('coding_ability');
    expect(actualKeys).toContain('problem_analysis');
  });
});
