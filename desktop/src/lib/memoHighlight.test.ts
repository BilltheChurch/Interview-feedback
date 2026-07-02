import { describe, it, expect } from 'vitest';
import { isMemoTextDuplicateOfNotes } from './memoHighlight';

/**
 * R5 — Session Notes memo-card de-dup.
 *
 * A highlight memo's text IS the highlighted span in the free-form note rendered
 * right above the card, so repeating it on the card is a verbatim duplicate
 * (round-5 user feedback: chip + timestamp is enough). The predicate must stay
 * conservative: any memo whose text is NOT visible above keeps its body.
 */

const NOTE_HTML =
  '<p><mark data-memo-type="highlight" data-memo-id="memo-1782960444888-ofk0n5" ' +
  'class="memo-mark memo-mark--highlight" data-label="Highlight">这次的caption还比较不错。</mark></p>';

describe('isMemoTextDuplicateOfNotes (R5)', () => {
  it('hides a highlight memo whose mark is still present in the note html', () => {
    const memo = { type: 'highlight', id: 'memo-1782960444888-ofk0n5' };
    expect(isMemoTextDuplicateOfNotes(memo, NOTE_HTML)).toBe(true);
  });

  it('keeps an orphaned highlight (mark edited out of the note)', () => {
    const memo = { type: 'highlight', id: 'memo-gone' };
    expect(isMemoTextDuplicateOfNotes(memo, NOTE_HTML)).toBe(false);
  });

  it('never hides non-highlight memo types, even when their mark is in the note', () => {
    const html = NOTE_HTML.replace('highlight', 'issue');
    expect(isMemoTextDuplicateOfNotes({ type: 'issue', id: 'memo-1782960444888-ofk0n5' }, NOTE_HTML)).toBe(false);
    expect(isMemoTextDuplicateOfNotes({ type: 'question', id: 'memo-1782960444888-ofk0n5' }, html)).toBe(false);
  });

  it('is safe on empty / missing note html', () => {
    const memo = { type: 'highlight', id: 'memo-1' };
    expect(isMemoTextDuplicateOfNotes(memo, '')).toBe(false);
    expect(isMemoTextDuplicateOfNotes(memo, null)).toBe(false);
    expect(isMemoTextDuplicateOfNotes(memo, undefined)).toBe(false);
  });

  it('matches on the exact data-memo-id attribute, not a loose substring', () => {
    // id "memo-1" must not match a note that only contains "memo-10".
    const html = '<mark data-memo-type="highlight" data-memo-id="memo-10">x</mark>';
    expect(isMemoTextDuplicateOfNotes({ type: 'highlight', id: 'memo-1' }, html)).toBe(false);
  });
});
