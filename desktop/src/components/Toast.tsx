import { useEffect, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export type ToastItem = {
  id: string;
  message: string;
  type: ToastType;
};

const typeStyles: Record<ToastType, string> = {
  success: 'border-success text-success',
  error: 'border-error text-error',
  warning: 'border-warning text-warning',
  info: 'border-accent text-accent',
};

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // trigger enter animation on next frame
    requestAnimationFrame(() => {
      ref.current?.classList.remove('translate-y-4', 'opacity-0');
    });
  }, []);

  return (
    <div
      ref={ref}
      role="alert"
      className={`
        translate-y-4 opacity-0
        transition-all duration-300 ease-out
        bg-surface border-l-4 shadow-card rounded-[--radius-card] px-4 py-3
        flex items-start gap-3 max-w-sm pointer-events-auto
        ${typeStyles[item.type]}
      `}
    >
      <p className="text-sm text-ink flex-1">{item.message}</p>
      <button
        onClick={() => onDismiss(item.id)}
        className="text-ink-tertiary hover:text-ink-secondary text-lg leading-none"
        aria-label="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
