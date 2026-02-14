import type {
  DimensionClaim,
  DimensionFeedback,
  EvidenceItem,
  MemoItem,
  PersonFeedbackItem,
  ReportQualityMeta,
  ResultV2,
  SpeakerLogs,
  SpeakerStatItem,
} from "./types_v2";

export interface TranscriptItem {
  utterance_id: string;
  stream_role: "mixed" | "teacher" | "students";
  cluster_id?: string | null;
  speaker_name?: string | null;
  decision?: "auto" | "confirm" | "unknown" | null;
  text: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
}

const DIMENSIONS: DimensionFeedback["dimension"][] = [
  "leadership",
  "collaboration",
  "logic",
  "structure",
  "initiative"
];

const DIMENSION_KEYWORDS: Record<DimensionFeedback["dimension"], string[]> = {
  leadership: ["leadership", "leader", "主导", "推动", "带领", "组织", "决策"],
  collaboration: ["collaboration", "协作", "配合", "倾听", "support", "补充", "互动"],
  logic: ["logic", "logical", "论证", "推理", "依据", "reason", "分析"],
  structure: ["structure", "结构", "框架", "总结", "步骤", "拆解"],
  initiative: ["initiative", "主动", "推进", "next step", "提议", "行动"]
};

const DEFAULT_DIMENSION_TEXT: Record<
  DimensionFeedback["dimension"],
  { strength: string; risk: string; action: string }
> = {
  leadership: {
    strength: "展现了推动讨论与收敛结论的能力。",
    risk: "在主导节奏与听取他人之间的平衡仍可优化。",
    action: "下一次先明确分工，再在关键节点推动决策。"
  },
  collaboration: {
    strength: "能回应同伴观点并保持讨论连贯。",
    risk: "对他人观点的复述与确认不足时会影响协作清晰度。",
    action: "增加对同伴观点的确认性回应，再提出自己的补充。"
  },
  logic: {
    strength: "能围绕问题给出有因果关系的分析。",
    risk: "部分结论在证据与推理链衔接上不够充分。",
    action: "按“结论-依据-验证”三步法组织表达。"
  },
  structure: {
    strength: "回答具备阶段性结构，信息传递较清晰。",
    risk: "在高压讨论中结构容易被打断而出现跳跃。",
    action: "先给出框架提纲，再逐段展开并做小结。"
  },
  initiative: {
    strength: "具备主动推进讨论与提出下一步的意识。",
    risk: "主动发起时机偶尔偏晚，影响整体推进效率。",
    action: "在识别卡点后尽早提出可执行的下一步建议。"
  }
};

function speakerKey(item: TranscriptItem): string {
  if (item.speaker_name) return item.speaker_name;
  if (item.cluster_id) return item.cluster_id;
  if (item.stream_role === "teacher") return "teacher";
  return "unknown";
}

export function computeSpeakerStats(transcript: TranscriptItem[]): SpeakerStatItem[] {
  const items = [...transcript].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const statMap = new Map<string, SpeakerStatItem>();

  for (const item of items) {
    const key = speakerKey(item);
    const current = statMap.get(key) ?? {
      speaker_key: key,
      speaker_name: item.speaker_name ?? null,
      talk_time_ms: 0,
      turns: 0,
      silence_ms: 0,
      interruptions: 0,
      interrupted_by_others: 0,
    };
    current.talk_time_ms += Math.max(0, item.duration_ms);
    current.turns += 1;
    statMap.set(key, current);
  }

  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1];
    const curr = items[i];
    const prevKey = speakerKey(prev);
    const currKey = speakerKey(curr);
    if (prevKey === currKey) continue;

    const gap = curr.start_ms - prev.end_ms;
    if (gap > 0 && gap <= 1500) {
      const prevStat = statMap.get(prevKey);
      if (prevStat) prevStat.silence_ms += gap;
    }

    const interruption = curr.start_ms <= prev.end_ms + 300 && prev.duration_ms >= 1200;
    if (interruption) {
      const actor = statMap.get(currKey);
      if (actor) actor.interruptions += 1;
      const target = statMap.get(prevKey);
      if (target) target.interrupted_by_others += 1;
    }
  }

  return [...statMap.values()].sort((a, b) => b.talk_time_ms - a.talk_time_ms);
}

