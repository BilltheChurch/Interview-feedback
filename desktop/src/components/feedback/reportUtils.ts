import { escapeHtml } from '../../lib/sanitize';
import type { Claim, EvidenceRef, FeedbackReport, Memo } from './types';

/* ─── Time formatters ─────────────────────────────────── */

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/* ─── Report query helpers ────────────────────────────── */

export function getEvidenceById(report: FeedbackReport, id: string): EvidenceRef | undefined {
  return report.evidence.find((e) => e.id === id);
}

export function getClaimsForEvidence(report: FeedbackReport, evidenceId: string): { person: string; claim: Claim }[] {
  const results: { person: string; claim: Claim }[] = [];
  for (const person of report.persons) {
    for (const dim of person.dimensions) {
      for (const claim of dim.claims) {
        if (claim.evidence_refs.includes(evidenceId)) {
          results.push({ person: person.person_name, claim });
        }
      }
    }
  }
  return results;
}

export function updateClaimInReport(
  report: FeedbackReport,
  claimId: string,
  updater: (claim: Claim) => Claim,
): FeedbackReport {
  return {
    ...report,
    persons: report.persons.map((person) => ({
      ...person,
      dimensions: person.dimensions.map((dim) => ({
        ...dim,
        claims: dim.claims.map((claim) =>
          claim.id === claimId ? updater(claim) : claim,
        ),
      })),
    })),
  };
}

export type SurroundingUtterance = {
  utterance_id: string;
  speaker: string;
  text: string;
  start_ms: number;
  isPartOfEvidence: boolean;
};

export function getSurroundingContext(report: FeedbackReport, evidenceId: string): SurroundingUtterance[] {
  const ev = report.evidence.find(e => e.id === evidenceId);
  if (!ev) return [];

  const transcript = report.transcript;
  if (!transcript.length) return [];

  const evUttIds = new Set(ev.utterance_ids || []);

  if (evUttIds.size > 0) {
    const indices = transcript
      .map((u, i) => evUttIds.has(u.utterance_id) ? i : -1)
      .filter(i => i >= 0);
    if (indices.length === 0) return [];

    const minIdx = Math.min(...indices);
    const maxIdx = Math.max(...indices);
    const startIdx = Math.max(0, minIdx - 2);
    const endIdx = Math.min(transcript.length - 1, maxIdx + 2);

    return transcript.slice(startIdx, endIdx + 1).map(u => ({
      utterance_id: u.utterance_id,
      speaker: u.speaker_name || 'Unknown',
      text: u.text,
      start_ms: u.start_ms,
      isPartOfEvidence: evUttIds.has(u.utterance_id),
    }));
  }

  const evStart = ev.timestamp_ms;
  const evEnd = ev.end_ms || evStart + 1;
  const matchIdx = transcript.findIndex(u => u.start_ms >= evStart && u.start_ms < evEnd);
  if (matchIdx < 0) return [];

  const startIdx = Math.max(0, matchIdx - 2);
  const endIdx = Math.min(transcript.length - 1, matchIdx + 2);

  return transcript.slice(startIdx, endIdx + 1).map(u => ({
    utterance_id: u.utterance_id,
    speaker: u.speaker_name || 'Unknown',
    text: u.text,
    start_ms: u.start_ms,
    isPartOfEvidence: u.start_ms >= evStart && u.start_ms < evEnd,
  }));
}

/* ─── Export helpers ──────────────────────────────────── */

