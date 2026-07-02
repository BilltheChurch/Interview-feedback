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
import type { GlobalClusterResult, CachedEmbedding } from "./providers/types";

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
  /**
   * Session config subset — carries the interviewer's configured name so the
   * teacher (interviewer) stream can be labeled in the report transcript
   * instead of collapsing to "Unknown". Optional because live/state views and
   * older callers may omit it; the label then falls back to "Interviewer".
   */
  config?: Record<string, unknown>;
}

/**
 * Resolve the interviewer's display name for teacher-stream utterances in the
 * report transcript. The teacher stream is ALWAYS the interviewer, so it must
 * never render as "Unknown". Priority mirrors resolveTeacherIdentity (used by
 * the realtime path) so live captions and the finalized report stay consistent:
 *   1. config.teams_interviewer_name
 *   2. config.interviewer_name
 *   3. "Interviewer" (constant fallback — never null, never the internal
 *      "teacher" sentinel).
 */
export function resolveInterviewerDisplayName(state: ReconcileSessionState): string {
  const config = state.config ?? {};
  const teamsName = config.teams_interviewer_name;
  if (typeof teamsName === "string" && teamsName.trim()) return teamsName.trim();
  const interviewerName = config.interviewer_name;
  if (typeof interviewerName === "string" && interviewerName.trim()) return interviewerName.trim();
  return "Interviewer";
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

/**
 * Split a single utterance into multiple segments based on edge diarization turns.
 * When multiple distinct speakers overlap a single ASR utterance, we create separate
 * segments for each speaker with proportionally split text.
 *
 * Returns empty array if no split is needed (single or no speaker detected).
 */
export function splitByEdgeSpeakers(
  startMs: number,
  endMs: number,
  edgeTurns: Array<{ start_ms: number; end_ms: number; cluster_id: string }>
): Array<{ start_ms: number; end_ms: number; cluster_id: string; fraction: number }> {
  // Find overlapping turns, clamped to utterance boundaries
  const overlapping: Array<{ start_ms: number; end_ms: number; cluster_id: string }> = [];
  for (const turn of edgeTurns) {
    const oStart = Math.max(startMs, turn.start_ms);
    const oEnd = Math.min(endMs, turn.end_ms);
    if (oEnd > oStart) {
      overlapping.push({ start_ms: oStart, end_ms: oEnd, cluster_id: turn.cluster_id });
    }
  }
  if (overlapping.length === 0) return [];

  // Merge consecutive turns with same cluster_id into contiguous segments
  const segments: Array<{ start_ms: number; end_ms: number; cluster_id: string }> = [];
  for (const turn of overlapping) {
    const last = segments[segments.length - 1];
    if (last && last.cluster_id === turn.cluster_id) {
      last.end_ms = turn.end_ms;
    } else {
      segments.push({ ...turn });
    }
  }

  // Only split if there are multiple distinct speakers
  const uniqueClusters = new Set(segments.map((s) => s.cluster_id));
  if (uniqueClusters.size <= 1) return [];

  // Compute time fraction for proportional text splitting
  const totalDuration = segments.reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
  return segments.map((s) => ({
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    cluster_id: s.cluster_id,
    fraction: totalDuration > 0 ? (s.end_ms - s.start_ms) / totalDuration : 0
  }));
}

function valueAsStr(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/** Simple Levenshtein distance for short-string name matching. */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

/** Match an extracted name to the closest roster name. Returns the roster name or null. */
function matchToRoster(name: string, roster: string[]): string | null {
  if (!name || roster.length === 0) return null;
  const lower = name.toLowerCase().trim();
  // Exact match
  for (const r of roster) {
    if (r.toLowerCase() === lower) return r;
  }
  // Substring containment (e.g., roster "Tina" contained in "go by Tina")
  for (const r of roster) {
    if (lower.includes(r.toLowerCase()) || r.toLowerCase().includes(lower)) {
      return r;
    }
  }
  // Levenshtein ≤ 2
  let bestRoster: string | null = null;
  let bestDist = 3;
  for (const r of roster) {
    const dist = levenshteinDistance(lower, r.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestRoster = r;
    }
  }
  return bestRoster;
}

/**
 * Determine the sole interviewee name in a 1v1 interview, or null if the setup
 * is not an unambiguous 1v1. Preference order:
 *   1. Explicit roster with exactly one candidate name.
 *   2. No roster, but the resolved students-stream utterances name exactly one
 *      distinct person (all other students utterances being unresolved).
 * Any ambiguity (0 or ≥2 candidates) → null (do not auto-bind).
 */
function resolveSoleRosterCandidate(
  roster: string[],
  transcript: Array<{ stream_role: string; speaker_name?: string | null }>
): string | null {
  const cleanRoster = roster.map((r) => r.trim()).filter(Boolean);
  if (cleanRoster.length === 1) return cleanRoster[0];
  if (cleanRoster.length > 1) return null; // known group interview → never auto-bind

  // No roster: infer from resolved student speaker names.
  const resolvedNames = new Set<string>();
  for (const u of transcript) {
    if (u.stream_role !== "students") continue;
    const name = (u.speaker_name ?? "").trim();
    if (name) resolvedNames.add(name);
  }
  if (resolvedNames.size === 1) return [...resolvedNames][0];
  return null;
}

/**
 * Merge overlapping edge turns with the same cluster_id into non-overlapping segments.
 * This deduplicates the ~5x redundancy from overlapping pyannote windows (10s window, 2s hop).
 */
export function mergeOverlappingTurns(
  turns: Array<{ start_ms: number; end_ms: number; cluster_id: string }>
): Array<{ start_ms: number; end_ms: number; cluster_id: string }> {
  // Group by cluster_id
  const groups = new Map<string, Array<{ start_ms: number; end_ms: number }>>();
  for (const t of turns) {
    let arr = groups.get(t.cluster_id);
    if (!arr) { arr = []; groups.set(t.cluster_id, arr); }
    arr.push({ start_ms: t.start_ms, end_ms: t.end_ms });
  }

  const result: Array<{ start_ms: number; end_ms: number; cluster_id: string }> = [];
  for (const [clusterId, ranges] of groups) {
    ranges.sort((a, b) => a.start_ms - b.start_ms);
    let current = { ...ranges[0] };
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start_ms <= current.end_ms) {
        // Overlapping or adjacent — extend
        current.end_ms = Math.max(current.end_ms, ranges[i].end_ms);
      } else {
        result.push({ ...current, cluster_id: clusterId });
        current = { ...ranges[i] };
      }
    }
    result.push({ ...current, cluster_id: clusterId });
  }

  return result.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}

