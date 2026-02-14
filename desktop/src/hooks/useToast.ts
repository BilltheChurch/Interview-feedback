import { useCallback, useRef, useState } from 'react';
import type { ToastItem, ToastType } from '../components/Toast';

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 5_000;

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = `toast-${++counterRef.current}`;
      setToasts((prev) => {
        const next = [...prev, { id, message, type }];
        // keep at most MAX_TOASTS visible
        return next.slice(-MAX_TOASTS);
      });

      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  return { toasts, toast, dismiss } as const;
}