function quoteFromUtterance(text: string, maxLen = 160): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen - 1).trimEnd() + "…";
}

function normalizeMemoText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeDimensionFromMemo(memo: MemoItem): DimensionFeedback["dimension"] {
  const tagText = memo.tags.join(" ").toLowerCase();
  const memoText = normalizeMemoText(memo.text).toLowerCase();
  for (const dimension of DIMENSIONS) {
    const keywords = DIMENSION_KEYWORDS[dimension];
    if (keywords.some((keyword) => tagText.includes(keyword) || memoText.includes(keyword))) {
      return dimension;
    }
  }
  if (memo.type === "question") return "logic";
  if (memo.type === "decision") return "structure";
  if (memo.type === "score") return "initiative";
  return "collaboration";
}

function claimTypeByMemoType(memoType: MemoItem["type"]): "strengths" | "risks" | "actions" {
  if (memoType === "question") return "risks";
  if (memoType === "decision" || memoType === "score") return "actions";
  if (memoType === "evidence") return "strengths";
  return "strengths";
}

function ensureClaimEvidence(
  candidate: string[],
  fallbackBySpeaker: string[],
  globalFallback: string[]
): string[] {
  const fromCandidate = candidate.filter(Boolean);
  if (fromCandidate.length > 0) return fromCandidate;
  if (fallbackBySpeaker.length > 0) return [fallbackBySpeaker[0]];
  if (globalFallback.length > 0) return [globalFallback[0]];
  return [];
}

function buildWeakEvidenceUtteranceSet(transcript: TranscriptItem[]): Set<string> {
  const weak = new Set<string>();
  const sorted = [...transcript].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.stream_role !== "students" || curr.stream_role !== "students") continue;
    if (speakerKey(prev) === speakerKey(curr)) continue;
    const overlapMs = Math.min(prev.end_ms, curr.end_ms) - Math.max(prev.start_ms, curr.start_ms);
    if (overlapMs > 0) {
      weak.add(prev.utterance_id);
      weak.add(curr.utterance_id);
    }
  }
  return weak;
}

function hasWeakEvidenceRefs(refs: string[], evidenceById: Map<string, EvidenceItem>): boolean {
  for (const ref of refs) {
    const evidence = evidenceById.get(ref);
    if (evidence?.weak) return true;
  }
  return false;
}

function confidenceWithWeakEvidence(
  base: number,
  refs: string[],
  evidenceById: Map<string, EvidenceItem>
): number {
  const downWeighted = hasWeakEvidenceRefs(refs, evidenceById) ? base - 0.18 : base;
  return Math.min(0.95, Math.max(0.3, downWeighted));
}

function toClaimId(personKey: string, dimension: DimensionFeedback["dimension"], index: number): string {
  const normalized = personKey.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return `c_${normalized}_${dimension}_${String(index).padStart(2, "0")}`;
}

