import type {
  EvidenceItem,
  MemoItem,
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

export function buildEvidence(options: {
  memos: MemoItem[];
  transcript: TranscriptItem[];
}): EvidenceItem[] {
  const { memos, transcript } = options;
  const utteranceMap = new Map(transcript.map((item) => [item.utterance_id, item]));
  const sorted = [...transcript].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
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
      confidence: picked ? 0.8 : 0.52,
    });
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
  perPerson: unknown[];
  finalizeJobId: string;
  modelVersions: Record<string, string>;
  thresholds: Record<string, number | string | boolean>;
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
    trace: {
      finalize_job_id: params.finalizeJobId,
      model_versions: params.modelVersions,
      thresholds: params.thresholds,
      unknown_ratio: computeUnknownRatio(params.transcript),
      generated_at: params.finalizedAt,
    },
  };
}
