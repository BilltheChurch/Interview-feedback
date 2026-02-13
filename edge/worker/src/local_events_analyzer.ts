type AnalysisEventType = "support" | "interrupt" | "summary" | "decision" | "silence";

interface TranscriptUtterance {
  utterance_id: string;
  stream_role: "mixed" | "teacher" | "students";
  cluster_id?: string | null;
  speaker_name?: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
}

interface MemoForAnalysis {
  memo_id: string;
  created_at_ms: number;
  type: "observation" | "evidence" | "question" | "decision" | "score";
  text: string;
  anchors?: {
    mode: "time" | "utterance";
    time_range_ms?: [number, number];
    utterance_ids?: string[];
  };
}

interface SpeakerStatForAnalysis {
  speaker_key: string;
  talk_time_ms: number;
  turns: number;
}

export interface LocalAnalysisEvent {
  event_id: string;
  event_type: AnalysisEventType;
  actor: string | null;
  target: string | null;
  time_range_ms: [number, number];
  utterance_ids: string[];
  quote: string | null;
  confidence: number;
  rationale: string;
}

function speakerKey(item: TranscriptUtterance): string {
  if (item.speaker_name) return item.speaker_name;
  if (item.cluster_id) return item.cluster_id;
  if (item.stream_role === "teacher") return "teacher";
  return "unknown";
}

function quote(text: string, limit = 160): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function containsCue(text: string, cues: string[]): boolean {
  const lowered = text.toLowerCase();
  return cues.some((cue) => lowered.includes(cue));
}

function sortTranscript(items: TranscriptUtterance[]): TranscriptUtterance[] {
  return [...items].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}

export function analyzeEventsLocally(params: {
  sessionId: string;
  transcript: TranscriptUtterance[];
  memos: MemoForAnalysis[];
  stats: SpeakerStatForAnalysis[];
}): LocalAnalysisEvent[] {
  const supportCues = ["i agree", "based on", "to add", "building on", "补充", "我同意", "支持"];
  const summaryCues = ["let me summarize", "in summary", "to summarize", "总结一下", "小结"];
  const decisionCues = ["we decide", "decision", "next step", "conclusion", "决定", "结论", "下一步"];

  const items = sortTranscript(params.transcript);
  const events: LocalAnalysisEvent[] = [];
  let seq = 1;

  const pushEvent = (
    eventType: AnalysisEventType,
    item: TranscriptUtterance,
    options?: {
      actor?: string | null;
      target?: string | null;
      confidence?: number;
      rationale?: string;
      utteranceIds?: string[];
      quoteText?: string | null;
      range?: [number, number];
    }
  ) => {
    events.push({
      event_id: `ev_${params.sessionId}_${String(seq).padStart(4, "0")}`,
      event_type: eventType,
      actor: options?.actor ?? speakerKey(item),
      target: options?.target ?? null,
      time_range_ms: options?.range ?? [item.start_ms, item.end_ms],
      utterance_ids: options?.utteranceIds ?? [item.utterance_id],
      quote: options?.quoteText ?? quote(item.text),
      confidence: Math.max(0, Math.min(1, options?.confidence ?? 0.7)),
      rationale: options?.rationale ?? "local events analyzer"
    });
    seq += 1;
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (containsCue(item.text, supportCues)) {
      const prev = i > 0 ? items[i - 1] : null;
      const target = prev && speakerKey(prev) !== speakerKey(item) ? speakerKey(prev) : null;
      pushEvent("support", item, {
        target,
        confidence: 0.72,
        rationale: "support cue detected"
      });
    }
    if (containsCue(item.text, summaryCues)) {
      pushEvent("summary", item, {
        confidence: 0.78,
        rationale: "summary cue detected"
      });
    }
    if (containsCue(item.text, decisionCues)) {
      pushEvent("decision", item, {
        confidence: 0.8,
        rationale: "decision cue detected"
      });
    }

    if (i > 0) {
      const prev = items[i - 1];
      if (speakerKey(prev) !== speakerKey(item)) {
        const interruption = item.start_ms <= prev.end_ms + 300 && prev.duration_ms >= 1200;
        if (interruption) {
          pushEvent("interrupt", item, {
            actor: speakerKey(item),
            target: speakerKey(prev),
            confidence: 0.67,
            rationale: "rapid speaker switch near previous turn end"
          });
        }
      }
    }
  }

  const totalTalkMs = params.stats.reduce((sum, item) => sum + Math.max(0, item.talk_time_ms), 0);
  if (totalTalkMs > 0) {
    for (const stat of params.stats) {
      const ratio = stat.talk_time_ms / totalTalkMs;
      if (ratio < 0.05 && stat.turns <= 2) {
        events.push({
          event_id: `ev_${params.sessionId}_${String(seq).padStart(4, "0")}`,
          event_type: "silence",
          actor: stat.speaker_key,
          target: null,
          time_range_ms: [0, 0],
          utterance_ids: [],
          quote: null,
          confidence: 0.75,
          rationale: "low talk-time ratio and low turns"
        });
        seq += 1;
      }
    }
  }

  for (const memo of params.memos) {
    const text = memo.text.trim();
    if (!text) continue;
    if (memo.type !== "observation" && memo.type !== "decision") continue;
    const range = memo.anchors?.time_range_ms ?? [memo.created_at_ms, memo.created_at_ms];
    pushEvent(memo.type === "decision" ? "decision" : "summary", {
      utterance_id: memo.memo_id,
      stream_role: "teacher",
      text,
      start_ms: range[0],
      end_ms: range[1],
      duration_ms: Math.max(0, range[1] - range[0]),
      cluster_id: "teacher",
      speaker_name: "teacher"
    }, {
      actor: "teacher",
      confidence: 0.82,
      rationale: "teacher memo signal",
      utteranceIds: memo.anchors?.utterance_ids ?? [],
      quoteText: quote(text),
      range: [range[0], range[1]]
    });
  }

  return events;
}