export function buildEvidence(options: {
  memos: MemoItem[];
  transcript: TranscriptItem[];
}): EvidenceItem[] {
  const { memos, transcript } = options;
  const utteranceMap = new Map(transcript.map((item) => [item.utterance_id, item]));
  const sorted = [...transcript].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const weakUtterances = buildWeakEvidenceUtteranceSet(transcript);
  const evidence: EvidenceItem[] = [];
  let seq = 1;

  function nextEvidenceId(): string {
    return `e_${String(seq++).padStart(6, "0")}`;
  }

  for (const memo of memos) {
    let picked: TranscriptItem | null = null;
    let utteranceIds: string[] = [];
    let range: [number, number] = [memo.created_at_ms, memo.created_at_ms];

    if (memo.anchors?.utterance_ids && memo.anchors.utterance_ids.length > 0) {
      utteranceIds = memo.anchors.utterance_ids.filter((id) => utteranceMap.has(id));
      if (utteranceIds.length > 0) {
        picked = utteranceMap.get(utteranceIds[0]) ?? null;
      }
    } else if (memo.anchors?.time_range_ms) {
      range = memo.anchors.time_range_ms;
      picked =
        sorted.find((item) => item.start_ms <= range[1] && item.end_ms >= range[0]) ?? null;
      utteranceIds = picked ? [picked.utterance_id] : [];
    } else {
      const ts = memo.created_at_ms;
      picked =
        sorted.find((item) => Math.abs(item.start_ms - ts) <= 10_000 || Math.abs(item.end_ms - ts) <= 10_000) ??
        null;
      utteranceIds = picked ? [picked.utterance_id] : [];
    }

    if (picked) {
      range = [picked.start_ms, picked.end_ms];
    }

    evidence.push({
      evidence_id: nextEvidenceId(),
      type: "quote",
      time_range_ms: range,
      utterance_ids: utteranceIds,
      speaker: {
        cluster_id: picked?.cluster_id ?? null,
        person_id: picked?.speaker_name ?? null,
        display_name: picked?.speaker_name ?? null,
      },
      quote: picked ? quoteFromUtterance(picked.text) : quoteFromUtterance(memo.text),
      confidence: picked ? (weakUtterances.has(picked.utterance_id) ? 0.56 : 0.8) : 0.52,
      weak: picked ? weakUtterances.has(picked.utterance_id) : false,
      weak_reason: picked && weakUtterances.has(picked.utterance_id) ? "overlap_risk" : null,
    });
  }

  // Keep a transcript-backed fallback evidence index so report claims always
  // have traceable quote anchors even when teacher memos are sparse.
  const fallbackBySpeaker = new Set<string>();
  for (const item of sorted) {
    const key = speakerKey(item);
    if (fallbackBySpeaker.has(key)) continue;
    evidence.push({
      evidence_id: nextEvidenceId(),
      type: "quote",
      time_range_ms: [item.start_ms, item.end_ms],
      utterance_ids: [item.utterance_id],
      speaker: {
        cluster_id: item.cluster_id ?? null,
        person_id: item.speaker_name ?? key,
        display_name: item.speaker_name ?? key
      },
      quote: quoteFromUtterance(item.text),
      confidence: weakUtterances.has(item.utterance_id) ? 0.52 : 0.74,
      weak: weakUtterances.has(item.utterance_id),
      weak_reason: weakUtterances.has(item.utterance_id) ? "overlap_risk" : null
    });
    fallbackBySpeaker.add(key);
  }

  return evidence;
}

export function attachEvidenceToMemos(
  memos: MemoItem[],
  evidence: EvidenceItem[]
): Array<MemoItem & { evidence_ids: string[] }> {
  const result: Array<MemoItem & { evidence_ids: string[] }> = [];
  for (let i = 0; i < memos.length; i += 1) {
    const ev = evidence[i];
    result.push({
      ...memos[i],
      evidence_ids: ev ? [ev.evidence_id] : [],
    });
  }
  return result;
}

function inferMemoSpeakerKey(
  memo: MemoItem & { evidence_ids?: string[] },
  evidenceById: Map<string, EvidenceItem>
): string {
  const refs = Array.isArray(memo.evidence_ids) ? memo.evidence_ids : [];
  for (const ref of refs) {
    const hit = evidenceById.get(ref);
    if (!hit) continue;
    const display = String(hit.speaker?.display_name || "").trim();
    if (display) return display;
    const cluster = String(hit.speaker?.cluster_id || "").trim();
    if (cluster) return cluster;
  }
  return "unknown";
}