export function buildFullMarkdown(
  report: FeedbackReport,
  sessionNotes?: string,
  sessionMemos?: Memo[],
): string {
  const lines: string[] = [
    `# ${report.session_name}`,
    `**Date:** ${report.date}  `,
    `**Duration:** ${formatDuration(report.duration_ms)}  `,
    `**Mode:** ${report.mode}  `,
    `**Participants:** ${report.participants.join(', ')}`,
    '',
  ];

  if (report.overall.recommendation) {
    const rec = report.overall.recommendation;
    const label = rec.decision === 'recommend' ? 'Recommend' : rec.decision === 'tentative' ? 'Tentative' : 'Not Recommend';
    lines.push(`## Recommendation: ${label}`, '');
    lines.push(`**Confidence:** ${Math.round(rec.confidence * 100)}%  `);
    lines.push(`**Rationale:** ${rec.rationale}`, '');
  }

  const notesText = sessionNotes?.replace(/<[^>]*>/g, '').trim();
  if (notesText) {
    lines.push('## Session Notes', '', notesText, '');
  }

  if (sessionMemos && sessionMemos.length > 0) {
    lines.push('## Session Memos', '');
    for (const m of sessionMemos) {
      lines.push(`- **[${m.stage}]** ${m.text}`);
    }
    lines.push('');
  }

  lines.push('## Overview', '');
  if (report.overall.teamSummaryNarrative) {
    lines.push(report.overall.teamSummaryNarrative, '');
  } else if (report.overall.team_summary) {
    lines.push(report.overall.team_summary, '');
  }

  if (report.overall.keyFindings && report.overall.keyFindings.length > 0) {
    lines.push('### Key Findings', '');
    for (const f of report.overall.keyFindings) {
      const icon = f.type === 'strength' ? '+' : f.type === 'risk' ? '!' : '>';
      lines.push(`- **[${icon}]** ${f.text}`);
    }
    lines.push('');
  }

  if (report.overall.interviewQuality) {
    const q = report.overall.interviewQuality;
    lines.push('### Interview Quality', '');
    lines.push(`- **Coverage:** ${Math.round(q.coverage_ratio * 100)}%`);
    lines.push(`- **Follow-up Depth:** ${q.follow_up_depth}`);
    lines.push(`- **Structure Score:** ${q.structure_score.toFixed(1)}/10`);
    lines.push(`- **Suggestions:** ${q.suggestions}`);
    lines.push('');
  }

  if (report.overall.teacher_memos.length > 0) {
    lines.push('### Teacher Memos');
    lines.push(...report.overall.teacher_memos.map((m) => `- ${m}`));
    lines.push('');
  }

  if (report.overall.interaction_events.length > 0) {
    lines.push('### Interaction Events');
    lines.push(...report.overall.interaction_events.map((e) => `- ${e}`));
    lines.push('');
  }

  if (report.overall.team_dynamics.length > 0) {
    lines.push('### Team Dynamics');
    lines.push(...report.overall.team_dynamics.map((d) => `- ${d.type === 'highlight' ? '+' : '!'} ${d.text}`));
    lines.push('');
  }

  if (report.mode === 'group' && report.persons.length >= 2) {
    lines.push('### Candidate Comparison', '');
    const dims = report.persons[0].dimensions;
    const header = `| Dimension | ${report.persons.map(p => p.person_name).join(' | ')} |`;
    const sep = `|---|${report.persons.map(() => '---').join('|')}|`;
    lines.push(header, sep);
    for (const dim of dims) {
      const scores = report.persons.map(p => {
        const d = p.dimensions.find(pd => pd.dimension === dim.dimension);
        return d?.score !== undefined ? d.score.toFixed(1) : '\u2014';
      });
      lines.push(`| ${dim.label_zh || dim.dimension} | ${scores.join(' | ')} |`);
    }
    lines.push('');
  }

  if (report.overall.questionAnalysis && report.overall.questionAnalysis.length > 0) {
    lines.push('## Question-by-Question Analysis', '');
    for (const q of report.overall.questionAnalysis) {
      lines.push(`### [${q.answer_quality}] ${q.question_text}`, '');
      lines.push(`${q.comment}`, '');
      if (q.scoring_rationale) {
        lines.push(`**Scoring Rationale:** ${q.scoring_rationale}`, '');
      }
      if (q.answer_highlights && q.answer_highlights.length > 0) {
        lines.push('**Highlights:**');
        for (const h of q.answer_highlights) { lines.push(`- ${h}`); }
        lines.push('');
      }
      if (q.answer_weaknesses && q.answer_weaknesses.length > 0) {
        lines.push('**Areas for Improvement:**');
        for (const w of q.answer_weaknesses) { lines.push(`- ${w}`); }
        lines.push('');
      }
      if (q.suggested_better_answer) {
        lines.push(`**Suggested Approach:** ${q.suggested_better_answer}`, '');
      }
      if (q.related_dimensions.length > 0) {
        lines.push(`_Related: ${q.related_dimensions.join(', ')}_`, '');
      }
    }
  }

  for (const person of report.persons) {
    lines.push(`## ${person.person_name}`, '');

    if (person.communicationMetrics) {
      const m = person.communicationMetrics;
      lines.push('### Communication Metrics', '');
      lines.push(`- **Speaking Time:** ${Math.floor(m.speakingTimeSec / 60)}m ${m.speakingTimeSec % 60}s (${Math.round(m.speakingRatio * 100)}% of session)`);
      lines.push(`- **Avg Response:** ${Math.floor(m.avgResponseSec / 60)}m ${Math.round(m.avgResponseSec % 60)}s (${m.turnCount} turns)`);
      lines.push(`- **Filler Words:** ${m.fillerWordCount} (${m.fillerWordsPerMin.toFixed(1)}/min)`);
      lines.push(`- **Response Latency:** ${m.avgLatencySec.toFixed(1)}s avg, ${m.longestPauseSec.toFixed(1)}s longest`);
      lines.push('');
    }

    for (const dim of person.dimensions) {
      const label = dim.label_zh || (dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1));
      const scoreStr = dim.score !== undefined ? ` (${dim.score.toFixed(1)}/10)` : '';
      lines.push(`### ${label}${scoreStr}`, '');
      if (dim.score_rationale) {
        lines.push(`> ${dim.score_rationale}`, '');
      }
      for (const claim of dim.claims) {
        const tag = claim.category === 'strength' ? '+' : claim.category === 'risk' ? '!' : '>';
        lines.push(`- **[${tag}]** ${claim.text} _(${Math.round(claim.confidence * 100)}%)_`);
      }
      lines.push('');
    }

    lines.push('### Summary', '');
    lines.push(`- **Strengths:** ${person.summary.strengths}`);
    lines.push(`- **Risks:** ${person.summary.risks}`);
    lines.push(`- **Actions:** ${person.summary.actions}`);
    lines.push('');
  }

  if (report.improvements) {
    lines.push('## Improvement Suggestions', '');
    if (report.improvements.overall) {
      lines.push(report.improvements.overall.summary, '');
      if (report.improvements.overall.key_points?.length > 0) {
        for (const kp of report.improvements.overall.key_points) {
          lines.push(`- ${kp}`);
        }
        lines.push('');
      }
    }

    if (report.improvements.dimensions?.length > 0) {
      for (const di of report.improvements.dimensions) {
        lines.push(`### ${di.dimension} \u2014 Improvement`, '');
        lines.push(di.advice, '');
        if (di.framework) {
          lines.push(`**Framework:** ${di.framework}`, '');
        }
        if (di.example_response) {
          lines.push(`**Example:** "${di.example_response}"`, '');
        }
      }
    }

    if (report.improvements.claims?.length > 0) {
      lines.push('### Claim-level Improvements', '');
      for (const ci of report.improvements.claims) {
        lines.push(`- **${ci.claim_id}:** ${ci.advice}`);
        if (ci.suggested_wording) {
          lines.push(`  > "${ci.suggested_wording}"`);
        }
      }
      lines.push('');
    }

    if (report.improvements.follow_up_questions && report.improvements.follow_up_questions.length > 0) {
      lines.push('### Suggested Follow-up Questions', '');
      for (const q of report.improvements.follow_up_questions) {
        lines.push(`- **Q:** ${q.question}`);
        lines.push(`  _Purpose: ${q.purpose}_`);
      }
      lines.push('');
    }

    if (report.improvements.action_plan && report.improvements.action_plan.length > 0) {
      lines.push('### 30-Day Action Plan', '');
      for (let i = 0; i < report.improvements.action_plan.length; i++) {
        const item = report.improvements.action_plan[i];
        lines.push(`${i + 1}. **${item.action}**`);
        lines.push(`   - Practice: ${item.practice_method}`);
        lines.push(`   - Expected: ${item.expected_outcome}`);
      }
      lines.push('');
    }
  }

  if (report.evidence.length > 0) {
    lines.push('## Evidence Timeline', '');
    for (const ev of report.evidence) {
      const weakTag = ev.weak ? ' **(weak)**' : '';
      lines.push(
        `- **[${formatTimestamp(ev.timestamp_ms)}]** ${ev.speaker}: "${ev.text}"${weakTag} _(${Math.round(ev.confidence * 100)}%)_`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function markdownToSimpleHtml(md: string): string {
  return md
    .split('\n')
    .map(line => {
      if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      line = escapeHtml(line);
      line = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      line = line.replace(/_(.+?)_/g, '<i>$1</i>');
      if (/^\d+\.\s/.test(line)) return `<li>${line.replace(/^\d+\.\s/, '')}</li>`;
      if (line.startsWith('- ')) return `<li>${line.slice(2)}</li>`;
      if (line.startsWith('&gt; ')) return `<blockquote>${line.slice(5)}</blockquote>`;
      if (line.startsWith('|') && !line.match(/^\|[-|]+\|$/)) {
        const cells = line.split('|').filter(c => c.trim() !== '');
        return `<tr>${cells.map(c => `<td>${c.trim()}</td>`).join('')}</tr>`;
      }
      if (line.match(/^\|[-|]+\|$/)) return '';
      if (line.trim() === '') return '<br/>';
      return `<p>${line}</p>`;
    })
    .join('\n');
}

export function buildPrintHtml(
  report: FeedbackReport,
  sessionNotes?: string,
  sessionMemos?: Memo[],
): string {
  const md = buildFullMarkdown(report, sessionNotes, sessionMemos);
  const bodyHtml = markdownToSimpleHtml(md);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<style>
  @page {
    size: A4;
    margin: 16mm 14mm 18mm 14mm;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
    font-size: 11px;
    line-height: 1.6;
    color: #1E2A32;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; color: #0D6A63; border-bottom: 2px solid #0D6A63; padding-bottom: 6px; }
  h2 { font-size: 15px; font-weight: 600; margin-top: 18px; margin-bottom: 6px; color: #1E2A32; border-bottom: 1px solid #E8E4DC; padding-bottom: 4px; break-after: avoid; page-break-after: avoid; }
  h3 { font-size: 12px; font-weight: 600; margin-top: 12px; margin-bottom: 4px; color: #566A77; break-after: avoid; page-break-after: avoid; }
  p { margin-bottom: 4px; orphans: 3; widows: 3; }
  b { font-weight: 600; }
  i { color: #566A77; }
  li { margin-left: 20px; margin-bottom: 3px; list-style-type: disc; break-inside: avoid; page-break-inside: avoid; }
  li li { list-style-type: circle; }
  blockquote { margin: 4px 0 4px 12px; padding: 4px 10px; border-left: 3px solid #0D6A63; background: #F6F2EA; color: #566A77; font-style: italic; break-inside: avoid; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 10.5px; break-inside: avoid; page-break-inside: avoid; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  td { border: 1px solid #E8E4DC; padding: 4px 8px; text-align: center; }
  tr:first-child td { background: #F6F2EA; font-weight: 600; }
  br { display: block; height: 4px; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
