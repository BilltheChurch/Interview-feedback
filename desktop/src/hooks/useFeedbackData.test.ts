import { describe, it, expect, vi } from 'vitest';
import { normalizeApiReport } from './useFeedbackData';
import type { RawApiReport } from './useFeedbackData';

describe('normalizeApiReport', () => {
  it('returns a valid FeedbackReport with minimal raw input', () => {
    const raw: RawApiReport = {};
    const result = normalizeApiReport(raw);
    expect(result.session_id).toBe('');
    expect(result.session_name).toBe('');
    expect(result.status).toBe('final');
    expect(result.participants).toEqual([]);
    expect(result.persons).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.transcript).toEqual([]);
  });

  it('extracts participants from raw.stats', () => {
    const raw: RawApiReport = {
      stats: [
        { speaker_name: 'Alice' },
        { speaker_name: 'Bob' },
      ],
    };
    const result = normalizeApiReport(raw);
    expect(result.participants).toEqual(['Alice', 'Bob']);
  });

  it('extracts participants from raw.participants (string array)', () => {
    const raw: RawApiReport = {
      participants: ['Charlie', 'Dave'],
    };
    const result = normalizeApiReport(raw);
    expect(result.participants).toEqual(['Charlie', 'Dave']);
  });

  it('uses sessionMeta participants as fallback', () => {
    const raw: RawApiReport = {};
    const result = normalizeApiReport(raw, { participants: ['Eve', 'Frank'] });
    expect(result.participants).toEqual(['Eve', 'Frank']);
  });

  it('normalizes team_summary from overall.team_summary string', () => {
    const raw: RawApiReport = {
      overall: { team_summary: 'Great session overall.' },
    };
    const result = normalizeApiReport(raw);
    expect(result.overall.team_summary).toBe('Great session overall.');
  });

  it('normalizes team_summary from summary_sections bullets', () => {
    const raw: RawApiReport = {
      overall: {
        summary_sections: [
          { bullets: ['Point 1', 'Point 2'] },
          { bullets: ['Point 3'] },
        ],
      },
    };
    const result = normalizeApiReport(raw);
    expect(result.overall.team_summary).toContain('Point 1');
    expect(result.overall.team_summary).toContain('Point 3');
  });

  it('normalizes persons with claims', () => {
    const raw: RawApiReport = {
      persons: [
        {
          display_name: 'Alice',
          dimensions: [
            {
              dimension: 'leadership',
              score: 8,
              claims: [
                { id: 'c1', text: 'Excellent leader', category: 'strength', confidence: 0.9, evidence_refs: [] },
              ],
            },
          ],
          summary: { strengths: 'Very strong', risks: 'None', actions: 'Keep it up' },
        },
      ],
    };
    const result = normalizeApiReport(raw);
    expect(result.persons).toHaveLength(1);
    expect(result.persons[0].person_name).toBe('Alice');
    expect(result.persons[0].dimensions[0].score).toBe(8);
    expect(result.persons[0].dimensions[0].claims[0].text).toBe('Excellent leader');
  });

  it('normalizes legacy strengths/risks/actions arrays in dimension', () => {
    const raw: RawApiReport = {
      persons: [
        {
          display_name: 'Bob',
          dimensions: [
            {
              dimension: 'collaboration',
              strengths: [{ claim_id: 'c_s1', text: 'Great teamwork', confidence: 0.8, evidence_refs: [] }],
              risks: [{ claim_id: 'c_r1', text: 'Needs to listen more', confidence: 0.6, evidence_refs: [] }],
              actions: [],
            },
          ],
          summary: {},
        },
      ],
    };
    const result = normalizeApiReport(raw);
    const dim = result.persons[0].dimensions[0];
    expect(dim.claims.some((c) => c.category === 'strength')).toBe(true);
    expect(dim.claims.some((c) => c.category === 'risk')).toBe(true);
  });

  it('normalizes evidence items', () => {
    const raw: RawApiReport = {
      evidence: [
        {
          evidence_id: 'ev_1',
          time_range_ms: [1000, 5000],
          speaker: 'Alice',
          quote: 'I think we should go left.',
          confidence: 0.85,
        },
      ],
    };
    const result = normalizeApiReport(raw);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].id).toBe('ev_1');
    expect(result.evidence[0].timestamp_ms).toBe(1000);
    expect(result.evidence[0].end_ms).toBe(5000);
    expect(result.evidence[0].text).toBe('I think we should go left.');
  });

  it('normalizes transcript utterances', () => {
    const raw: RawApiReport = {
      transcript: [
        { utterance_id: 'u1', speaker_name: 'Alice', text: 'Hello there.', start_ms: 0, end_ms: 2000 },
      ],
    };
    const result = normalizeApiReport(raw);
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0].utterance_id).toBe('u1');
    expect(result.transcript[0].text).toBe('Hello there.');
  });

  it('builds utteranceEvidenceMap from evidence utterance_ids', () => {
    const raw: RawApiReport = {
      evidence: [
        { evidence_id: 'ev_1', utterance_ids: ['u1', 'u2'], speaker: 'Alice', quote: 'x', confidence: 0.5, timestamp_ms: 0 },
      ],
    };
    const result = normalizeApiReport(raw);
    expect(result.utteranceEvidenceMap['u1']).toContain('ev_1');
    expect(result.utteranceEvidenceMap['u2']).toContain('ev_1');
  });

  it('uses sessionMeta to override session_name and date', () => {
    const raw: RawApiReport = {};
    const result = normalizeApiReport(raw, { name: 'My Interview', date: '2026-03-01' });
    expect(result.session_name).toBe('My Interview');
    expect(result.date).toBe('2026-03-01');
  });

  it('normalizes team_dynamics from object format (highlights/risks)', () => {
    const raw: RawApiReport = {
      overall: {
        team_dynamics: {
          highlights: ['Good energy'],
          risks: ['Dominant speaker'],
        },
      },
    };
    const result = normalizeApiReport(raw);
    expect(result.overall.team_dynamics).toContainEqual({ type: 'highlight', text: 'Good energy' });
    expect(result.overall.team_dynamics).toContainEqual({ type: 'risk', text: 'Dominant speaker' });
  });

  it('computes communication metrics for persons with transcript data', () => {
    const raw: RawApiReport = {
      persons: [
        {
          display_name: 'Alice',
          dimensions: [],
          summary: {},
        },
      ],
      transcript: [
        { utterance_id: 'u1', speaker_name: 'Alice', text: 'Hi um hello.', start_ms: 0, end_ms: 3000 },
        { utterance_id: 'u2', speaker_name: 'Bob', text: 'Thanks.', start_ms: 4000, end_ms: 6000 },
        { utterance_id: 'u3', speaker_name: 'Alice', text: 'Okay.', start_ms: 7000, end_ms: 9000 },
      ],
    };
    const result = normalizeApiReport(raw);
    const metrics = result.persons[0].communicationMetrics;
    expect(metrics).toBeDefined();
    expect(metrics!.turnCount).toBe(2);
    expect(metrics!.speakingTimeSec).toBe(5); // 3s + 2s
    expect(metrics!.fillerWordCount).toBeGreaterThan(0); // 'um' counts
  });

  it('strips inline evidence refs like [e_001] from claim text', () => {
    const raw: RawApiReport = {
      persons: [
        {
          display_name: 'Alice',
          dimensions: [
            {
              dimension: 'logic',
              claims: [
                { id: 'c1', text: 'Clear reasoning [e_001].', category: 'strength', confidence: 0.8, evidence_refs: [] },
              ],
            },
          ],
          summary: {},
        },
      ],
    };
    const result = normalizeApiReport(raw);
    const claim = result.persons[0].dimensions[0].claims[0];
    expect(claim.text).not.toContain('[e_001]');
    expect(claim.evidence_refs).toContain('e_001');
  });

  it('formats duration correctly', () => {
    const raw: RawApiReport = { duration_ms: 3900000 }; // 65 minutes
    const result = normalizeApiReport(raw);
    expect(result.durationLabel).toBe('1h 5m');
  });
});
