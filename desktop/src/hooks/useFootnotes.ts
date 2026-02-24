import { useMemo } from 'react';

export interface EvidenceItemForFootnote {
  evidence_id: string;
  speaker?: { display_name?: string };
  time_range_ms?: [number, number];
  quote?: string;
  source_tier?: 1 | 2 | 3;
}

export function useFootnotes(
  evidenceRefs: string[],
  evidenceMap: Map<string, EvidenceItemForFootnote>
) {
  return useMemo(() => {
    // Deduplicate and maintain order
    const uniqueRefs = [...new Set(evidenceRefs)];
    const indexMap = new Map<string, number>();

    const footnoteEntries = uniqueRefs
      .map((refId, i) => {
        const evidence = evidenceMap.get(refId);
        if (!evidence) return null;
        const idx = i + 1;
        indexMap.set(refId, idx);

        const startMs = evidence.time_range_ms?.[0] ?? 0;
        const minutes = Math.floor(startMs / 60000);
        const seconds = Math.floor((startMs % 60000) / 1000);
        const timestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

        const quote = evidence.quote
          ? evidence.quote.length > 80
            ? evidence.quote.slice(0, 77) + '...'
            : evidence.quote
          : '';

        return {
          index: idx,
          timestamp,
          speaker: evidence.speaker?.display_name ?? '?',
          quote,
          evidenceId: refId,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    function getFootnoteIndex(evidenceId: string): number {
      return indexMap.get(evidenceId) ?? 0;
    }

    return { footnoteEntries, getFootnoteIndex };
  }, [evidenceRefs, evidenceMap]);
}
