import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaptionPanel } from './CaptionPanel';
import type { TranscriptSegment, PartialTranscript } from '../stores/sessionStore';

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
