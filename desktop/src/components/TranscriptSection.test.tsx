import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TranscriptSection, type TranscriptUtterance } from './TranscriptSection';

/**
 * jsdom always reports element sizes as 0, so @tanstack/react-virtual (which
 * measures the scroll container via offsetWidth/offsetHeight) renders no rows.
 * Stub those props with non-zero sizes so virtual items are produced and their
 * timestamps can be asserted.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return 600; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return 500; },
  });
});

describe('TranscriptSection', () => {
  it('renders a distinct timestamp for EACH utterance of the same speaker', () => {
    // Two consecutive utterances from the same speaker at different start times.
    // Previously the grouped view showed only ONE header timestamp (00:00);
    // now each utterance must surface its own real timestamp.
    const transcript: TranscriptUtterance[] = [
      { utterance_id: 'u1', speaker_name: 'Tim', text: 'First sentence.', start_ms: 0, end_ms: 3000 },
      { utterance_id: 'u2', speaker_name: 'Tim', text: 'Second sentence.', start_ms: 12000, end_ms: 15000 },
      { utterance_id: 'u3', speaker_name: 'Tim', text: 'Third sentence.', start_ms: 42000, end_ms: 45000 },
    ];

    render(<TranscriptSection transcript={transcript} evidenceMap={{}} />);

    // Each real start time must appear as its own timestamp.
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(screen.getByText('00:12')).toBeInTheDocument();
    expect(screen.getByText('00:42')).toBeInTheDocument();

    // Sanity: all three sentences render.
    expect(screen.getByText('First sentence.')).toBeInTheDocument();
    expect(screen.getByText('Second sentence.')).toBeInTheDocument();
    expect(screen.getByText('Third sentence.')).toBeInTheDocument();
  });

  it('keeps the speaker label visible while showing per-utterance timestamps', () => {
    const transcript: TranscriptUtterance[] = [
      { utterance_id: 'u1', speaker_name: 'Alice', text: 'Hello.', start_ms: 1000, end_ms: 2000 },
      { utterance_id: 'u2', speaker_name: 'Alice', text: 'World.', start_ms: 8000, end_ms: 9000 },
    ];

    render(<TranscriptSection transcript={transcript} evidenceMap={{}} />);

    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    // 00:01 and 00:08 both present → per-utterance timestamps, not a single header.
    expect(screen.getByText('00:01')).toBeInTheDocument();
    expect(screen.getByText('00:08')).toBeInTheDocument();
  });

  it('renders a SINGLE header timestamp when a group\'s utterances share the same start_ms', () => {
    // Degraded / legacy data: every utterance has start_ms 0. Must NOT produce a
    // column of identical 00:00 stamps — just one header timestamp.
    const transcript: TranscriptUtterance[] = [
      { utterance_id: 'u1', speaker_name: 'Tim', text: 'One.', start_ms: 0, end_ms: 0 },
      { utterance_id: 'u2', speaker_name: 'Tim', text: 'Two.', start_ms: 0, end_ms: 0 },
      { utterance_id: 'u3', speaker_name: 'Tim', text: 'Three.', start_ms: 0, end_ms: 0 },
    ];

    render(<TranscriptSection transcript={transcript} evidenceMap={{}} />);

    // Exactly one 00:00 for the whole group, not one per utterance.
    expect(screen.getAllByText('00:00')).toHaveLength(1);
    // All three sentences still render.
    expect(screen.getByText('One.')).toBeInTheDocument();
    expect(screen.getByText('Two.')).toBeInTheDocument();
    expect(screen.getByText('Three.')).toBeInTheDocument();
  });

  it('shows per-utterance timestamps only for groups with distinct times, single header otherwise', () => {
    const transcript: TranscriptUtterance[] = [
      // Group A (Tim): distinct times → per-utterance timestamps.
      { utterance_id: 'a1', speaker_name: 'Tim', text: 'Alpha.', start_ms: 5000, end_ms: 6000 },
      { utterance_id: 'a2', speaker_name: 'Tim', text: 'Beta.', start_ms: 20000, end_ms: 21000 },
      // Group B (Sara): identical times → one header timestamp.
      { utterance_id: 'b1', speaker_name: 'Sara', text: 'Gamma.', start_ms: 30000, end_ms: 30000 },
      { utterance_id: 'b2', speaker_name: 'Sara', text: 'Delta.', start_ms: 30000, end_ms: 30000 },
    ];

    render(<TranscriptSection transcript={transcript} evidenceMap={{}} />);

    // Group A: both distinct timestamps present.
    expect(screen.getByText('00:05')).toBeInTheDocument();
    expect(screen.getByText('00:20')).toBeInTheDocument();
    // Group B: single header timestamp (only one 00:30, not two).
    expect(screen.getAllByText('00:30')).toHaveLength(1);
  });
});
