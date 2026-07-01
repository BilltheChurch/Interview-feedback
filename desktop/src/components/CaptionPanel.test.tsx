import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CaptionPanel } from './CaptionPanel';
import type { TranscriptSegment, PartialTranscript } from '../stores/sessionStore';

/** Force prefers-reduced-motion so the partial-line typewriter reveal (R-D) shows the
 *  full cumulative text immediately — lets content-parity assertions read synchronously
 *  without pumping animation frames, and exercises the reduced-motion path. */
function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

/**
 * R-A: a teacher-role transcript segment is the interviewer. The Worker's
 * `resolveTeacherIdentity` now returns the configured interviewer name (e.g.
 * "Tim") when setup provided one, so the panel must SHOW that real name.
 *
 * The R1 defense-in-depth still holds at the source: the Worker only ever emits
 * a configured interviewer name (never a student name) on teacher frames — R1
 * removed the single-entry-roster → student-name branch. So displaying the real
 * teacher name is safe. The panel only falls back to the generic "Interviewer"
 * label when the speaker is a placeholder (empty / "teacher" / literal
 * "Interviewer").
 */

function seg(partial: Partial<TranscriptSegment> & { id: string }): TranscriptSegment {
  return {
    role: 'students',
    speaker: null,
    text: '',
    isFinal: true,
    tsMs: 0,
    startMs: 0,
    createdAt: 0,
    ...partial,
  };
}

describe('CaptionPanel — teacher/student labelling (R-A)', () => {
  it('shows the real interviewer name the Worker attached to a teacher segment', () => {
    const segments: TranscriptSegment[] = [
      seg({ id: 't1', role: 'teacher', speaker: 'Tim', text: 'How was your week?' }),
    ];
    render(
      <CaptionPanel captions={[]} acsStatus="off" transcriptSegments={segments} />
    );
    expect(screen.getByText('Tim')).toBeInTheDocument();
    expect(screen.queryByText('Interviewer')).not.toBeInTheDocument();
    expect(screen.getByText('How was your week?')).toBeInTheDocument();
  });

  it('falls back to "Interviewer" when the teacher speaker is a placeholder', () => {
    // The Worker sends the generic "teacher" / empty / undefined placeholder when
    // setup provided no interviewer name — these must render as "Interviewer".
    for (const placeholder of ['teacher', '', null] as const) {
      const { unmount } = render(
        <CaptionPanel
          captions={[]}
          acsStatus="off"
          transcriptSegments={[
            seg({ id: 't1', role: 'teacher', speaker: placeholder, text: 'How was your week?' }),
          ]}
        />
      );
      expect(screen.getByText('Interviewer')).toBeInTheDocument();
      unmount();
    }
  });

  it('keeps the literal "Interviewer" label as-is (not a real name)', () => {
    const segments: TranscriptSegment[] = [
      seg({ id: 't1', role: 'teacher', speaker: 'Interviewer', text: 'How was your week?' }),
    ];
    render(
      <CaptionPanel captions={[]} acsStatus="off" transcriptSegments={segments} />
    );
    expect(screen.getByText('Interviewer')).toBeInTheDocument();
  });

  it('shows the student speaker name for a students segment', () => {
    const segments: TranscriptSegment[] = [
      seg({ id: 's1', role: 'students', speaker: 'S1', text: 'It was good, thanks.' }),
    ];
    render(
      <CaptionPanel captions={[]} acsStatus="off" transcriptSegments={segments} />
    );
    expect(screen.getByText('S1')).toBeInTheDocument();
    expect(screen.getByText('It was good, thanks.')).toBeInTheDocument();
  });
});

describe('CaptionPanel — live partial captions (R4)', () => {
  // R-D: the partial body now types in character-by-character. Under reduced-motion the
  // full text renders immediately, so these presence/label assertions stay synchronous.
  beforeEach(() => stubReducedMotion(true));
  afterEach(() => vi.unstubAllGlobals());

  it('renders finals plus a visually distinct in-progress partial line', () => {
    const segments: TranscriptSegment[] = [
      seg({ id: 's1', role: 'students', speaker: 'S1', text: 'Hello there.' }),
    ];
    const partials: Record<string, PartialTranscript> = {
      students: { role: 'students', speaker: 'S1', text: 'and then we' },
    };
    render(
      <CaptionPanel
        captions={[]}
        acsStatus="off"
        transcriptSegments={segments}
        partialTranscripts={partials}
      />
    );
    // The settled final is present.
    expect(screen.getByText('Hello there.')).toBeInTheDocument();
    // The partial row is present, marked as still-in-progress (trailing ellipsis) and
    // rendered inside the dedicated partial container.
    const partialRow = screen.getByTestId('partial-students');
    expect(partialRow).toBeInTheDocument();
    expect(partialRow.textContent).toContain('and then we');
    expect(partialRow.textContent).toContain('…');
  });

  it('shows the real interviewer name on a teacher partial line', () => {
    // The Worker attaches the configured interviewer name to teacher partials too;
    // the partial path must surface it (same rule as settled captions).
    const partials: Record<string, PartialTranscript> = {
      teacher: { role: 'teacher', speaker: 'Tim', text: 'so tell me about' },
    };
    render(
      <CaptionPanel
        captions={[]}
        acsStatus="off"
        transcriptSegments={[]}
        partialTranscripts={partials}
      />
    );
    expect(screen.getByText('Tim')).toBeInTheDocument();
    expect(screen.queryByText('Interviewer')).not.toBeInTheDocument();
    const partialRow = screen.getByTestId('partial-teacher');
    expect(partialRow.textContent).toContain('so tell me about');
  });

  it('falls back to "Interviewer" on a teacher partial with a placeholder speaker', () => {
    const partials: Record<string, PartialTranscript> = {
      teacher: { role: 'teacher', speaker: 'teacher', text: 'so tell me about' },
    };
    render(
      <CaptionPanel
        captions={[]}
        acsStatus="off"
        transcriptSegments={[]}
        partialTranscripts={partials}
      />
    );
    expect(screen.getByText('Interviewer')).toBeInTheDocument();
  });

  it('renders a partial-only panel (no finals yet) instead of returning null', () => {
    const partials: Record<string, PartialTranscript> = {
      students: { role: 'students', speaker: 'S1', text: 'starting to speak' },
    };
    render(
      <CaptionPanel
        captions={[]}
        acsStatus="off"
        transcriptSegments={[]}
        partialTranscripts={partials}
      />
    );
    expect(screen.getByTestId('partial-students')).toBeInTheDocument();
    expect(screen.getByText('Captions')).toBeInTheDocument();
  });

  it('ignores partials while ACS captions are the active source', () => {
    const partials: Record<string, PartialTranscript> = {
      students: { role: 'students', speaker: 'S1', text: 'should not show' },
    };
    render(
      <CaptionPanel
        captions={[{ id: 'c1', speaker: 'Alice', text: 'ACS caption', timestamp: 0, language: 'en' }]}
        acsStatus="receiving"
        transcriptSegments={[]}
        partialTranscripts={partials}
      />
    );
    expect(screen.getByText('ACS caption')).toBeInTheDocument();
    expect(screen.queryByTestId('partial-students')).not.toBeInTheDocument();
  });
});

