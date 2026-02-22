import type { SpeakerCluster, SpeakerLogs, SpeakerMapItem, SpeakerTurn, StreamRole } from "./types_v2";

interface SpeakerLogsPayload {
  source?: string;
  window?: unknown;
  start_end_ms?: unknown;
  turns?: unknown;
  clusters?: unknown;
  speaker_map?: unknown;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseStreamRole(value: unknown): StreamRole {
  const raw = asNonEmptyString(value);
  if (raw === "teacher" || raw === "students" || raw === "mixed") {
    return raw;
  }
  if (raw) {
    console.warn(`[speaker-logs] unrecognized stream_role "${raw}", defaulting to "students"`);
  } else {
    console.warn('[speaker-logs] missing stream_role, defaulting to "students"');
  }
  return "students";
}

function parseStartEndMs(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const start = Number(value[0]);
  const end = Number(value[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    throw new Error("speaker-logs.start_end_ms must be [start,end] and ordered");
  }
  return [Math.floor(start), Math.floor(end)];
}

function parseTurns(input: unknown): SpeakerTurn[] {
  if (!Array.isArray(input)) return [];
  const out: SpeakerTurn[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const turnId = asNonEmptyString(obj.turn_id);
    const clusterId = asNonEmptyString(obj.cluster_id);
    const startMs = Number(obj.start_ms);
    const endMs = Number(obj.end_ms);
    if (!turnId || !clusterId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || startMs < 0) {
      continue;
    }
    out.push({
      turn_id: turnId,
      start_ms: Math.floor(startMs),
      end_ms: Math.floor(endMs),
      stream_role: parseStreamRole(obj.stream_role),
      cluster_id: clusterId,
      utterance_id: asNonEmptyString(obj.utterance_id) || null,
    });
  }
  return out;
}

function parseClusters(input: unknown): SpeakerCluster[] {
  if (!Array.isArray(input)) return [];
  const out: SpeakerCluster[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const clusterId = asNonEmptyString(obj.cluster_id);
    const turnIds = Array.isArray(obj.turn_ids)
      ? obj.turn_ids.map((item) => asNonEmptyString(item)).filter(Boolean)
      : [];
    if (!clusterId) continue;
    const confidence = Number(obj.confidence);
    out.push({
      cluster_id: clusterId,
      turn_ids: turnIds,
      confidence: Number.isFinite(confidence) ? confidence : null,
    });
  }
  return out;
}

function parseSpeakerMap(input: unknown): SpeakerMapItem[] {
  if (!Array.isArray(input)) return [];
  const out: SpeakerMapItem[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const clusterId = asNonEmptyString(obj.cluster_id);
    if (!clusterId) continue;
    const sourceRaw = asNonEmptyString(obj.source);
    const source =
      sourceRaw === "manual" || sourceRaw === "enroll" || sourceRaw === "name_extract"
        ? sourceRaw
        : "unknown";
    out.push({
      cluster_id: clusterId,
      person_id: asNonEmptyString(obj.person_id) || null,
      display_name: asNonEmptyString(obj.display_name) || null,
      source,
    });
  }
  return out;
}

export function parseSpeakerLogsPayload(payload: SpeakerLogsPayload, nowIso: string): SpeakerLogs {
  const source = asNonEmptyString(payload.source);
  if (source !== "edge" && source !== "cloud") {
    throw new Error("speaker-logs.source must be edge|cloud");
  }
  const parsed: SpeakerLogs = {
    source,
    window: asNonEmptyString(payload.window) || undefined,
    start_end_ms: parseStartEndMs(payload.start_end_ms),
    turns: parseTurns(payload.turns),
    clusters: parseClusters(payload.clusters),
    speaker_map: parseSpeakerMap(payload.speaker_map),
    updated_at: nowIso,
  };
  return parsed;
}

export function mergeSpeakerLogs(base: SpeakerLogs | null, incoming: SpeakerLogs): SpeakerLogs {
  if (!base) return incoming;

  const turnById = new Map<string, SpeakerTurn>();
  for (const item of base.turns) {
    turnById.set(item.turn_id, item);
  }
  for (const item of incoming.turns) {
    turnById.set(item.turn_id, item);
  }

  const clusterById = new Map<string, SpeakerCluster>();
  for (const item of base.clusters) {
    clusterById.set(item.cluster_id, item);
  }
  for (const item of incoming.clusters) {
    const prev = clusterById.get(item.cluster_id);
    if (!prev) {
      clusterById.set(item.cluster_id, item);
      continue;
    }
    const turnIds = new Set([...prev.turn_ids, ...item.turn_ids]);
    clusterById.set(item.cluster_id, {
      cluster_id: item.cluster_id,
      turn_ids: [...turnIds],
      confidence: item.confidence ?? prev.confidence ?? null,
    });
  }

  const mapByCluster = new Map<string, SpeakerMapItem>();
  for (const item of base.speaker_map) {
    mapByCluster.set(item.cluster_id, item);
  }
  for (const item of incoming.speaker_map) {
    mapByCluster.set(item.cluster_id, item);
  }

  return {
    source: incoming.source,
    window: incoming.window ?? base.window,
    start_end_ms: incoming.start_end_ms ?? base.start_end_ms,
    turns: [...turnById.values()].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms),
    clusters: [...clusterById.values()],
    speaker_map: [...mapByCluster.values()],
    updated_at: incoming.updated_at,
  };
}

export function emptySpeakerLogs(nowIso: string): SpeakerLogs {
  return {
    source: "cloud",
    turns: [],
    clusters: [],
    speaker_map: [],
    updated_at: nowIso,
  };
}
