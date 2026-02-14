import { type InputHTMLAttributes, forwardRef } from 'react';

type TextFieldProps = {
  label?: string;
  error?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, error, className = '', ...props }, ref) => {
    return (
      <div className={className}>
        {label && (
          <label className="block text-xs font-medium text-ink-secondary mb-1">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={`
            w-full border rounded-[--radius-button] px-3 py-2 text-sm bg-surface text-ink
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

TextField.displayName = 'TextField';