export function buildMemoFirstReport(options: {
  transcript: TranscriptItem[];
  memos: Array<MemoItem & { evidence_ids?: string[] }>;
  evidence: EvidenceItem[];
  stats: SpeakerStatItem[];
}): { overall: unknown; per_person: PersonFeedbackItem[] } {
  const evidenceById = new Map(options.evidence.map((item) => [item.evidence_id, item]));
  const evidenceBySpeaker = new Map<string, string[]>();
  for (const item of options.evidence) {
    const speaker =
      String(item.speaker?.display_name || "").trim() ||
      String(item.speaker?.cluster_id || "").trim() ||
      "unknown";
    const current = evidenceBySpeaker.get(speaker) ?? [];
    current.push(item.evidence_id);
    evidenceBySpeaker.set(speaker, current);
  }
  const globalEvidenceRefs = options.evidence.map((item) => item.evidence_id);
  const people = options.stats.length
    ? options.stats
    : [
        {
          speaker_key: "unknown",
          speaker_name: "unknown",
          talk_time_ms: 0,
          turns: 0,
          silence_ms: 0,
          interruptions: 0,
          interrupted_by_others: 0
        }
      ];

  const perPerson: PersonFeedbackItem[] = [];

  for (const stat of people) {
    const personKey = stat.speaker_name ?? stat.speaker_key;
    const fallbackBySpeaker = evidenceBySpeaker.get(personKey) ?? [];
    const memoRows = options.memos.filter((memo) => inferMemoSpeakerKey(memo, evidenceById) === personKey);
    const dimensions: DimensionFeedback[] = DIMENSIONS.map((dimension) => ({
      dimension,
      strengths: [],
      risks: [],
      actions: []
    }));
    const byDimension = new Map(dimensions.map((item) => [item.dimension, item]));

    for (const memo of memoRows) {
      const dimension = normalizeDimensionFromMemo(memo);
      const bucket = claimTypeByMemoType(memo.type);
      const target = byDimension.get(dimension);
      if (!target) continue;
      const refs = ensureClaimEvidence(
        Array.isArray(memo.evidence_ids) ? memo.evidence_ids : [],
        fallbackBySpeaker,
        globalEvidenceRefs
      );
      const claimList = target[bucket];
      claimList.push({
        claim_id: toClaimId(personKey, dimension, claimList.length + 1),
        text: normalizeMemoText(memo.text),
        evidence_refs: refs,
        confidence: refs.length > 0 ? confidenceWithWeakEvidence(0.86, refs, evidenceById) : 0.42
      });
    }

    for (const dimension of DIMENSIONS) {
      const target = byDimension.get(dimension);
      if (!target) continue;
      const template = DEFAULT_DIMENSION_TEXT[dimension];
      if (target.strengths.length === 0) {
        const refs = ensureClaimEvidence([], fallbackBySpeaker, globalEvidenceRefs);
        target.strengths.push({
          claim_id: toClaimId(personKey, dimension, 1),
          text: template.strength,
          evidence_refs: refs,
          confidence: refs.length > 0 ? confidenceWithWeakEvidence(0.74, refs, evidenceById) : 0.35
        });
      }
      if (target.risks.length === 0) {
        const refs = ensureClaimEvidence([], fallbackBySpeaker, globalEvidenceRefs);
        target.risks.push({
          claim_id: toClaimId(personKey, dimension, 2),
          text: template.risk,
          evidence_refs: refs,
          confidence: refs.length > 0 ? confidenceWithWeakEvidence(0.7, refs, evidenceById) : 0.33
        });
      }
      if (target.actions.length === 0) {
        const refs = ensureClaimEvidence([], fallbackBySpeaker, globalEvidenceRefs);
        target.actions.push({
          claim_id: toClaimId(personKey, dimension, 3),
          text: template.action,
          evidence_refs: refs,
          confidence: refs.length > 0 ? confidenceWithWeakEvidence(0.72, refs, evidenceById) : 0.34
        });
      }
    }

    const summaryStrengths = dimensions
      .flatMap((item) => item.strengths.slice(0, 1).map((claim) => claim.text))
      .slice(0, 3);
    const summaryRisks = dimensions
      .flatMap((item) => item.risks.slice(0, 1).map((claim) => claim.text))
      .slice(0, 3);
    const summaryActions = dimensions
      .flatMap((item) => item.actions.slice(0, 1).map((claim) => claim.text))
      .slice(0, 3);

    perPerson.push({
      person_key: stat.speaker_key,
      display_name: personKey,
      dimensions,
      summary: {
        strengths: summaryStrengths,
        risks: summaryRisks,
        actions: summaryActions
      }
    });
  }

  const memoBullets = options.memos.slice(-6).map((memo) => normalizeMemoText(memo.text)).filter(Boolean);
  const overall = {
    summary_sections: [
      {
        topic: "Teacher Memos",
        bullets: memoBullets.length > 0 ? memoBullets : ["本场记录已生成，建议结合个人维度反馈查看。"],
        evidence_ids: globalEvidenceRefs.slice(0, 4)
      }
    ],
    team_dynamics: {
      highlights: perPerson.flatMap((item) => item.summary.strengths.slice(0, 1)).slice(0, 3),
      risks: perPerson.flatMap((item) => item.summary.risks.slice(0, 1)).slice(0, 3)
    }
  };

  return {
    overall,
    per_person: perPerson
  };
}

