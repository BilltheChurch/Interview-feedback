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