/**
 * R-D: the live partial line types in character-by-character. With motion enabled the
 * body starts short and grows toward the full cumulative partial text; at every step the
 * visible text is a prefix of the target, and the "still typing" marker (…) is present.
 */
describe('CaptionPanel — typewriter reveal for live partials (R-D)', () => {
  // Controllable rAF so we can pump animation frames deterministically.
  let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let rafId = 0;

  beforeEach(() => {
    stubReducedMotion(false);
    rafCallbacks = [];
    rafId = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      rafId += 1;
      rafCallbacks.push({ id: rafId, cb });
      return rafId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
      rafCallbacks = rafCallbacks.filter((entry) => entry.id !== id);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function flushFrame(times = 1) {
    for (let i = 0; i < times; i += 1) {
      const pending = rafCallbacks;
      rafCallbacks = [];
      act(() => {
        for (const entry of pending) entry.cb(performance.now());
      });
    }
  }

  it('reveals the partial body progressively as a prefix, keeping the … marker', () => {
    const partials: Record<string, PartialTranscript> = {
      students: { role: 'students', speaker: 'S1', text: 'once upon a time' },
    };
    render(
      <CaptionPanel
        captions={[]}
        acsStatus="off"
        transcriptSegments={[]}
        partialTranscripts={partials}
      />
    );
    const partialRow = screen.getByTestId('partial-students');
    // Before any frame the typing has not caught up: the full cumulative text is NOT yet
    // shown, but the "still typing" marker is already present.
    expect(partialRow.textContent).not.toContain('once upon a time');
    expect(partialRow.textContent).toContain('…');

    // Pump enough frames → the full cumulative text is revealed at the tail.
    flushFrame(20);
    expect(partialRow.textContent).toContain('once upon a time');
    expect(partialRow.textContent).toContain('…');
  });
});

/**
 * R-I: each settled caption segment (one pause / one utterance) is shown on its
 * own, prefixed with its session-relative start time (mm:ss). Consecutive
 * same-speaker segments must NOT be merged — that would erase the pause
 * boundaries and each utterance's individual start time.
 */
describe('CaptionPanel — per-utterance timestamps + no merge across pauses (R-I)', () => {
  it('shows each settled segment start time as mm:ss', () => {
    const segments: TranscriptSegment[] = [
      seg({ id: 's1', role: 'students', speaker: 'S1', text: 'first line', startMs: 65000 }),
    ];
    render(
      <CaptionPanel captions={[]} acsStatus="off" transcriptSegments={segments} />
    );
    expect(screen.getByText('01:05')).toBeInTheDocument();
    expect(screen.getByText('first line')).toBeInTheDocument();
  });

  it('does NOT merge two consecutive same-speaker segments — each keeps its own timestamp', () => {
    const segments: TranscriptSegment[] = [
      seg({ id: 's1', role: 'students', speaker: 'S1', text: 'first utterance', startMs: 5000 }),
      seg({ id: 's2', role: 'students', speaker: 'S1', text: 'second utterance', startMs: 12000 }),
    ];
    render(
      <CaptionPanel captions={[]} acsStatus="off" transcriptSegments={segments} />
    );
    // Both utterances render as distinct lines.
    expect(screen.getByText('first utterance')).toBeInTheDocument();
    expect(screen.getByText('second utterance')).toBeInTheDocument();
    // Each utterance shows its own start time (no merge into a single group).
    expect(screen.getByText('00:05')).toBeInTheDocument();
    expect(screen.getByText('00:12')).toBeInTheDocument();
    // The speaker label appears once per utterance (two independent groups), not
    // collapsed into a single merged group.
    expect(screen.getAllByText('S1')).toHaveLength(2);
  });

  it('falls back to no timestamp when startMs is 0 for an ACS caption source', () => {
    // ACS captions carry no session start offset; they must still render fine.
    render(
      <CaptionPanel
        captions={[{ id: 'c1', speaker: 'Alice', text: 'ACS caption', timestamp: 0, language: 'en' }]}
        acsStatus="receiving"
        transcriptSegments={[]}
      />
    );
    expect(screen.getByText('ACS caption')).toBeInTheDocument();
  });
});
