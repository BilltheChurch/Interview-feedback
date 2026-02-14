import { type ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

const sizeStyles = {
  sm: 'max-w-[400px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[760px]',
} as const;

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: keyof typeof sizeStyles;
};

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px] animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`
          w-full ${sizeStyles[size]} mx-4
          bg-surface rounded-[--radius-card] shadow-modal
          relative p-6
        `}
      >
        {title && (
          <h2 className="text-lg font-semibold text-ink pr-8 mb-4">{title}</h2>
        )}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-ink-tertiary hover:text-ink cursor-pointer transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        {children}
      </div>
    </div>
  );
}