/**
 * Resolve a speaker name from global clustering by finding the best overlapping
 * segment in the cluster result. Returns the roster-mapped name for the cluster.
 *
 * This is Priority 2 in the resolution hierarchy (after manual binding).
 */
export function resolveFromGlobalClusters(
  startMs: number,
  endMs: number,
  clusterResult: GlobalClusterResult,
  clusterRosterMapping: Map<string, string>,
  embeddings: CachedEmbedding[]
): { speaker_name: string | null; decision: "auto" | "confirm" } | null {
  // Find the embedding segment with maximum time overlap
  let bestSegmentId: string | null = null;
  let bestOverlap = 0;
  for (const emb of embeddings) {
    const overlap = Math.min(endMs, emb.end_ms) - Math.max(startMs, emb.start_ms);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSegmentId = emb.segment_id;
    }
  }
  if (!bestSegmentId || bestOverlap <= 0) return null;

  // Find which cluster this segment belongs to
  for (const [clusterId, segmentIds] of clusterResult.clusters) {
    if (segmentIds.includes(bestSegmentId)) {
      const rosterName = clusterRosterMapping.get(clusterId);
      if (rosterName && rosterName !== clusterId) {
        // Mapped to a real roster name via enrollment embedding
        return { speaker_name: rosterName, decision: "auto" };
      }
      // Cluster exists but no roster mapping — return the cluster ID
      // so downstream can try name extraction on this cluster
      return { speaker_name: rosterName ?? null, decision: "confirm" };
    }
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
 * B3: cloud (Speechmatics) diarization has no edge speaker-logs. Derive per-utterance
 * turns from each student utterance's speaker-event cluster_id (the S1/S2… diarization
 * label) so self-introduction name extraction can bind S-labels to roster names — the
 * same machinery the edge path uses, just over the cloud label space.
 */
