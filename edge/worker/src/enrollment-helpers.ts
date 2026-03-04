/**
 * enrollment-helpers.ts — Pure functions for enrollment and speaker identity
 * matching during the enrollment workflow.
 *
 * All functions are side-effect-free and take explicit dependencies.
 */

import type {
  SessionState,
  EnrollmentParticipantProgress,
  EnrollmentUnassignedProgress,
  RosterEntry
} from "./config";
import {
  buildDefaultEnrollmentState,
  extractNameFromText,
  levenshteinDistance
} from "./config";

// ── Score normalization ─────────────────────────────────────────────

export function scoreNumber(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return -1;
  }
  return value;
}

// ── Participant progress ────────────────────────────────────────────

export function participantProgressFromProfiles(
  state: SessionState
): Record<string, EnrollmentParticipantProgress> {
  const out: Record<string, EnrollmentParticipantProgress> = {};
  for (const profile of state.participant_profiles ?? []) {
    const key = profile.name.trim().toLowerCase();
    if (!key) continue;
    out[key] = {
      name: profile.name,
      sample_seconds: Number.isFinite(profile.sample_seconds) ? Number(profile.sample_seconds) : 0,
      sample_count: Number.isFinite(profile.sample_count) ? Number(profile.sample_count) : 0,
      status: profile.status === "ready" ? "ready" : "collecting"
    };
  }
  return out;
}

// ── Enrollment mode refresh ─────────────────────────────────────────

export function refreshEnrollmentMode(state: SessionState, nowIso: string): void {
  const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
  const participants = enrollment.participants ?? {};
  const keys = Object.keys(participants);
  const allReady = keys.length > 0 && keys.every((key) => participants[key].status === "ready");
  if (enrollment.mode === "collecting" && allReady) {
    enrollment.mode = "ready";
  }
  enrollment.updated_at = nowIso;
  state.enrollment_state = enrollment;
}

// ── Roster name matching ────────────────────────────────────────────

export function rosterNameByCandidate(
  state: SessionState,
  candidate: string | null
): string | null {
  if (!candidate) return null;
  const normalized = candidate.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return null;
  const roster = state.roster ?? [];
  let fuzzySubstring: string | null = null;
  let fuzzyEdit: string | null = null;
  let bestEditDist = Infinity;
  for (const item of roster) {
    const rosterNorm = item.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!rosterNorm) continue;
    // 1. Exact match — return immediately.
    if (rosterNorm === normalized) {
      return item.name;
    }
    // 2. Substring match (4+ chars).
    if (normalized.length >= 4 && (normalized.includes(rosterNorm) || rosterNorm.includes(normalized))) {
      fuzzySubstring = item.name;
    }
    // 3. Edit-distance match: both names >= 5 chars and distance <= 2.
    if (normalized.length >= 5 && rosterNorm.length >= 5) {
      const dist = levenshteinDistance(normalized, rosterNorm);
      if (dist <= 2 && dist < bestEditDist) {
        bestEditDist = dist;
        fuzzyEdit = item.name;
      }
    }
  }
  // Prefer substring match over edit-distance match.
  return fuzzySubstring ?? fuzzyEdit ?? null;
}

// ── Text-based participant inference ────────────────────────────────

export function inferParticipantFromText(
  state: SessionState,
  asrText: string
): string | null {
  const extracted = extractNameFromText(asrText);
  return rosterNameByCandidate(state, extracted);
}

// ── Unassigned enrollment by cluster ────────────────────────────────

export function updateUnassignedEnrollmentByCluster(
  state: SessionState,
  clusterId: string | null | undefined,
  durationSeconds: number,
  nowIso: string
): void {
  if (!clusterId || durationSeconds <= 0) return;
  const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
  const current = enrollment.unassigned_clusters[clusterId] ?? { sample_seconds: 0, sample_count: 0 };
  current.sample_seconds += durationSeconds;
  current.sample_count += 1;
  enrollment.unassigned_clusters[clusterId] = current;
  enrollment.updated_at = nowIso;
  state.enrollment_state = enrollment;
}
