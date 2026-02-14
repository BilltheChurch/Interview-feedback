import type { ComponentType, ReactNode } from 'react';
import type { LucideProps } from 'lucide-react';

type EmptyStateProps = {
  icon: ComponentType<LucideProps>;
  title: string;
  description?: string;
  action?: ReactNode;
};

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <Icon className="w-12 h-12 text-ink-tertiary mb-4" />
      <h3 className="text-base font-medium text-ink">{title}</h3>
      {description && (
        <p className="text-sm text-ink-secondary mt-1 max-w-xs text-center">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
