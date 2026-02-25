import { MessageSquare, Clock, AlertTriangle, Zap } from 'lucide-react';

type Props = {
  metrics: {
    speakingTimeSec: number;
    totalSessionSec: number;
    speakingRatio: number;
    avgResponseSec: number;
    fillerWordCount: number;
    fillerWordsPerMin: number;
    avgLatencySec: number;
    longestPauseSec: number;
    turnCount: number;
  };
};

function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function CommunicationMetrics({ metrics }: Props) {
  const items = [
    {
      icon: MessageSquare,
      label: 'Speaking Time',
      value: formatSeconds(metrics.speakingTimeSec),
      detail: `${Math.round(metrics.speakingRatio * 100)}% of session`,
      bar: metrics.speakingRatio,
    },
    {
      icon: Clock,
      label: 'Avg Response',
      value: formatSeconds(metrics.avgResponseSec),
      detail: `${metrics.turnCount} turns total`,
    },
    {
      icon: AlertTriangle,
      label: 'Filler Words',
      value: `${metrics.fillerWordCount}`,
      detail: `${metrics.fillerWordsPerMin}/min`,
    },
    {
      icon: Zap,
      label: 'Response Latency',
      value: `${metrics.avgLatencySec}s avg`,
      detail: `${metrics.longestPauseSec}s longest`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 my-3">
      {items.map((item) => (
        <div key={item.label} className="flex items-start gap-2.5 p-2.5 rounded-[--radius-button] bg-surface border border-border/50">
          <item.icon className="w-4 h-4 text-ink-tertiary shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-ink-tertiary">{item.label}</p>
            <p className="text-sm font-semibold text-ink">{item.value}</p>
            <p className="text-xs text-ink-tertiary">{item.detail}</p>
            {item.bar !== undefined && (
              <div className="mt-1 h-1.5 bg-border/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all"
                  style={{ width: `${Math.round(item.bar * 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