export function buildCloudTurnsFromEvents(
  utterances: ReconcileUtterance[],
  eventByUtterance: Map<string, ReconcileSpeakerEvent>
): Array<{ start_ms: number; end_ms: number; cluster_id: string }> {
  const turns: Array<{ start_ms: number; end_ms: number; cluster_id: string }> = [];
  for (const item of utterances) {
    if (item.stream_role !== "students") continue;
    const clusterId = valueAsStr(eventByUtterance.get(item.utterance_id)?.cluster_id ?? null);
    if (!clusterId) continue;
    turns.push({ start_ms: item.start_ms, end_ms: item.end_ms, cluster_id: clusterId });
  }
  return turns.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}

/**
 * B3: the Speechmatics realtime path emits word-level utterances, so a self-introduction
 * ("Hi, I'm Tina") is split across several utterance records. Merge each S-label's student
 * utterances into one concatenated synthetic utterance (keeping a real utterance_id from
 * the group so its speaker event — hence S-label — still resolves) before name extraction,
 * so multi-word patterns can match.
 */
export function mergeStudentUtterancesBySLabel(
  utterances: ReconcileUtterance[],
  eventByUtterance: Map<string, ReconcileSpeakerEvent>
): ReconcileUtterance[] {
  const groups = new Map<string, { repId: string; texts: string[]; start: number; end: number }>();
  for (const item of utterances) {
    if (item.stream_role !== "students") continue;
    const sLabel = valueAsStr(eventByUtterance.get(item.utterance_id)?.cluster_id ?? null);
    if (!sLabel) continue;
    const g = groups.get(sLabel);
    if (!g) {
      groups.set(sLabel, { repId: item.utterance_id, texts: [item.text], start: item.start_ms, end: item.end_ms });
    } else {
      g.texts.push(item.text);
      g.start = Math.min(g.start, item.start_ms);
      g.end = Math.max(g.end, item.end_ms);
    }
  }
  const merged: ReconcileUtterance[] = [];
  for (const [, g] of groups) {
    merged.push({
      utterance_id: g.repId,
      stream_role: "students",
      text: g.texts.join(" ").replace(/\s+/g, " ").trim(),
      start_ms: g.start,
      end_ms: g.end,
      duration_ms: Math.max(0, g.end - g.start),
    });
  }
  return merged;
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
  /** Participant names from session config for roster matching.
   *  Flattened [name, ...aliases] — kept for backward compatibility; matching still
   *  runs against every alias. */
  roster?: string[];
  /** R6-roster: the STRUCTURED roster (primary name + aliases per entry). Enables
   *  (a) alias hits displaying the PRIMARY name instead of the alias string, and
   *  (b) the 1v1 sole-candidate decision counting primary names only (aliases would
   *  otherwise make a 1v1 look like a group). Optional — omitted keeps old behavior. */
  rosterEntries?: Array<{ name: string; aliases?: string[] }>;
  /** Optional seq cutoff per stream role (used by finalize to freeze at a point). */
  seqCutoff?: Record<string, number>;
  /** Global clustering result from embedding-based speaker identification. */
  globalClusterResult?: GlobalClusterResult | null;
  /** Mapping from global cluster IDs to roster names. */
  clusterRosterMapping?: Map<string, string> | null;
  /** Cached embeddings used for time-overlap matching. */
  cachedEmbeddings?: CachedEmbedding[];
}): TranscriptItem[] {
  const { utterances, events, speakerLogs, state, diarizationBackend } = options;
  const roster = options.roster ?? [];

  // R6-roster: alias → primary-name map + primary-name list from the structured roster.
  // An alias hit must display the primary roster name; the sole-candidate rule must count
  // primary names only. Both stay no-ops when rosterEntries is not provided.
  const rosterEntries = options.rosterEntries ?? [];
  const aliasToPrimary = new Map<string, string>();
  const rosterPrimaryNames: string[] = [];
  for (const entry of rosterEntries) {
    const primary = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!primary) continue;
    rosterPrimaryNames.push(primary);
    for (const alias of entry.aliases ?? []) {
      const trimmed = typeof alias === "string" ? alias.trim() : "";
      if (trimmed) aliasToPrimary.set(trimmed.toLowerCase(), primary);
    }
  }
  const soleRosterPrimary = rosterPrimaryNames.length === 1 ? rosterPrimaryNames[0] : null;
  const globalClusters = options.globalClusterResult ?? null;
  const clusterMapping = options.clusterRosterMapping ?? null;
  const embeddings = options.cachedEmbeddings ?? [];

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

  // ── Name extraction: map diarization cluster IDs to roster names ──
  // Extract self-introduction names from utterance text, find which diarization cluster
  // was speaking at each name's position, roster-match the names, and populate
  // speakerMapByCluster. Edge uses pyannote turns; cloud (B3) uses Speechmatics S-labels
  // derived from speaker events — the same machinery over either label space.
  const introTurns = diarizationBackend === "edge"
    ? edgeTurns
    : buildCloudTurnsFromEvents(utterances, eventByUtterance);
  if (introTurns.length > 0) {
    // Build extended roster from all available name sources
    const extendedRosterSet = new Set<string>(roster.map((r) => r));
    for (const [, sm] of speakerMapByCluster) {
      if (sm.display_name) extendedRosterSet.add(sm.display_name);
    }
    for (const v of Object.values(state.bindings)) {
      if (v) extendedRosterSet.add(v);
    }
    for (const v of Object.values(state.cluster_binding_meta)) {
      if (v.participant_name) extendedRosterSet.add(v.participant_name);
    }
    const extendedRoster = [...extendedRosterSet];

    // Name extraction patterns — use global flag to find ALL matches per utterance
    // Note: Capture groups must NOT be too greedy — stop before common English words
    // like "and", "I", "in", "from" etc. to avoid capturing "Daisy and I am now..." as a name.
    // Preferred-name patterns (isPreferred=true): the speaker explicitly asks to be called
    // a nickname — these beat formal-name patterns for the same cluster.
    // Formal-name patterns (isPreferred=false): "my name is X", "I'm X", etc.
    const namePatternEntries: Array<{ pattern: RegExp; isPreferred: boolean }> = [
      { pattern: /\b[Mm]y name is\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,2})/g, isPreferred: false },
      { pattern: /\b(?:[Uu]sually\s+)?[Gg]o(?:es)?\s+by\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,1})/g, isPreferred: true },
      { pattern: /\b(?:(?:[Yy]ou\s+)?[Cc]an\s+)?(?:[Cc]all|[Jj]ust\s+call)\s+me\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,1})/g, isPreferred: true },
      { pattern: /\bI'm\s+([A-Z][a-z]{1,20})\b/g, isPreferred: false },
      { pattern: /\bI am\s+([A-Z][a-z]{1,20})\b/g, isPreferred: false },
      { pattern: /\b[Tt]his is\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,1})\b/g, isPreferred: false },
      { pattern: /我(?:的名字)?(?:叫|是)\s*([\u4e00-\u9fff]{2,4})/g, isPreferred: false },
      // Fallback: "please call me [name]" with lowercase (ASR may not capitalize)
      { pattern: /\bplease\s+call\s+me\s+([A-Za-z]{2,20})/gi, isPreferred: true },
      // Chinese preferred-name patterns: 请叫我X / 可以叫我X / 叫我X就好|就行 / 我喜欢(别人)叫我X
      { pattern: /请叫我\s*([\u4e00-\u9fff]{2,4}|[A-Za-z]{2,20})/g, isPreferred: true },
      // Matches {大家|你|…}可以叫我X via the optional leading 大家 plus the unanchored 可以叫我
      // substring (e.g. "你可以叫我小李" matches at 可以叫我小李) — broad coverage is intended.
      { pattern: /(?:大家\s*)?可以叫我\s*([\u4e00-\u9fff]{2,4}|[A-Za-z]{2,20})/g, isPreferred: true },
      { pattern: /叫我\s*([\u4e00-\u9fff]{2,4}|[A-Za-z]{2,20})\s*(?:就好|就行)/g, isPreferred: true },
      // ASR interview context — preferred-name false-positive risk accepted
      { pattern: /我喜欢(?:别人)?叫我\s*([\u4e00-\u9fff]{2,4}|[A-Za-z]{2,20})/g, isPreferred: true },
    ];

    // Phase 1: Extract ALL name anchors from each utterance
    interface NameAnchor {
      rawName: string;
      rosterName: string | null;
      charIndex: number;
      timeMs: number;
      edgeClusterId: string | null;
      /** True when the speaker explicitly asked to be called this name ("call me X", "go by X"). */
      isPreferred: boolean;
    }

    // Cloud emits word-level utterances, so a self-intro ("I'm Tina") spans several
    // records. Merge each S-label's utterances before matching so the phrase reunites.
    // Edge keeps per-utterance granularity (its turns drive the time-search).
    const introUtterances = diarizationBackend === "cloud"
      ? mergeStudentUtterancesBySLabel(utterances, eventByUtterance)
      : utterances;

    for (const item of introUtterances) {
      if (item.stream_role !== "students") continue;
      const text = item.text;
      const anchors: NameAnchor[] = [];
      // Cloud (Speechmatics): each utterance maps 1:1 to its own S-label (on the speaker
      // event), so a name spoken in this utterance belongs to that label directly — no
      // time-search needed (and time interpolation at the utterance boundary is unreliable).
      const cloudClusterId = diarizationBackend === "cloud"
        ? valueAsStr(eventByUtterance.get(item.utterance_id)?.cluster_id ?? null)
        : null;

      for (const { pattern, isPreferred } of namePatternEntries) {
        pattern.lastIndex = 0; // Reset for global regex
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          const rawName = match[1]?.replace(/[.,;!?]+$/, "").trim();
          if (!rawName || rawName.length < 2 || rawName.length > 40) continue;

          const charFraction = match.index / Math.max(1, text.length);
          const timeMs = item.start_ms + charFraction * (item.end_ms - item.start_ms);
          // R6-roster: an alias hit ("Kenny Tan" listed as Tina's alias) normalizes to the
          // PRIMARY roster name so the transcript never displays the alias string itself.
          const rosterHit = matchToRoster(rawName, extendedRoster);
          const rosterName = rosterHit
            ? aliasToPrimary.get(rosterHit.toLowerCase()) ?? rosterHit
            : null;

          // Find the edge turn active at this time (±5s tolerance)
          let bestTurn: typeof introTurns[0] | null = null;
          let bestOverlap = 0;
          const searchStart = timeMs - 5000;
          const searchEnd = timeMs + 5000;
          for (const turn of introTurns) {
            // A turn that actually contains the name's timestamp wins outright — this
            // disambiguates short adjacent turns (cloud S-labels) where the ±5s window
            // would otherwise tie across neighbours.
            if (timeMs >= turn.start_ms && timeMs <= turn.end_ms) {
              bestTurn = turn;
              break;
            }
            const overlap = Math.min(searchEnd, turn.end_ms) - Math.max(searchStart, turn.start_ms);
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              bestTurn = turn;
            }
          }

          anchors.push({
            rawName,
            rosterName,
            charIndex: match.index,
            timeMs,
            edgeClusterId: cloudClusterId ?? bestTurn?.cluster_id ?? null,
            isPreferred,
          });
        }
      }

      if (anchors.length === 0) continue;
      anchors.sort((a, b) => a.charIndex - b.charIndex);

      // Phase 2: Propagate roster names to unmatched anchors within the same utterance.
      // Two cases:
      // (a) Single speaker intro: "my name is Kenny Tan, go by Tina" → 1 roster match → apply to all
      // (b) Multi-speaker utterance: "my name is Daisy... my name is Stephanie" → 2+ distinct
      //     roster matches → each anchor keeps its own match; unmatched gets nearest neighbor.
      // NOTE: preferred-name anchors (isPreferred=true, e.g. "call me X") are intentionally
      // excluded from roster propagation — they carry explicit intent and must not be overwritten
      // by a formal name's roster match for the same cluster.
      const distinctRosterNames = new Set(anchors.filter(a => a.rosterName).map(a => a.rosterName));
      if (distinctRosterNames.size === 1) {
        // Single speaker — apply the one roster name to all unmatched NON-preferred anchors.
        // Preferred anchors already carry the speaker's desired display name.
        const name = [...distinctRosterNames][0]!;
        for (const anchor of anchors) {
          if (!anchor.rosterName && !anchor.isPreferred) anchor.rosterName = name;
        }
      } else if (distinctRosterNames.size > 1) {
        // Multiple speakers — assign unmatched non-preferred to nearest roster-matched anchor by char position
        for (const anchor of anchors) {
          if (anchor.rosterName || anchor.isPreferred) continue;
          let nearest: NameAnchor | null = null;
          let minDist = Infinity;
          for (const other of anchors) {
            if (!other.rosterName) continue;
            const dist = Math.abs(anchor.charIndex - other.charIndex);
            if (dist < minDist) { minDist = dist; nearest = other; }
          }
          if (nearest) anchor.rosterName = nearest.rosterName;
        }
      }

      // Phase 3: Populate speakerMapByCluster with names, giving preferred-name anchors
      // priority over formal-name anchors for the same cluster.
      // Algorithm: iterate anchors in charIndex order; a preferred anchor always overwrites
      // a previous formal anchor for the same cluster, and a formal anchor never overwrites
      // a previously committed preferred anchor.
      // Two preferred anchors for the same cluster: the later one (higher charIndex) wins
      // (e.g. "go by Tim... actually call me Tom" → Tom). Only formal anchors are blocked here.
      const committedPreferred = new Set<string>(); // cluster IDs already bound by a preferred anchor
      for (const anchor of anchors) {
        // R6-roster: 1v1 sole-candidate roster priority. A FORMAL self-intro that failed
        // roster matching ("my name is Kenny Tan" vs roster ["Tina"]) binds to the sole
        // roster name: only one person can own students utterances in an unambiguous 1v1,
        // so the mis-binding risk is zero — and this stops the same speaker splitting into
        // two persons (name_extract "Kenny Tan" + sole-candidate fallback "Tina").
        // Preferred anchors ("call me X") still win — explicit intent beats the roster.
        // Group interviews (≥2 primary names) keep the raw-name fallback (mis-binding a
        // real name onto the wrong roster entry is worse than showing the real name).
        const soleFallback = !anchor.isPreferred && soleRosterPrimary ? soleRosterPrimary : null;
        const name = anchor.rosterName || soleFallback || anchor.rawName;
        if (!anchor.edgeClusterId || !name) continue;
        // Never overwrite a preferred-name binding with a formal-name one
        if (!anchor.isPreferred && committedPreferred.has(anchor.edgeClusterId)) continue;
        speakerMapByCluster.set(anchor.edgeClusterId, {
          cluster_id: anchor.edgeClusterId,
          person_id: name,
          display_name: name,
          source: "name_extract"
        });
        if (anchor.isPreferred) committedPreferred.add(anchor.edgeClusterId);
      }
    }

    // Add name-based entries so resolveStudentBinding can look up by name as cluster_id
    // (needed because consolidated edge turns use names as cluster_ids)
    const uniqueNames = new Set<string>();
    for (const [, sm] of speakerMapByCluster) {
      if (sm.display_name) uniqueNames.add(sm.display_name);
    }
    for (const name of uniqueNames) {
      if (!speakerMapByCluster.has(name)) {
        speakerMapByCluster.set(name, {
          cluster_id: name,
          person_id: name,
          display_name: name,
          source: "name_extract"
        });
      }
    }
  }

  // ── Build consolidated edge turns ──
  // Replace per-window cluster IDs with resolved speaker names, then merge overlapping
  // turns from different windows into non-overlapping segments. This:
  // 1. Prevents 380 per-window clusters from becoming 164 separate speakers
  // 2. Deduplicates the ~5x redundancy from overlapping windows
  // 3. Produces clean segments for splitByEdgeSpeakers
  const consolidatedEdgeTurns: typeof edgeTurns = diarizationBackend === "edge"
    ? mergeOverlappingTurns(
        edgeTurns.map((turn) => {
          const sm = speakerMapByCluster.get(turn.cluster_id);
          const name = sm?.display_name;
          return name
            ? { start_ms: turn.start_ms, end_ms: turn.end_ms, cluster_id: name }
            : { start_ms: turn.start_ms, end_ms: turn.end_ms, cluster_id: "_unknown" };
        })
      )
    : edgeTurns;

  const result: TranscriptItem[] = [];

  for (const item of utterances) {
    const event =
      item.stream_role === "teacher"
        ? teacherEventByUtterance.get(item.utterance_id)
        : eventByUtterance.get(item.utterance_id);

    // For student utterances with edge diarization: split at speaker boundaries.
    // Uses consolidated edge turns where cluster_id = resolved speaker name,
    // so same-person segments from different windows merge naturally.
    if (item.stream_role === "students" && diarizationBackend === "edge") {
      const splits = splitByEdgeSpeakers(item.start_ms, item.end_ms, consolidatedEdgeTurns);
      if (splits.length > 1) {
        // Post-split name propagation: _unknown segments between named segments
        // should inherit the nearest named segment's speaker identity.
        // This handles cases like: [Tina] [_unknown] [Tina] → all become Tina.
        const resolvedClusterIds = splits.map(s => s.cluster_id);
        for (let si = 0; si < resolvedClusterIds.length; si++) {
          if (resolvedClusterIds[si] !== "_unknown") continue;
          // Find nearest non-_unknown segment
          let nearest: string | null = null;
          let minDist = Infinity;
          for (let sj = 0; sj < resolvedClusterIds.length; sj++) {
            if (resolvedClusterIds[sj] === "_unknown") continue;
            const dist = Math.abs(si - sj);
            if (dist < minDist) { minDist = dist; nearest = resolvedClusterIds[sj]; }
          }
          if (nearest) resolvedClusterIds[si] = nearest;
        }

        // Split text proportionally by time fraction
        const words = item.text.split(/\s+/).filter(Boolean);
        let wordIdx = 0;
        for (let si = 0; si < splits.length; si++) {
          const seg = splits[si];
          const clusterId = resolvedClusterIds[si];
          const wordCount = si < splits.length - 1
            ? Math.max(1, Math.round(seg.fraction * words.length))
            : Math.max(1, words.length - wordIdx); // last segment gets remainder
          const segWords = words.slice(wordIdx, wordIdx + wordCount);
          wordIdx += segWords.length;
          const segText = segWords.join(" ");
          if (!segText) continue;
          const reconciled = resolveStudentBinding(
            state, clusterId, null, null, speakerMapByCluster
          );
          result.push({
            utterance_id: `${item.utterance_id}-s${si}`,
            stream_role: item.stream_role,
            cluster_id: clusterId,
            speaker_name: reconciled.speaker_name,
            decision: reconciled.decision,
            text: segText,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            duration_ms: seg.end_ms - seg.start_ms
          });
        }
        continue; // Skip single-speaker fallback
      }
    }

    // Single-speaker fallback (cloud diarization, teacher stream, or single-cluster edge)
    const inferredStudentsCluster =
      item.stream_role === "students" && diarizationBackend === "edge"
        ? inferClusterFromEdgeTurns(consolidatedEdgeTurns, item.start_ms, item.end_ms)
        : null;
    // When diarizationBackend="edge", prefer edge-inferred cluster for students.
    // Cloud ASR cluster_ids (c1, c3, etc.) are meaningless in edge mode and create phantom speakers.
    // But when edge returns "_unknown" (late-session utterances without name-extraction coverage),
    // fall back to cloud ASR event's cluster_id binding — use the RESOLVED NAME, not the raw
    // cloud cluster ID, to avoid reintroducing phantom speakers.
    let clusterId: string | null;
    if (item.stream_role === "students" && diarizationBackend === "edge") {
      if (inferredStudentsCluster && inferredStudentsCluster !== "_unknown") {
        clusterId = inferredStudentsCluster;
      } else {
        // Edge couldn't identify speaker — try cloud ASR event binding as fallback
        const fallbackCluster = event?.cluster_id ?? null;
        if (fallbackCluster) {
          const fallbackResolved = resolveStudentBinding(state, fallbackCluster, null, null, speakerMapByCluster);
          clusterId = fallbackResolved.speaker_name ?? null;
        } else {
          clusterId = null;
        }
      }
    } else {
      clusterId = event?.cluster_id ?? (item.stream_role === "students" ? inferredStudentsCluster : "teacher");
    }
    // Resolution priority:
    // 1. Manual binding (checked inside resolveStudentBinding)
    // 2. Global cluster + enrollment match (NEW — embedding-based)
    // 3. Global cluster + name extraction match (NEW)
    // 4. Edge turn + enrollment match (existing)
    // 5. Edge turn + name extraction (existing)
    // 6. Cloud ASR event fallback (existing)
    // 7. Unresolved → _unknown
    let reconciled: { speaker_name: string | null; decision: "auto" | "confirm" | "unknown" | null };
    if (item.stream_role === "students") {
      // First try manual binding (Priority 1) via resolveStudentBinding
      const bindingResult = resolveStudentBinding(
        state, clusterId ?? null, null, null, speakerMapByCluster
      );
      if (bindingResult.speaker_name && bindingResult.decision === "auto") {
        // Manual/locked binding — highest priority, use it
        reconciled = bindingResult;
      } else if (globalClusters && clusterMapping && embeddings.length > 0) {
        // Try global cluster resolution (Priority 2)
        const clusterResolved = resolveFromGlobalClusters(
          item.start_ms, item.end_ms, globalClusters, clusterMapping, embeddings
        );
        if (clusterResolved?.speaker_name && !clusterResolved.speaker_name.startsWith("spk_")) {
          reconciled = clusterResolved;
        } else {
          // Fall back to existing edge/name-extraction resolution
          reconciled = resolveStudentBinding(
            state, clusterId ?? null, event?.speaker_name ?? null,
            event?.decision ?? null, speakerMapByCluster
          );
        }
      } else {
        reconciled = resolveStudentBinding(
          state, clusterId ?? null, event?.speaker_name ?? null,
          event?.decision ?? null, speakerMapByCluster
        );
      }
    } else {
      // Teacher stream = the interviewer, ALWAYS. It must never render as
      // "Unknown" (which is what a null speaker_name produces in the desktop
      // TranscriptSection). Prefer a resolved event name, but treat the internal
      // "teacher" sentinel as unresolved and fall back to the configured
      // interviewer name (→ "Interviewer" as a last resort). This keeps the
      // report transcript consistent with the realtime captions (R-A) and feeds
      // the LLM synthesizer a transcript where the interviewer's turns are
      // clearly attributed. Note: per_person/studentStats exclusion is keyed by
      // stream_role ("teacher") in finalize_v2.speakerKey(), NOT by this name,
      // so labeling the interviewer here never leaks them into student scoring.
      const eventName = event?.speaker_name ?? null;
      const resolvedTeacherName =
        eventName && eventName !== "teacher" ? eventName : resolveInterviewerDisplayName(state);
      reconciled = {
        speaker_name: resolvedTeacherName,
        decision: event?.decision ?? null
      };
    }
    result.push({
      utterance_id: item.utterance_id,
      stream_role: item.stream_role,
      cluster_id: clusterId ?? null,
      speaker_name: reconciled.speaker_name,
      decision: reconciled.decision,
      text: item.text,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
      duration_ms: item.duration_ms
    });
  }

  // ── 1v1 fallback: bind unresolved students to the sole roster candidate ──
  // In a 1-on-1 interview there is exactly one interviewee. Any students-stream
  // utterance that survived resolution unattributed can only belong to that one
  // person, so leaving it null (→ front-end "Unknown") is strictly wrong. We only
  // apply this in the unambiguous single-candidate case to avoid mis-attributing
  // group interviews.
  // R6-roster: prefer the structured roster's sole PRIMARY name — a 1v1 entry with
  // aliases flattens to >1 strings and would wrongly disable this fallback otherwise.
  const soleCandidate = soleRosterPrimary ?? resolveSoleRosterCandidate(roster, result);
  if (soleCandidate) {
    for (const u of result) {
      if (u.stream_role === "students" && !u.speaker_name) {
        u.speaker_name = soleCandidate;
        u.decision = "confirm";
      }
    }
  }

  // ── Post-filter: remove redundant ASR consolidation artifacts ──
  // Realtime ASR sometimes produces very long "final" utterances (200+ seconds)
  // alongside shorter sentence-level outputs for the same audio. When the shorter
  // ones are properly attributed to speakers, the long unresolved ones are noise.
  // Remove any unresolved utterance whose time range is >80% covered by resolved ones.
  const sorted = result.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const resolved = sorted.filter((u) => u.speaker_name);
  if (resolved.length > 0) {
    return sorted.filter((u) => {
      if (u.speaker_name) return true; // Keep resolved utterances
      const dur = u.end_ms - u.start_ms;
      if (dur <= 0) return true;
      // Calculate how much of this utterance's time is covered by resolved ones
      let coveredMs = 0;
      for (const r of resolved) {
        const oStart = Math.max(u.start_ms, r.start_ms);
        const oEnd = Math.min(u.end_ms, r.end_ms);
        if (oEnd > oStart) coveredMs += oEnd - oStart;
      }
      // If >80% covered by resolved utterances, it's a consolidation artifact
      return coveredMs / dur < 0.8;
    });
  }
  return sorted;
}
