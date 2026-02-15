/**
 * Shared reconciliation logic for building speaker-resolved transcripts.
 *
 * This logic is used in three places:
 *   1. buildTranscriptForFeedback (feedback cache refresh)
 *   2. runFinalizeV2Job (finalization pipeline)
 *   3. state GET handler (live session view)
 *
 * All functions are pure — no Durable Object dependencies.
 */

import type { TranscriptItem } from "./finalize_v2";
import type { SpeakerLogs, SpeakerMapItem } from "./types_v2";

/** Minimal subset of SpeakerEvent needed for reconciliation. */
export interface ReconcileSpeakerEvent {
  stream_role: string;
  utterance_id?: string | null;
  cluster_id?: string | null;
  speaker_name?: string | null;
  decision?: "auto" | "confirm" | "unknown" | null;
}

/** Minimal subset of UtteranceRaw needed for reconciliation. */
export interface ReconcileUtterance {
  utterance_id: string;
  stream_role: "mixed" | "teacher" | "students";
  text: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
}

/** Minimal subset of SessionState needed for reconciliation. */
export interface ReconcileSessionState {
  bindings: Record<string, string>;
  cluster_binding_meta: Record<string, {
    participant_name?: string;
    source?: string;
    locked?: boolean;
  }>;
}

/**
 * Infer the best-matching cluster ID for a time range from edge diarization turns.
 * Uses maximum overlap to find the cluster.
 */
export function inferClusterFromEdgeTurns(
  edgeTurns: Array<{ start_ms: number; end_ms: number; cluster_id: string }>,
  startMs: number,
  endMs: number
): string | null {
  if (edgeTurns.length === 0) return null;
  let bestCluster: string | null = null;
  let bestOverlap = 0;
  for (const turn of edgeTurns) {
    const overlap = Math.min(endMs, turn.end_ms) - Math.max(startMs, turn.start_ms);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestCluster = turn.cluster_id;
    }
  }
  return bestOverlap > 0 ? bestCluster : null;
}

function valueAsStr(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * Resolve a student utterance's speaker name from binding metadata.
 * Returns the best available speaker name and confidence decision.
 */
export function resolveStudentBinding(
  state: ReconcileSessionState,
  clusterId: string | null,
  eventSpeakerName: string | null,
  eventDecision: "auto" | "confirm" | "unknown" | null,
  speakerMapByCluster: Map<string, SpeakerMapItem> = new Map()
): { speaker_name: string | null; decision: "auto" | "confirm" | "unknown" | null } {
  if (!clusterId) {
    if (eventSpeakerName) {
      return {
        speaker_name: eventSpeakerName,
        decision: eventDecision ?? "confirm"
      };
    }
    return { speaker_name: null, decision: "unknown" };
  }
  const meta = state.cluster_binding_meta[clusterId];
  const directBinding = valueAsStr(state.bindings[clusterId]);
  const metaBinding = valueAsStr(meta?.participant_name);
  const bound = directBinding || metaBinding || null;
  if (meta?.locked && bound) return { speaker_name: bound, decision: "auto" };
  if (meta?.source === "manual_map" && bound) return { speaker_name: bound, decision: "auto" };
  if (meta?.source === "enrollment_match" && bound) {
    return { speaker_name: bound, decision: directBinding ? "auto" : "confirm" };
  }
  if (meta?.source === "name_extract" && bound) return { speaker_name: bound, decision: "confirm" };
  if (bound) return { speaker_name: bound, decision: directBinding ? "auto" : "confirm" };

  const mapItem = speakerMapByCluster.get(clusterId);
  const mapName = valueAsStr(mapItem?.display_name ?? mapItem?.person_id);
  if (mapName) {
    if (mapItem?.source === "manual") {
      return { speaker_name: mapName, decision: "auto" };
    }
    if (mapItem?.source === "enroll" || mapItem?.source === "name_extract") {
      return { speaker_name: mapName, decision: "confirm" };
    }
    return { speaker_name: mapName, decision: eventDecision ?? "confirm" };
  }

  if (eventSpeakerName) {
    return {
      speaker_name: eventSpeakerName,
      decision: eventDecision ?? "confirm"
    };
  }
  return { speaker_name: null, decision: "unknown" };
}

/**
 * Prepare edge turns (sorted, filtered to students) from speaker logs
 * for use in cluster inference.
 */
export function prepareEdgeTurns(
  speakerLogs: SpeakerLogs,
  diarizationBackend: "cloud" | "edge"
): Array<{ start_ms: number; end_ms: number; cluster_id: string }> {
  if (diarizationBackend !== "edge") return [];
  return [...speakerLogs.turns]
    .filter((item) => item.stream_role === "students")
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}

/**
 * Build a speaker-resolved transcript from raw utterances, speaker events,
 * and diarization data. This is the shared reconciliation logic used across
 * the feedback cache, finalization pipeline, and state endpoint.
 */
export function buildReconciledTranscript(options: {
  utterances: ReconcileUtterance[];
  events: ReconcileSpeakerEvent[];
  speakerLogs: SpeakerLogs;
  state: ReconcileSessionState;
  diarizationBackend: "cloud" | "edge";
  /** Optional seq cutoff per stream role (used by finalize to freeze at a point). */
  seqCutoff?: Record<string, number>;
}): TranscriptItem[] {
  const { utterances, events, speakerLogs, state, diarizationBackend } = options;

  const eventByUtterance = new Map(
    events
      .filter((item) => item.stream_role === "students" && item.utterance_id)
      .map((item) => [item.utterance_id as string, item])
  );
  const teacherEventByUtterance = new Map(
    events
      .filter((item) => item.stream_role === "teacher" && item.utterance_id)
      .map((item) => [item.utterance_id as string, item])
  );

  const edgeTurns = prepareEdgeTurns(speakerLogs, diarizationBackend);
  const speakerMapByCluster = new Map(
    speakerLogs.speaker_map.map((item) => [item.cluster_id, item])
  );

  return utterances
    .map((item) => {
      const event =
        item.stream_role === "teacher"
          ? teacherEventByUtterance.get(item.utterance_id)
          : eventByUtterance.get(item.utterance_id);
      const inferredStudentsCluster =
        item.stream_role === "students" && diarizationBackend === "edge"
          ? inferClusterFromEdgeTurns(edgeTurns, item.start_ms, item.end_ms)
          : null;
      const clusterId =
        event?.cluster_id ??
        (item.stream_role === "students" ? inferredStudentsCluster : "teacher");
      const reconciled =
        item.stream_role === "students"
          ? resolveStudentBinding(
              state,
              clusterId ?? null,
              event?.speaker_name ?? null,
              event?.decision ?? null,
              speakerMapByCluster
            )
          : {
              speaker_name: event?.speaker_name ?? null,
              decision: event?.decision ?? null
            };
      return {
        utterance_id: item.utterance_id,
        stream_role: item.stream_role,
        cluster_id: clusterId ?? null,
        speaker_name: reconciled.speaker_name,
        decision: reconciled.decision,
        text: item.text,
        start_ms: item.start_ms,
        end_ms: item.end_ms,
        duration_ms: item.duration_ms
      } satisfies TranscriptItem;
    })
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}