export function validatePersonFeedbackEvidence(perPerson: PersonFeedbackItem[]): {
  valid: boolean;
  quality: ReportQualityMeta;
} {
  const startedAt = Date.now();
  let claimCount = 0;
  let invalidClaimCount = 0;
  let needsEvidenceCount = 0;
  for (const person of perPerson) {
    for (const dimension of person.dimensions) {
      const allClaims: DimensionClaim[] = [
        ...dimension.strengths,
        ...dimension.risks,
        ...dimension.actions
      ];
      for (const claim of allClaims) {
        claimCount += 1;
        const refs = Array.isArray(claim.evidence_refs) ? claim.evidence_refs.filter(Boolean) : [];
        if (refs.length === 0) {
          invalidClaimCount += 1;
          needsEvidenceCount += 1;
        }
      }
    }
  }
  const buildMs = Date.now() - startedAt;
  return {
    valid: invalidClaimCount === 0 && claimCount > 0,
    quality: {
      generated_at: new Date().toISOString(),
      build_ms: buildMs,
      validation_ms: 0,
      claim_count: claimCount,
      invalid_claim_count: invalidClaimCount,
      needs_evidence_count: needsEvidenceCount
    }
  };
}

export function buildReportExportText(result: ResultV2): string {
  const lines: string[] = [];
  lines.push(`Session: ${result.session.session_id}`);
  lines.push(`Finalized At: ${result.session.finalized_at}`);
  lines.push("");
  lines.push("Overall:");
  const sections = Array.isArray((result.overall as { summary_sections?: unknown[] })?.summary_sections)
    ? ((result.overall as { summary_sections?: Array<{ topic?: string; bullets?: string[] }> }).summary_sections ?? [])
    : [];
  for (const section of sections) {
    lines.push(`- ${section.topic || "Section"}`);
    for (const bullet of section.bullets ?? []) {
      lines.push(`  * ${bullet}`);
    }
  }
  lines.push("");
  lines.push("Per Person:");
  for (const person of result.per_person) {
    lines.push(`- ${person.display_name}`);
    for (const dimension of person.dimensions) {
      lines.push(`  [${dimension.dimension}]`);
      for (const claim of dimension.strengths) {
        lines.push(`    Strength: ${claim.text} (evidence=${claim.evidence_refs.join(",") || "none"})`);
      }
      for (const claim of dimension.risks) {
        lines.push(`    Risk: ${claim.text} (evidence=${claim.evidence_refs.join(",") || "none"})`);
      }
      for (const claim of dimension.actions) {
        lines.push(`    Action: ${claim.text} (evidence=${claim.evidence_refs.join(",") || "none"})`);
      }
    }
  }
  return lines.join("\n");
}

