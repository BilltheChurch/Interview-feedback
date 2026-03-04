import type { DimensionFeedback } from './types';

export function RadarChart({ dimensions }: { dimensions: DimensionFeedback[] }) {
  const activeDims = dimensions.filter((d) => !d.not_applicable);
  if (activeDims.length < 3) return null;

  const cx = 90;
  const cy = 90;
  const r = 70;
  const n = activeDims.length;
  const maxScore = 10;
  const angleStep = (2 * Math.PI) / n;

  const scores = activeDims.map((dim) => {
    if (typeof dim.score === 'number') {
      return Math.max(0, Math.min(dim.score, maxScore)) / maxScore;
    }
    const total = dim.claims.length;
    if (total === 0) return 0.5;
    const strengths = dim.claims.filter((c) => c.category === 'strength').length;
    return strengths / total;
  });

  const rawScores = activeDims.map((dim) => {
    if (typeof dim.score === 'number') {
      return Math.max(0, Math.min(dim.score, maxScore));
    }
    const total = dim.claims.length;
    if (total === 0) return 5;
    const strengths = dim.claims.filter((c) => c.category === 'strength').length;
    return Math.round((strengths / total) * maxScore * 10) / 10;
  });

  const polygonPoints = scores
    .map((score, i) => {
      const angle = -Math.PI / 2 + i * angleStep;
      const x = cx + r * score * Math.cos(angle);
      const y = cy + r * score * Math.sin(angle);
      return `${x},${y}`;
    })
    .join(' ');

  const rings = [0.25, 0.5, 0.75, 1.0];
  const ringLabels = ['2.5', '5.0', '7.5', '10'];

  return (
    <div className="flex items-center justify-center py-3">
      <svg width="180" height="180" viewBox="0 0 180 180" className="overflow-visible">
        {rings.map((ring, ri) => (
          <g key={ring}>
            <polygon
              points={Array.from({ length: n })
                .map((_, i) => {
                  const angle = -Math.PI / 2 + i * angleStep;
                  const x = cx + r * ring * Math.cos(angle);
                  const y = cy + r * ring * Math.sin(angle);
                  return `${x},${y}`;
                })
                .join(' ')}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth="0.5"
              opacity={0.6}
            />
            <text
              x={cx}
              y={cy - r * ring - 2}
              textAnchor="middle"
              dominantBaseline="auto"
              fill="var(--color-ink-secondary)"
              fontSize="7"
              opacity={0.5}
            >
              {ringLabels[ri]}
            </text>
          </g>
        ))}

        {activeDims.map((_, i) => {
          const angle = -Math.PI / 2 + i * angleStep;
          const x = cx + r * Math.cos(angle);
          const y = cy + r * Math.sin(angle);
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              stroke="var(--color-border)"
              strokeWidth="0.5"
              opacity={0.6}
            />
          );
        })}

        <polygon
          points={polygonPoints}
          fill="var(--color-accent)"
          fillOpacity={0.15}
          stroke="var(--color-accent)"
          strokeWidth="1.5"
        />

        {scores.map((score, i) => {
          const angle = -Math.PI / 2 + i * angleStep;
          const x = cx + r * score * Math.cos(angle);
          const y = cy + r * score * Math.sin(angle);
          return (
            <circle key={i} cx={x} cy={y} r="3" fill="var(--color-accent)" />
          );
        })}

        {activeDims.map((dim, i) => {
          const angle = -Math.PI / 2 + i * angleStep;
          const labelR = r + 16;
          const x = cx + labelR * Math.cos(angle);
          const y = cy + labelR * Math.sin(angle);
          const displayLabel = dim.label_zh || (dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1));
          const scoreVal = rawScores[i];
          const isLowScore = scoreVal < 4;
          const truncated = displayLabel.length > 6 ? displayLabel.slice(0, 5) + '…' : displayLabel;
          const labelText = typeof dim.score === 'number'
            ? `${truncated} ${scoreVal % 1 === 0 ? scoreVal.toFixed(0) : scoreVal.toFixed(1)}`
            : truncated;
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fill={isLowScore ? 'var(--color-risk, #dc2626)' : 'var(--color-ink-secondary)'}
              fontSize="9"
              fontWeight={isLowScore ? '600' : '500'}
            >
              {labelText}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
