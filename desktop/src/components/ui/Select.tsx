import { type SelectHTMLAttributes, forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';

type SelectOption = {
  value: string;
  label: string;
};

type SelectProps = {
  label?: string;
  options: SelectOption[];
  placeholder?: string;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, options, placeholder, className = '', ...props }, ref) => {
    return (
      <div className={className}>
        {label && (
          <label className="block text-xs font-medium text-ink-secondary mb-1">
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            className={`
              w-full border border-border rounded-[--radius-button] px-3 py-2 text-sm
              bg-surface text-ink appearance-none pr-8
              focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
            {...props}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-tertiary pointer-events-none" />
        </div>
      </div>
    );
  }
);

Select.displayName = 'Select';
