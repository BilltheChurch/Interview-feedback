import { type TextareaHTMLAttributes, forwardRef } from 'react';

type TextAreaProps = {
  label?: string;
  error?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, error, rows = 4, className = '', ...props }, ref) => {
    return (
      <div className={className}>
        {label && (
          <label className="block text-xs font-medium text-ink-secondary mb-1">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          rows={rows}
          className={`
            w-full border rounded-[--radius-button] px-3 py-2 text-sm bg-surface text-ink
            resize-y
            focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
            disabled:opacity-50 disabled:cursor-not-allowed
            ${error ? 'border-error' : 'border-border'}
          `}
          {...props}
        />
        {error && (
          <p className="mt-1 text-xs text-error">{error}</p>
        )}
      </div>
    );
  }
);

TextArea.displayName = 'TextArea';
