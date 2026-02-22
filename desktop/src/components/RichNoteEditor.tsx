import { forwardRef, useImperativeHandle } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import { MemoHighlight } from '../lib/memoHighlight';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Quote,
  Minus,
  Undo2,
  Redo2,
} from 'lucide-react';

/* ─── Types ─────────────────────────────────── */

export type RichNoteEditorProps = {
  content: string; // HTML string
  onContentChange: (html: string) => void;
  onPlainTextChange?: (text: string) => void; // for memo capture (plain text version)
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
};

export type MemoMarkType = 'highlight' | 'issue' | 'question' | 'evidence';

export type RichNoteEditorRef = {
  getText: () => string;
  getHTML: () => string;
  clearContent: () => void;
  insertTimestamp: (stamp: string) => void;
  /** Returns selected text, or empty string if no selection */
  getSelectedText: () => string;
  /** Deletes the current selection and returns true, or false if nothing selected */
  deleteSelection: () => boolean;
  /** Applies a colored memo highlight mark to the selection, or to all content if no selection */
  applyMemoMark: (type: MemoMarkType, memoId: string) => void;
};

/* ─── ToolbarButton ─────────────────────────── */

function ToolbarButton({
  onClick,
  isActive = false,
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`
        w-7 h-7 flex items-center justify-center rounded-md transition-colors duration-150
        ${isActive ? 'bg-accent-soft text-accent' : 'text-ink-secondary hover:bg-surface-hover'}
        ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}
      `}
    >
      {children}
    </button>
  );
}

/* ─── ToolbarDivider ────────────────────────── */

function ToolbarDivider() {
  return <div className="w-px h-5 bg-border mx-1" />;
}

/* ─── MenuBar ───────────────────────────────── */

function MenuBar({ editor }: { editor: Editor }) {
  const iconSize = 'w-4 h-4';

  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-border bg-surface flex-wrap">
      {/* Text style */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive('bold')}
        title="Bold"
      >
        <Bold className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive('italic')}
        title="Italic"
      >
        <Italic className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        isActive={editor.isActive('underline')}
        title="Underline"
      >
        <UnderlineIcon className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        isActive={editor.isActive('strike')}
        title="Strikethrough"
      >
        <Strikethrough className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Headings */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        isActive={editor.isActive('heading', { level: 1 })}
        title="Heading 1"
      >
        <Heading1 className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        isActive={editor.isActive('heading', { level: 2 })}
        title="Heading 2"
      >
        <Heading2 className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        isActive={editor.isActive('heading', { level: 3 })}
        title="Heading 3"
      >
        <Heading3 className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Lists */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        isActive={editor.isActive('bulletList')}
        title="Bullet List"
      >
        <List className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        isActive={editor.isActive('orderedList')}
        title="Ordered List"
      >
        <ListOrdered className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Alignment */}
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        isActive={editor.isActive({ textAlign: 'left' })}
        title="Align Left"
      >
        <AlignLeft className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        isActive={editor.isActive({ textAlign: 'center' })}
        title="Align Center"
      >
        <AlignCenter className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        isActive={editor.isActive({ textAlign: 'right' })}
        title="Align Right"
      >
        <AlignRight className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Block */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        isActive={editor.isActive('blockquote')}
        title="Blockquote"
      >
        <Quote className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Horizontal Rule"
      >
        <Minus className={iconSize} />
      </ToolbarButton>

      <ToolbarDivider />

      {/* Actions */}
      <ToolbarButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        title="Undo"
      >
        <Undo2 className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        title="Redo"
      >
        <Redo2 className={iconSize} />
      </ToolbarButton>
    </div>
  );
}

/* ─── RichNoteEditor ────────────────────────── */

export const RichNoteEditor = forwardRef<RichNoteEditorRef, RichNoteEditorProps>(
  ({ content, onContentChange, onPlainTextChange, placeholder, className, autoFocus }, ref) => {
    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
        }),
        Underline,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Placeholder.configure({
          placeholder: placeholder || 'Type your notes here...',
        }),
        MemoHighlight,
      ],
      content,
      onUpdate: ({ editor: e }) => {
        onContentChange(e.getHTML());
        onPlainTextChange?.(e.getText());
      },
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class:
            'prose prose-sm max-w-none focus:outline-none min-h-[200px] px-4 py-3',
        },
      },
    });

    useImperativeHandle(ref, () => ({
      getText: () => editor?.getText() ?? '',
      getHTML: () => editor?.getHTML() ?? '',
      clearContent: () => {
        editor?.commands.clearContent();
      },
      insertTimestamp: (stamp: string) => {
        editor?.chain().focus().insertContent(stamp).run();
      },
      getSelectedText: () => {
        if (!editor) return '';
        const { from, to } = editor.state.selection;
        if (from === to) return '';
        return editor.state.doc.textBetween(from, to, ' ');
      },
      deleteSelection: () => {
        if (!editor) return false;
        const { from, to } = editor.state.selection;
        if (from === to) return false;
        editor.chain().focus().deleteRange({ from, to }).run();
        return true;
      },
      applyMemoMark: (type: MemoMarkType, memoId: string) => {
        if (!editor) return;
        const { from, to } = editor.state.selection;
        const docEnd = editor.state.doc.content.size;
        if (from === to) {
          // No selection — mark all content, then collapse cursor to end
          editor.chain()
            .focus()
            .selectAll()
            .setMark('memoHighlight', { memoType: type, memoId })
            .setTextSelection(docEnd)
            .unsetMark('memoHighlight')
            .run();
        } else {
          // Mark only the selected range, then collapse cursor past the mark
          editor.chain()
            .focus()
            .setMark('memoHighlight', { memoType: type, memoId })
            .setTextSelection(to)
            .unsetMark('memoHighlight')
            .run();
        }
      },
    }));

    return (
      <div className={`flex flex-col ${className || ''}`}>
        {editor && <MenuBar editor={editor} />}
        <div className="flex-1 overflow-y-auto bg-surface">
          <EditorContent editor={editor} />
        </div>
        <style>{`
          .tiptap p.is-editor-empty:first-child::before {
            content: attr(data-placeholder);
            float: left;
            color: var(--color-ink-tertiary);
            pointer-events: none;
            height: 0;
          }

          .tiptap {
            font-family: 'Inter', sans-serif;
            font-size: 14px;
            line-height: 1.6;
            color: var(--color-ink);
          }

          .tiptap:focus {
            outline: none;
          }

          .tiptap h1 {
            font-size: 1.5em;
            font-weight: 600;
            margin: 0.5em 0 0.25em;
          }

          .tiptap h2 {
            font-size: 1.25em;
            font-weight: 600;
            margin: 0.5em 0 0.25em;
          }

          .tiptap h3 {
            font-size: 1.1em;
            font-weight: 600;
            margin: 0.5em 0 0.25em;
          }

          .tiptap ul,
          .tiptap ol {
            padding-left: 1.5em;
          }

          .tiptap ul {
            list-style-type: disc;
          }

          .tiptap ol {
            list-style-type: decimal;
          }

          .tiptap blockquote {
            border-left: 3px solid var(--color-border);
            padding-left: 1em;
            color: var(--color-ink-secondary);
          }

          .tiptap hr {
            border-color: var(--color-border);
            margin: 1em 0;
          }

          .tiptap p {
            margin: 0.25em 0;
          }
        `}</style>
      </div>
    );
  },
);

RichNoteEditor.displayName = 'RichNoteEditor';
