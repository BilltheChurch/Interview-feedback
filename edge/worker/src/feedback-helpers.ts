/**
 * feedback-helpers.ts — Pure functions for feedback report processing.
 *
 * Contains evidence indexing, claim lookup/validation, quality gates,
 * and stats merging. All functions are side-effect-free.
 */

import type {
  PersonFeedbackItem,
  ResultV2,
  SpeakerStatItem
} from "./types_v2";
import type { TranscriptItem } from "./finalize_v2";
import type { DependencyHealthSnapshot } from "./inference_client";
import type {
  StreamRole,
  SessionState,
  CaptureState,
  QualityMetrics,
  ResolveEvidence,
  RosterEntry
} from "./config";

// ── Evidence index ──────────────────────────────────────────────────

export function buildEvidenceIndex(perPerson: PersonFeedbackItem[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const person of perPerson) {
    for (const dimension of person.dimensions) {
      const refs = new Set<string>();
      const claims = [...dimension.strengths, ...dimension.risks, ...dimension.actions];
      for (const claim of claims) {
        for (const ref of claim.evidence_refs) {
          if (ref) refs.add(ref);
        }
      }
      index[`${person.person_key}:${dimension.dimension}`] = [...refs].slice(0, 12);
    }
  }
  return index;
}

// ── Claim lookup ────────────────────────────────────────────────────

export function findClaimInReport(
  report: ResultV2,
  params: {
    personKey: string;
    dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
    claimType: "strengths" | "risks" | "actions";
    claimId?: string;
  }
): { person: PersonFeedbackItem; claim: PersonFeedbackItem["dimensions"][number]["strengths"][number] } | null {
  const person = report.per_person.find((item) => item.person_key === params.personKey);
  if (!person) return null;
  const dimension = person.dimensions.find((item) => item.dimension === params.dimension);
  if (!dimension) return null;
  const claims = dimension[params.claimType];
  const claim = params.claimId ? claims.find((item) => item.claim_id === params.claimId) : claims[0];
  if (!claim) return null;
  return { person, claim };
}

// ── Claim confidence adjustment ─────────────────────────────────────

export function downWeightClaimConfidenceByEvidence(
  claim: PersonFeedbackItem["dimensions"][number]["strengths"][number],
  evidenceById: Map<string, ResultV2["evidence"][number]>
): void {
  const hasWeakEvidence = claim.evidence_refs.some((ref) => Boolean(evidenceById.get(ref)?.weak));
  const base = Number(claim.confidence || 0.72);
  claim.confidence = hasWeakEvidence ? Math.max(0.35, Math.min(0.95, base - 0.18)) : Math.max(0.35, Math.min(0.95, base));
}

// ── Evidence ref sanitization ───────────────────────────────────────

/** Strip claims with empty or invalid evidence_refs so one bad claim doesn't kill the whole LLM report. */
export function sanitizeClaimEvidenceRefs(
  perPerson: PersonFeedbackItem[],
  evidence: ResultV2["evidence"]
): { sanitized: PersonFeedbackItem[]; strippedCount: number } {
  const evidenceById = new Set(evidence.map((e) => e.evidence_id));
  let strippedCount = 0;
  const sanitized = perPerson.map((person) => ({
    ...person,
    dimensions: person.dimensions.map((dim) => {
      const filterClaims = (claims: typeof dim.strengths) =>
        claims.filter((claim) => {
          const refs = Array.isArray(claim.evidence_refs)
            ? claim.evidence_refs.map((r) => String(r || "").trim()).filter(Boolean)
            : [];
          // Remove refs that don't exist in evidence
          const validRefs = refs.filter((r) => evidenceById.has(r));
          if (validRefs.length === 0) {
            strippedCount++;
            return false;
          }
          claim.evidence_refs = validRefs;
          return true;
        });
      return {
        ...dim,
        strengths: filterClaims(dim.strengths),
        risks: filterClaims(dim.risks),
        actions: filterClaims(dim.actions)
      };
    })
  }));
  return { sanitized, strippedCount };
}

// ── Claim evidence validation ───────────────────────────────────────

export function validateClaimEvidenceRefs(
  report: ResultV2
): { valid: boolean; claimCount: number; invalidCount: number; needsEvidenceCount: number; failures: string[] } {
  const evidenceById = new Map(report.evidence.map((item) => [item.evidence_id, item] as const));
  let claimCount = 0;
  let invalidCount = 0;
  let needsEvidenceCount = 0;
  const failures: string[] = [];
  for (const person of report.per_person) {
    for (const dimension of person.dimensions) {
      const claims = [...dimension.strengths, ...dimension.risks, ...dimension.actions];
      for (const claim of claims) {
        claimCount += 1;
        const refs = Array.isArray(claim.evidence_refs)
          ? claim.evidence_refs.map((item) => String(item || "").trim()).filter(Boolean)
          : [];
        if (refs.length === 0) {
          invalidCount += 1;
          needsEvidenceCount += 1;
          failures.push(`claim ${claim.claim_id} has empty evidence_refs`);
          continue;
        }
        const missing = refs.filter((ref) => !evidenceById.has(ref));
        if (missing.length > 0) {
          invalidCount += 1;
          failures.push(`claim ${claim.claim_id} references unknown evidence ids: ${missing.slice(0, 3).join(",")}`);
          continue;
        }
        downWeightClaimConfidenceByEvidence(claim, evidenceById);
      }
    }
  }
  return {
    valid: invalidCount === 0 && claimCount > 0,
    claimCount,
    invalidCount,
    needsEvidenceCount,
    failures
  };
}

// ── Quality gates ───────────────────────────────────────────────────

