import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnrollmentWizard } from './EnrollmentWizard';

const defaultParticipants = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

const defaultSpeakers = [
  { id: 'spk_001', label: 'Speaker 1' },
  { id: 'spk_002', label: 'Speaker 2' },
];

describe('EnrollmentWizard', () => {
  it('renders all participant names', () => {
    render(
      <EnrollmentWizard participants={defaultParticipants} availableSpeakers={defaultSpeakers} />
    );
    // Alice appears both in the header and the capture prompt ("Ask Alice to speak...")
    const aliceEls = screen.getAllByText('Alice');
    expect(aliceEls.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows enrollment heading and progress counter', () => {
    render(
      <EnrollmentWizard participants={defaultParticipants} availableSpeakers={defaultSpeakers} />
    );
    expect(screen.getByText('Enrollment')).toBeInTheDocument();
    expect(screen.getByText('0/2')).toBeInTheDocument();
  });

  it('shows "Start Capture" button for the active (first) participant', () => {
    render(
      <EnrollmentWizard participants={defaultParticipants} availableSpeakers={defaultSpeakers} />
    );
    expect(screen.getByText('Start Capture')).toBeInTheDocument();
  });

  it('calls onStartCapture when "Start Capture" is clicked', async () => {
    const user = userEvent.setup();
    const onStartCapture = vi.fn();
    render(
      <EnrollmentWizard
        participants={defaultParticipants}
        availableSpeakers={defaultSpeakers}
        onStartCapture={onStartCapture}
      />
    );
    await user.click(screen.getByText('Start Capture'));
    expect(onStartCapture).toHaveBeenCalledWith('p1');
  });

  it('transitions to capturing state and shows Stop button', async () => {
    const user = userEvent.setup();
    render(
      <EnrollmentWizard participants={defaultParticipants} availableSpeakers={defaultSpeakers} />
    );
    await user.click(screen.getByText('Start Capture'));
    // After clicking Start Capture, the status changes to 'capturing'
    expect(screen.getByText('Capturing...')).toBeInTheDocument();
    expect(screen.getByText('Stop')).toBeInTheDocument();
    expect(screen.getByText('Listening...')).toBeInTheDocument();
  });

  it('calls onStopCapture and transitions to captured state with review buttons', async () => {
    const user = userEvent.setup();
    const onStopCapture = vi.fn();
    render(
      <EnrollmentWizard
        participants={defaultParticipants}
        availableSpeakers={defaultSpeakers}
        onStopCapture={onStopCapture}
      />
    );
    // Start capture first
    await user.click(screen.getByText('Start Capture'));
    // Stop capture
    await user.click(screen.getByText('Stop'));
    expect(onStopCapture).toHaveBeenCalledWith('p1');
    // Now in captured/review state
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
    expect(screen.getByText('Skip')).toBeInTheDocument();
  });

  it('confirms enrollment and calls onConfirm callback', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <EnrollmentWizard
        participants={defaultParticipants}
        availableSpeakers={defaultSpeakers}
        onConfirm={onConfirm}
      />
    );
    // Capture then stop
    await user.click(screen.getByText('Start Capture'));
    await user.click(screen.getByText('Stop'));
    // Confirm
    await user.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
    // First arg is participant id, second is the speaker id
    expect(onConfirm.mock.calls[0][0]).toBe('p1');
  });

  it('updates progress counter after confirmation', async () => {
    const user = userEvent.setup();
    render(
      <EnrollmentWizard participants={defaultParticipants} availableSpeakers={defaultSpeakers} />
    );
    await user.click(screen.getByText('Start Capture'));
    await user.click(screen.getByText('Stop'));
    await user.click(screen.getByText('Confirm'));
    // Progress should update to 1/2
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('skipping a participant moves to the next one', async () => {
    const user = userEvent.setup();
    render(
      <EnrollmentWizard participants={defaultParticipants} availableSpeakers={defaultSpeakers} />
    );
    // Capture then stop to get to review state
    await user.click(screen.getByText('Start Capture'));
    await user.click(screen.getByText('Stop'));
    // Skip
    await user.click(screen.getByText('Skip'));
    // Alice should show as Skipped
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('retrying goes back to pending state', async () => {
    const user = userEvent.setup();
    render(
      <EnrollmentWizard participants={defaultParticipants} availableSpeakers={defaultSpeakers} />
    );
    await user.click(screen.getByText('Start Capture'));
    await user.click(screen.getByText('Stop'));
    // Retry
    await user.click(screen.getByText('Retry'));
    // Should return to pending state with Start Capture available again
    expect(screen.getByText('Start Capture')).toBeInTheDocument();
    // Both participants are in 'pending' / 'Waiting' state
    const waitingChips = screen.getAllByText('Waiting');
    expect(waitingChips.length).toBeGreaterThanOrEqual(1);
  });

  it('renders with a single participant', () => {
    render(
      <EnrollmentWizard
        participants={[{ id: 'solo', name: 'Solo Speaker' }]}
        availableSpeakers={defaultSpeakers}
      />
    );
    // "Solo Speaker" appears in both the header row and the capture prompt
    const soloEls = screen.getAllByText('Solo Speaker');
    expect(soloEls.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('0/1')).toBeInTheDocument();
  });
});
