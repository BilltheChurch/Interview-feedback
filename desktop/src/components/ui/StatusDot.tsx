const statusStyles = {
  recording: 'bg-emerald-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
  idle: 'bg-gray-400',
  error: 'bg-red-500',
  setup: 'bg-blue-500',
  feedback_draft: 'bg-amber-500',
  feedback_final: 'bg-emerald-500',
} as const;

export type StatusDotStatus = keyof typeof statusStyles;

const statusLabels: Record<StatusDotStatus, string> = {
  recording: 'Recording',
  reconnecting: 'Reconnecting',
  idle: 'Idle',
  error: 'Error',
  setup: 'Setting up',
  feedback_draft: 'Draft feedback',
  feedback_final: 'Finalized',
};

type StatusDotProps = {
  status: StatusDotStatus;
};

export function StatusDot({ status }: StatusDotProps) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${statusStyles[status]}`}
      aria-label={statusLabels[status]}
    />
  );
}
