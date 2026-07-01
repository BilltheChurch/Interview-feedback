import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaptionPanel } from './CaptionPanel';
import type { TranscriptSegment, PartialTranscript } from '../stores/sessionStore';

/**
 * R1 defense-in-depth: a teacher-role transcript segment is, by architecture,
 * the interviewer (diarization is off on the teacher stream). The panel must
 * therefore always label it "Interviewer" and ignore whatever `speaker` value
 * the Worker put on it — even if the Worker mislabelled it as a student.
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

describe('CaptionPanel — teacher/student labelling (R1)', () => {
  it('labels a teacher segment "Interviewer" even when speaker is a student name', () => {
    const segments: TranscriptSegment[] = [
      seg({ id: 't1', role: 'teacher', speaker: '122', text: 'How was your week?' }),
    ];
    render(
      <CaptionPanel captions={[]} acsStatus="off" transcriptSegments={segments} />
    );
    expect(screen.getByText('Interviewer')).toBeInTheDocument();
    expect(screen.queryByText('122')).not.toBeInTheDocument();
    expect(screen.getByText('How was your week?')).toBeInTheDocument();
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

  it('labels a teacher partial "Interviewer" even when speaker is a student name', () => {
    const partials: Record<string, PartialTranscript> = {
      teacher: { role: 'teacher', speaker: '122', text: 'so tell me about' },
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
    expect(screen.queryByText('122')).not.toBeInTheDocument();
    const partialRow = screen.getByTestId('partial-teacher');
    expect(partialRow.textContent).toContain('so tell me about');
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