export function evaluateFeedbackQualityGates(params: {
  unknownRatio: number;
  ingestP95Ms: number | null;
  claimValidationFailures: string[];
}): { passed: boolean; failures: string[] } {
  const failures = [...params.claimValidationFailures];
  if (!Number.isFinite(params.unknownRatio) || params.unknownRatio > 0.25) {
    failures.push(`students_unknown_ratio gate failed: observed=${params.unknownRatio.toFixed(4)} target<=0.25`);
  }
  if (params.ingestP95Ms === null || !Number.isFinite(params.ingestP95Ms) || params.ingestP95Ms > 3000) {
    failures.push(`students_ingest_to_utterance_p95_ms gate failed: observed=${params.ingestP95Ms ?? "null"} target<=3000`);
  }
  return { passed: failures.length === 0, failures };
}

// ── Stats helpers ───────────────────────────────────────────────────

export function mergeStatsWithRoster(stats: SpeakerStatItem[], state: SessionState): SpeakerStatItem[] {
  const out: SpeakerStatItem[] = [...stats];
  const seen = new Set<string>();
  for (const stat of out) {
    const key = String(stat.speaker_key || "").trim().toLowerCase();
    const name = String(stat.speaker_name || "").trim().toLowerCase();
    if (key) seen.add(key);
    if (name) seen.add(name);
  }
  const roster = Array.isArray(state.roster) ? state.roster : [];
  for (const entry of roster) {
    const name = String(entry?.name || "").trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    out.push({
      speaker_key: name,
      speaker_name: name,
      talk_time_ms: 0,
      talk_time_pct: 0,
      turns: 0,
      silence_ms: 0,
      interruptions: 0,
      interrupted_by_others: 0
    });
    seen.add(lower);
  }
  return out;
}

// ── Confidence bucket ───────────────────────────────────────────────

export function confidenceBucketFromEvidence(evidence: ResolveEvidence | null | undefined): "high" | "medium" | "low" | "unknown" {
  const topScore = typeof evidence?.profile_top_score === "number" ? evidence.profile_top_score : null;
  const svScore = typeof evidence?.sv_score === "number" ? evidence.sv_score : null;
  const score = topScore ?? svScore;
  if (score === null || !Number.isFinite(score)) return "unknown";
  if (score >= 0.8) return "high";
  if (score >= 0.6) return "medium";
  return "low";
}

// ── Quality metrics ─────────────────────────────────────────────────

export function echoLeakRate(transcript: TranscriptItem[]): number {
  const teacher = transcript
    .filter((item) => item.stream_role === "teacher")
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const students = transcript
    .filter((item) => item.stream_role === "students")
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  if (teacher.length === 0 || students.length === 0) return 0;

  let overlapLeak = 0;
  let totalStudents = 0;
  for (const item of students) {
    totalStudents += 1;
    const normalized = item.text.trim().toLowerCase();
    if (!normalized) continue;
    const hit = teacher.find((t) => {
      const overlap = Math.min(t.end_ms, item.end_ms) - Math.max(t.start_ms, item.start_ms);
      if (overlap <= 0) return false;
      const left = t.text.trim().toLowerCase();
      if (!left) return false;
      const short = normalized.length < left.length ? normalized : left;
      const long = normalized.length < left.length ? left : normalized;
      if (short.length < 12) return false;
      return long.includes(short);
    });
    if (hit) overlapLeak += 1;
  }
  if (totalStudents === 0) return 0;
  return overlapLeak / totalStudents;
}

export function suppressionFalsePositiveRate(
  transcript: TranscriptItem[],
  captureByStream: Record<StreamRole, CaptureState>
): number {
  const suppressed = Number(captureByStream.teacher.echo_suppressed_chunks ?? 0);
  if (!Number.isFinite(suppressed) || suppressed <= 0) return 0;
  const teacherTurns = transcript.filter((item) => item.stream_role === "teacher").length;
  if (teacherTurns <= 0) return 0;
  const ratio = suppressed / Math.max(teacherTurns, 1);
  return Math.max(0, Math.min(1, ratio * 0.1));
}

export function buildQualityMetrics(
  transcript: TranscriptItem[],
  captureByStream: Record<StreamRole, CaptureState>
): QualityMetrics {
  const students = transcript.filter((item) => item.stream_role === "students");
  const unknown = students.filter((item) => !item.speaker_name || item.decision === "unknown").length;
  const unknownRatio = students.length > 0 ? unknown / students.length : 0;
  const echoSuppressed = Number(captureByStream.teacher.echo_suppressed_chunks ?? 0);
  const echoRecent = Number(captureByStream.teacher.echo_suppression_recent_rate ?? 0);
  return {
    unknown_ratio: unknownRatio,
    students_utterance_count: students.length,
    students_unknown_count: unknown,
    echo_suppressed_chunks: Number.isFinite(echoSuppressed) ? Math.max(0, Math.floor(echoSuppressed)) : 0,
    echo_suppression_recent_rate: Number.isFinite(echoRecent) ? Math.max(0, Math.min(1, echoRecent)) : 0,
    echo_leak_rate: echoLeakRate(transcript),
    suppression_false_positive_rate: suppressionFalsePositiveRate(transcript, captureByStream)
  };
}

// ── Speech backend mode ─────────────────────────────────────────────

export function speechBackendMode(
  state: SessionState,
  dependencyHealth: DependencyHealthSnapshot
): "cloud-primary" | "cloud-secondary" | "edge-sidecar" | "hybrid" {
  const diarizationBackend = state.config?.diarization_backend === "edge" ? "edge" : "cloud";
  const activeInference = dependencyHealth.active_backend === "secondary" ? "cloud-secondary" : "cloud-primary";
  if (diarizationBackend === "edge" && activeInference === "cloud-secondary") return "hybrid";
  if (diarizationBackend === "edge") return "edge-sidecar";
  return activeInference;
}
