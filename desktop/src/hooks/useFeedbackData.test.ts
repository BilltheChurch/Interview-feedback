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

  it('R2: plumbs overall.notice through for degraded overview-only reports', () => {
    const raw: RawApiReport = {
      overall: { team_summary: 'Overview only.', notice: 'No student speech detected — overview only.' },
      per_person: [],
    };
    const result = normalizeApiReport(raw);
    expect(result.overall.notice).toBe('No student speech detected — overview only.');
    expect(result.persons).toEqual([]);
  });

  it('R2: leaves notice undefined for normal reports', () => {
    const raw: RawApiReport = {
      overall: { team_summary: 'Normal report.' },
    };
    const result = normalizeApiReport(raw);
    expect(result.overall.notice).toBeUndefined();
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

  it('prefers cleaned_transcript (punctuated) over raw transcript when present', () => {
    const raw: RawApiReport = {
      transcript: [
        { utterance_id: 'u1', speaker_name: 'Alice', text: '你好 我叫小明', start_ms: 0, end_ms: 2000 },
      ],
      cleaned_transcript: [
        { utterance_id: 'u1', speaker_name: 'Alice', text: '你好，我叫小明。', start_ms: 0, end_ms: 2000 },
      ],
    };
    const result = normalizeApiReport(raw);
    expect(result.transcript).toHaveLength(1);
    // Punctuated cleaned text must win over the raw punctuation-free text.
    expect(result.transcript[0].text).toBe('你好，我叫小明。');
  });

  it('falls back to raw transcript when cleaned_transcript is missing', () => {
    const raw: RawApiReport = {
      transcript: [
        { utterance_id: 'u1', speaker_name: 'Alice', text: 'no punctuation here', start_ms: 0, end_ms: 2000 },
      ],
    };
    const result = normalizeApiReport(raw);
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0].text).toBe('no punctuation here');
  });

  it('falls back to raw transcript when cleaned_transcript is present but empty', () => {
    const raw: RawApiReport = {
      transcript: [
        { utterance_id: 'u1', speaker_name: 'Alice', text: 'raw text', start_ms: 0, end_ms: 2000 },
      ],
      cleaned_transcript: [],
    };
    const result = normalizeApiReport(raw);
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0].text).toBe('raw text');
  });

  it('preserves per-utterance start_ms from cleaned_transcript', () => {
    const raw: RawApiReport = {
      transcript: [
        { utterance_id: 'u1', speaker_name: 'Alice', text: 'a b', start_ms: 0, end_ms: 2000 },
        { utterance_id: 'u2', speaker_name: 'Alice', text: 'c d', start_ms: 5000, end_ms: 7000 },
      ],
      cleaned_transcript: [
        { utterance_id: 'u1', speaker_name: 'Alice', text: 'A, b.', start_ms: 0, end_ms: 2000 },
        { utterance_id: 'u2', speaker_name: 'Alice', text: 'C, d.', start_ms: 5000, end_ms: 7000 },
      ],
    };
    const result = normalizeApiReport(raw);
    expect(result.transcript.map((u) => u.start_ms)).toEqual([0, 5000]);
  });

  it('computes communication metrics from RAW transcript, not cleaned_transcript', () => {
    // cleaned_transcript strips fillers and drops a pure-filler utterance. Metrics
    // MUST stay on the raw transcript so switching the display source leaves KPIs
    // unchanged: fillerWordCount and turnCount must reflect the raw data.
    const rawUtterances = [
      { utterance_id: 'u1', speaker_name: 'Alice', text: 'Hi um hello.', start_ms: 0, end_ms: 3000 },
      { utterance_id: 'u2', speaker_name: 'Bob', text: 'Thanks.', start_ms: 4000, end_ms: 6000 },
      { utterance_id: 'u3', speaker_name: 'Alice', text: 'um', start_ms: 7000, end_ms: 9000 }, // pure filler
    ];
    const rawOnly: RawApiReport = {
      persons: [{ display_name: 'Alice', dimensions: [], summary: {} }],
      transcript: rawUtterances,
    };
    const withCleaned: RawApiReport = {
      persons: [{ display_name: 'Alice', dimensions: [], summary: {} }],
      transcript: rawUtterances,
      cleaned_transcript: [
        // Filler word removed, pure-filler utterance u3 dropped.
        { utterance_id: 'u1', speaker_name: 'Alice', text: 'Hi, hello.', start_ms: 0, end_ms: 3000 },
        { utterance_id: 'u2', speaker_name: 'Bob', text: 'Thanks.', start_ms: 4000, end_ms: 6000 },
      ],
    };

    const metricsRaw = normalizeApiReport(rawOnly).persons[0].communicationMetrics!;
    const metricsCleaned = normalizeApiReport(withCleaned).persons[0].communicationMetrics!;

    // Metrics must be byte-for-byte identical regardless of cleaned_transcript.
    expect(metricsCleaned).toEqual(metricsRaw);
    // Sanity: raw-based metrics count the fillers and both Alice turns.
    expect(metricsRaw.fillerWordCount).toBeGreaterThan(0);
    expect(metricsRaw.turnCount).toBe(2);
  });

  it('exposes rawTranscript only when it differs from the cleaned display transcript', () => {
    const withCleaned: RawApiReport = {
      transcript: [{ utterance_id: 'u1', speaker_name: 'Alice', text: 'raw', start_ms: 0, end_ms: 1000 }],
      cleaned_transcript: [{ utterance_id: 'u1', speaker_name: 'Alice', text: 'Raw.', start_ms: 0, end_ms: 1000 }],
    };
    const withCleanedResult = normalizeApiReport(withCleaned);
    expect(withCleanedResult.transcript[0].text).toBe('Raw.');
    expect(withCleanedResult.rawTranscript).toBeDefined();
    expect(withCleanedResult.rawTranscript![0].text).toBe('raw');

    // No cleaned_transcript → display is raw, so rawTranscript is omitted.
    const rawOnly: RawApiReport = {
      transcript: [{ utterance_id: 'u1', speaker_name: 'Alice', text: 'raw', start_ms: 0, end_ms: 1000 }],
    };
    expect(normalizeApiReport(rawOnly).rawTranscript).toBeUndefined();
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
