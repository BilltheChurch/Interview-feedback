import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaptionPanel } from './CaptionPanel';
import type { TranscriptSegment } from '../stores/sessionStore';

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
