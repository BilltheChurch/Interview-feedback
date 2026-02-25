import { useState, useRef, useEffect, useCallback } from 'react';

type Props = {
  value: string;
  onSave: (newValue: string) => void;
  as?: 'p' | 'span' | 'h2' | 'h3';
  className?: string;
  textareaClassName?: string;
  placeholder?: string;
};

export function InlineEditable({
  value,
  onSave,
  as: Tag = 'p',
  className = '',
  textareaClassName = '',
  placeholder = 'Double-click to edit...',
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [editing]);

  const handleSave = useCallback(() => {
    setEditing(false);
    if (draft.trim() !== value.trim()) {
      onSave(draft.trim());
    }
  }, [draft, value, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setDraft(value);
      setEditing(false);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      handleSave();
    }
  }, [value, handleSave]);

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        role="textbox"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = e.target.scrollHeight + 'px';
        }}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        className={`w-full resize-none border border-accent/40 rounded px-2 py-1 text-sm text-ink bg-white focus:outline-none focus:ring-1 focus:ring-accent ${textareaClassName}`}
      />
    );
  }

  return (
    <Tag
      className={`cursor-text hover:bg-accent/5 rounded px-1 -mx-1 transition-colors ${className}`}
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
    >
      {value || <span className="text-ink-tertiary italic">{placeholder}</span>}
    </Tag>
  );
}
