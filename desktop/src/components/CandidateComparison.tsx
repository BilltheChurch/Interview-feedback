type Props = {
  persons: Array<{
    person_name: string;
    dimensions: Array<{
      dimension: string;
      label_zh?: string;
      score?: number;
    }>;
  }>;
};

function scoreColor(score: number | undefined): string {
  if (score === undefined) return 'text-ink-tertiary bg-surface';
  if (score >= 8) return 'text-emerald-700 bg-emerald-50';
  if (score >= 4) return 'text-ink bg-surface';
  return 'text-red-700 bg-red-50';
}

export function CandidateComparison({ persons }: Props) {
  if (persons.length < 2) return null;

  const dimensions = persons[0].dimensions.map(d => ({
    key: d.dimension,
    label: d.label_zh || d.dimension,
  }));

  return (
    <div className="my-4">
      <h3 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
        Candidate Comparison
      </h3>
      <div className="overflow-x-auto border border-border rounded-[--radius-card]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface">
              <th className="text-left px-3 py-2 text-xs font-medium text-ink-secondary border-b border-border">
                Dimension
              </th>
              {persons.map(p => (
                <th key={p.person_name} className="text-center px-3 py-2 text-xs font-medium text-ink-secondary border-b border-border">
                  {p.person_name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dimensions.map(dim => (
              <tr key={dim.key} className="border-b border-border/50">
                <td className="px-3 py-2 text-xs text-ink-secondary">{dim.label}</td>
                {persons.map(p => {
                  const d = p.dimensions.find(pd => pd.dimension === dim.key);
                  const score = d?.score;
                  return (
                    <td key={p.person_name} className="text-center px-3 py-1.5">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${scoreColor(score)}`}>
                        {score !== undefined ? score.toFixed(1) : '\u2014'}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