export function buildReportExportMarkdown(result: ResultV2): string {
  const lines: string[] = [];
  lines.push(`# Session ${result.session.session_id}`);
  lines.push(`- Finalized: ${result.session.finalized_at}`);
  lines.push("");
  lines.push("## Overall");
  const sections = Array.isArray((result.overall as { summary_sections?: unknown[] })?.summary_sections)
    ? ((result.overall as { summary_sections?: Array<{ topic?: string; bullets?: string[] }> }).summary_sections ?? [])
    : [];
  for (const section of sections) {
    lines.push(`### ${section.topic || "Section"}`);
    for (const bullet of section.bullets ?? []) {
      lines.push(`- ${bullet}`);
    }
  }
  lines.push("");
  lines.push("## Per Person");
  for (const person of result.per_person) {
    lines.push(`### ${person.display_name}`);
    for (const dimension of person.dimensions) {
      lines.push(`#### ${dimension.dimension}`);
      for (const claim of dimension.strengths) {
        lines.push(`- Strength: ${claim.text} _(evidence: ${claim.evidence_refs.join(", ") || "none"})_`);
      }
      for (const claim of dimension.risks) {
        lines.push(`- Risk: ${claim.text} _(evidence: ${claim.evidence_refs.join(", ") || "none"})_`);
      }
      for (const claim of dimension.actions) {
        lines.push(`- Action: ${claim.text} _(evidence: ${claim.evidence_refs.join(", ") || "none"})_`);
      }
    }
  }
  return lines.join("\n");
}

export function computeUnknownRatio(transcript: TranscriptItem[]): number {
  const students = transcript.filter((item) => item.stream_role === "students");
  if (students.length === 0) return 0;
  const unknownCount = students.filter((item) => !item.speaker_name || item.speaker_name === "unknown").length;
  return unknownCount / students.length;
}

export function buildResultV2(params: {
  sessionId: string;
  finalizedAt: string;
  tentative: boolean;
  unresolvedClusterCount: number;
  diarizationBackend: "cloud" | "edge";
  transcript: TranscriptItem[];
  speakerLogs: SpeakerLogs;
  stats: SpeakerStatItem[];
  memos: MemoItem[];
  evidence: EvidenceItem[];
  overall: unknown;
  perPerson: PersonFeedbackItem[];
  quality: ReportQualityMeta;
  finalizeJobId: string;
  modelVersions: Record<string, string>;
  thresholds: Record<string, number | string | boolean>;
  backendTimeline?: Array<{
    ts: string;
    endpoint: string;
    backend: string;
    outcome: "ok" | "failed" | "skipped";
    detail: string;
    attempt: number;
  }>;
  qualityGateSnapshot?: {
    finalize_success_target: number;
    students_unknown_ratio_target: number;
    sv_top1_target: number;
    echo_reduction_target: number;
    observed_unknown_ratio: number;
    observed_students_turns: number;
    observed_students_unknown: number;
    observed_echo_suppressed_chunks: number;
    observed_echo_recent_rate: number;
    observed_echo_leak_rate?: number;
    observed_suppression_false_positive_rate?: number;
  };
  reportPipeline?: {
    mode: "memo_first_with_llm_polish" | "llm_core_synthesis";
    source: "memo_first" | "llm_enhanced" | "llm_failed"
      | "llm_synthesized" | "llm_synthesized_truncated" | "memo_first_fallback";
    llm_attempted: boolean;
    llm_success: boolean;
    llm_elapsed_ms: number | null;
    blocking_reason?: string | null;
  };
  qualityGateFailures?: string[];
}): ResultV2 {
  return {
    session: {
      session_id: params.sessionId,
      finalized_at: params.finalizedAt,
      tentative: params.tentative,
      unresolved_cluster_count: params.unresolvedClusterCount,
      diarization_backend: params.diarizationBackend,
    },
    transcript: params.transcript,
    speaker_logs: params.speakerLogs,
    stats: params.stats,
    memos: params.memos,
    evidence: params.evidence,
    overall: params.overall,
    per_person: params.perPerson,
    quality: params.quality,
    trace: {
      finalize_job_id: params.finalizeJobId,
      model_versions: params.modelVersions,
      thresholds: params.thresholds,
      unknown_ratio: computeUnknownRatio(params.transcript),
      backend_timeline: params.backendTimeline ?? [],
      quality_gate_snapshot: params.qualityGateSnapshot,
      report_pipeline: params.reportPipeline,
      quality_gate_failures: params.qualityGateFailures ?? [],
      generated_at: params.finalizedAt,
    },
  };
}
