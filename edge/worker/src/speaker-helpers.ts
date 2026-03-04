/**
 * speaker-helpers.ts — Pure functions for speaker identity resolution
 * and speaker log derivation.
 *
 * All functions are side-effect-free and take explicit dependencies.
 */

import { emptySpeakerLogs, mergeSpeakerLogs } from "./speaker_logs";
import type { SpeakerLogs, SpeakerMapItem } from "./types_v2";
import type { TranscriptItem } from "./finalize_v2";
import type {
  StreamRole,
  SessionState,
  CaptureState,
  SpeakerEvent,
  RosterEntry
} from "./config";
import { valueAsString, extractNameFromText } from "./config";

// ── Teacher identity resolution ─────────────────────────────────────

export function resolveTeacherIdentity(
  state: SessionState,
  asrText: string
): { speakerName: string; identitySource: NonNullable<SpeakerEvent["identity_source"]> } {
  const roster = state.roster ?? [];
  const config = state.config ?? {};
  const configTeamsName = valueAsString(config.teams_interviewer_name);
  const configInterviewerName = valueAsString(config.interviewer_name);

  if (roster.length > 0) {
    if (configTeamsName) {
      const matched = roster.find((item) => item.name.trim().toLowerCase() === configTeamsName.trim().toLowerCase());
      if (matched) {
        return { speakerName: matched.name, identitySource: "teams_participants" };
      }
    }
    if (configInterviewerName) {
      const matched = roster.find((item) => item.name.trim().toLowerCase() === configInterviewerName.trim().toLowerCase());
      if (matched) {
        return { speakerName: matched.name, identitySource: "teams_participants" };
      }
    }
    if (roster.length === 1) {
      return { speakerName: roster[0].name, identitySource: "teams_participants" };
    }
  }

  if (configTeamsName) {
    return { speakerName: configTeamsName, identitySource: "preconfig" };
  }
  if (configInterviewerName) {
    return { speakerName: configInterviewerName, identitySource: "preconfig" };
  }

  const extracted = extractNameFromText(asrText);
  if (extracted) {
    return { speakerName: extracted, identitySource: "name_extract" };
  }
  return { speakerName: "teacher", identitySource: "teacher" };
}

// ── Speaker log derivation from transcript ──────────────────────────

export function deriveSpeakerLogsFromTranscript(
  nowIso: string,
  transcript: Array<{
    utterance_id: string;
    stream_role: StreamRole;
    cluster_id?: string | null;
    speaker_name?: string | null;
    text: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    decision?: "auto" | "confirm" | "unknown" | null;
  }>,
  state: SessionState,
  existing: SpeakerLogs,
  source: "cloud" | "edge" = "cloud"
): SpeakerLogs {
  const turns = transcript
    .filter((item) => item.stream_role === "students" && item.cluster_id)
    .map((item) => ({
      turn_id: `turn_${item.utterance_id}`,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
      stream_role: "students" as StreamRole,
      cluster_id: item.cluster_id as string,
      utterance_id: item.utterance_id
    }));

  const clusterMap = new Map<string, Set<string>>();
  for (const turn of turns) {
    const bucket = clusterMap.get(turn.cluster_id) ?? new Set<string>();
    bucket.add(turn.turn_id);
    clusterMap.set(turn.cluster_id, bucket);
  }
  const clusters = [...clusterMap.entries()].map(([clusterId, turnIds]) => ({
    cluster_id: clusterId,
    turn_ids: [...turnIds],
    confidence: null
  }));
  const speaker_map = [...clusterMap.keys()].map((clusterId) => {
    const meta = state.cluster_binding_meta[clusterId];
    const metaName = valueAsString(meta?.participant_name);
    const bound = state.bindings[clusterId] ?? (metaName || null);
    const mapSource: "manual" | "enroll" | "name_extract" | "unknown" =
      meta?.source === "manual_map"
        ? "manual"
        : meta?.source === "enrollment_match"
          ? "enroll"
          : meta?.source === "name_extract"
            ? "name_extract"
            : "unknown";
    return {
      cluster_id: clusterId,
      person_id: bound,
      display_name: bound,
      source: mapSource
    };
  });

  return mergeSpeakerLogs(
    existing,
    {
      source,
      turns,
      clusters,
      speaker_map,
      updated_at: nowIso
    }
  );
}

// ── Edge speaker logs for finalization ───────────────────────────────

export function buildEdgeSpeakerLogsForFinalize(
  nowIso: string,
  existing: SpeakerLogs,
  state: SessionState
): SpeakerLogs {
  const base = existing.source === "edge" ? existing : emptySpeakerLogs(nowIso);
  const clusterIds = new Set<string>();
  for (const item of base.clusters) {
    clusterIds.add(item.cluster_id);
  }
  for (const item of base.turns) {
    clusterIds.add(item.cluster_id);
  }

  const mapByCluster = new Map(
    (Array.isArray(base.speaker_map) ? base.speaker_map : []).map((item) => [item.cluster_id, item])
  );
  for (const clusterId of clusterIds) {
    const meta = state.cluster_binding_meta[clusterId];
    const metaName = valueAsString(meta?.participant_name);
    const mapName = valueAsString(mapByCluster.get(clusterId)?.display_name ?? mapByCluster.get(clusterId)?.person_id);
    const bound = state.bindings[clusterId] ?? (metaName || mapName || null);
    const source: "manual" | "enroll" | "name_extract" | "unknown" =
      meta?.source === "manual_map"
        ? "manual"
        : meta?.source === "enrollment_match"
          ? "enroll"
          : meta?.source === "name_extract"
            ? "name_extract"
            : (mapByCluster.get(clusterId)?.source ?? "unknown");
    mapByCluster.set(clusterId, {
      cluster_id: clusterId,
      person_id: bound,
      display_name: bound,
      source
    });
  }

  return {
    ...base,
    source: "edge",
    speaker_map: [...mapByCluster.values()],
    updated_at: nowIso
  };
}

// ── Mixed capture state derivation ──────────────────────────────────

export function deriveMixedCaptureState(
  captureByStream: Record<StreamRole, CaptureState>
): CaptureState["capture_state"] {
  const teacher = captureByStream.teacher.capture_state;
  const students = captureByStream.students.capture_state;
  if (teacher === "recovering" || students === "recovering") return "recovering";
  if (teacher === "running" || students === "running") return "running";
  if (teacher === "failed" || students === "failed") return "failed";
  return "idle";
}
