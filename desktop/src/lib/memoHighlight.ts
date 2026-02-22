import { Mark, mergeAttributes } from '@tiptap/core';

export type MemoHighlightAttrs = {
  memoType: 'highlight' | 'issue' | 'question' | 'evidence';
  memoId: string;
};

const MEMO_LABELS: Record<string, string> = {
  highlight: 'Highlight',
  issue: 'Issue',
  question: 'Question',
  evidence: 'Evidence',
};

/**
 * Custom TipTap Mark for memo highlighting.
 *
 * Renders selected text wrapped in a <mark> element with data-memo-type
 * and data-memo-id attributes. CSS in globals.css provides per-type colors:
 *   highlight → emerald, issue → amber, question → blue, evidence → purple
 *
 * `inclusive: false` ensures typing at the boundary does NOT extend the mark.
 * `data-label` attr drives a CSS ::after tooltip on hover (faster than native title).
 */
export const MemoHighlight = Mark.create<{ HTMLAttributes: Record<string, unknown> }>({
  name: 'memoHighlight',

  // Typing at the edge of a highlighted range should NOT continue the highlight
  inclusive: false,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      memoType: {
        default: 'highlight',
        parseHTML: (element) => element.getAttribute('data-memo-type') || 'highlight',
        renderHTML: (attributes) => ({ 'data-memo-type': attributes.memoType }),
      },
      memoId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-memo-id') || '',
        renderHTML: (attributes) => ({ 'data-memo-id': attributes.memoId }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'mark[data-memo-type]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const memoType = HTMLAttributes['data-memo-type'] || 'highlight';
    const label = MEMO_LABELS[memoType as string] || 'Memo';

    return [
      'mark',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: `memo-mark memo-mark--${memoType}`,
        'data-label': label,
      }),
      0,
    ];
  },
});
