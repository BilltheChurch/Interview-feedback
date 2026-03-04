/**
 * D1 database helpers — write session metadata + dimension scores after finalization.
 * D1 stores lightweight index data; R2 stores full result blobs.
 */

import type { ResultV2, DimensionFeedback, PersonFeedbackItem } from "./types_v2";

// ── Types ────────────────────────────────────────────────────────────────

export interface D1SessionRow {
  id: string;
  org_id: string | null;
  created_by: string | null;
  title: string | null;
  duration_ms: number | null;
  speaker_count: number | null;
  phase: string;
  locale: string;
  r2_result_key: string | null;
  r2_audio_key: string | null;
  score_avg: number | null;
  report_source: string | null;
  finalized_at: string | null;
}

export interface D1DimensionScoreRow {
  id: string;
  session_id: string;
  person_key: string;
  person_name: string | null;
  dimension: string;
  label_zh: string | null;
  score: number;
  evidence_count: number;
}

// ── Write helpers ────────────────────────────────────────────────────────

/**
 * Persist session metadata + dimension scores to D1 after finalize success.
 * Uses a batch transaction for atomicity.
 */
export async function persistSessionToD1(
  db: D1Database,
  sessionId: string,
  result: ResultV2,
  r2ResultKey: string,
  opts?: { orgId?: string; createdBy?: string; title?: string; r2AudioKey?: string },
): Promise<{ sessionWritten: boolean; scoresWritten: number }> {
  const stmts: D1PreparedStatement[] = [];

  // Calculate average score across all persons + dimensions
  const allScores = result.per_person.flatMap((p) =>
    p.dimensions.filter((d) => !d.not_applicable && !d.evidence_insufficient).map((d) => d.score),
  );
  const scoreAvg = allScores.length > 0
    ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 100) / 100
    : null;

  // Calculate total duration from transcript
  const durationMs = result.transcript.length > 0
    ? result.transcript[result.transcript.length - 1].end_ms - result.transcript[0].start_ms
    : null;

  // 1. Upsert session
  stmts.push(
    db.prepare(`
      INSERT INTO sessions (id, org_id, created_by, title, duration_ms, speaker_count, phase, locale, r2_result_key, r2_audio_key, score_avg, report_source, finalized_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'finalized', ?7, ?8, ?9, ?10, ?11, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        duration_ms = excluded.duration_ms,
        speaker_count = excluded.speaker_count,
        phase = 'finalized',
        r2_result_key = excluded.r2_result_key,
        score_avg = excluded.score_avg,
        report_source = excluded.report_source,
        finalized_at = datetime('now')
    `).bind(
      sessionId,
      opts?.orgId ?? null,
      opts?.createdBy ?? null,
      opts?.title ?? null,
      durationMs,
      result.session.unresolved_cluster_count + (result.stats?.length ?? 0),
      result.session.caption_source === "acs-teams" ? "en-US" : "zh-CN",
      r2ResultKey,
      opts?.r2AudioKey ?? null,
      scoreAvg,
      result.quality.report_source ?? null,
    ),
  );

  // 2. Delete existing dimension scores for this session (re-finalize safe)
  stmts.push(
    db.prepare("DELETE FROM dimension_scores WHERE session_id = ?1").bind(sessionId),
  );

  // 3. Insert dimension scores
  let scoresWritten = 0;
  for (const person of result.per_person) {
    for (const dim of person.dimensions) {
      if (dim.not_applicable) continue;
      const scoreId = `${sessionId}-${person.person_key}-${dim.dimension}`;
      stmts.push(
        db.prepare(`
          INSERT INTO dimension_scores (id, session_id, person_key, person_name, dimension, label_zh, score, evidence_count)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        `).bind(
          scoreId,
          sessionId,
          person.person_key,
          person.display_name ?? null,
          dim.dimension,
          dim.label_zh ?? null,
          dim.score,
          dim.strengths.length + dim.risks.length,
        ),
      );
      scoresWritten++;
    }
  }

  // Execute all in a batch (D1 implicit transaction)
  await db.batch(stmts);

  return { sessionWritten: true, scoresWritten };
}

/**
 * Update session phase in D1 (e.g., archived after GDPR cleanup).
 */
export async function updateSessionPhaseD1(
  db: D1Database,
  sessionId: string,
  phase: string,
): Promise<void> {
  const col = phase === "archived" ? "archived_at" : "finalized_at";
  await db.prepare(
    `UPDATE sessions SET phase = ?1, ${col} = datetime('now') WHERE id = ?2`,
  ).bind(phase, sessionId).run();
}

// ── Read helpers ─────────────────────────────────────────────────────────

export interface SessionListQuery {
  orgId?: string;
  phase?: string;
  limit?: number;
  offset?: number;
  orderBy?: "created_at" | "finalized_at" | "score_avg";
  orderDir?: "ASC" | "DESC";
}

export interface SessionListItem {
  id: string;
  title: string | null;
  duration_ms: number | null;
  speaker_count: number | null;
  phase: string;
  score_avg: number | null;
  report_source: string | null;
  created_at: string;
  finalized_at: string | null;
}

/**
 * List sessions with pagination and filtering.
 */
export async function listSessionsD1(
  db: D1Database,
  query: SessionListQuery = {},
): Promise<{ sessions: SessionListItem[]; total: number }> {
  const { orgId, phase, limit = 20, offset = 0, orderBy = "created_at", orderDir = "DESC" } = query;

  // Build WHERE clauses
  const clauses: string[] = [];
  const binds: unknown[] = [];
  let bindIdx = 1;

  if (orgId) {
    clauses.push(`org_id = ?${bindIdx++}`);
    binds.push(orgId);
  }
  if (phase) {
    clauses.push(`phase = ?${bindIdx++}`);
    binds.push(phase);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  // Validate orderBy to prevent injection
  const validOrder = ["created_at", "finalized_at", "score_avg"].includes(orderBy) ? orderBy : "created_at";
  const validDir = orderDir === "ASC" ? "ASC" : "DESC";

  // Count total
  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM sessions ${where}`);
  const listStmt = db.prepare(
    `SELECT id, title, duration_ms, speaker_count, phase, score_avg, report_source, created_at, finalized_at
     FROM sessions ${where}
     ORDER BY ${validOrder} ${validDir}
     LIMIT ?${bindIdx++} OFFSET ?${bindIdx++}`,
  );

  const countBinds = [...binds];
  const listBinds = [...binds, limit, offset];

  const [countResult, listResult] = await db.batch([
    countStmt.bind(...countBinds),
    listStmt.bind(...listBinds),
  ]);

  const total = ((countResult.results[0] as unknown) as { total: number })?.total ?? 0;
  const sessions = listResult.results as unknown as SessionListItem[];

  return { sessions, total };
}

/**
 * Get dimension scores for a session.
 */
export async function getSessionScoresD1(
  db: D1Database,
  sessionId: string,
): Promise<D1DimensionScoreRow[]> {
  const result = await db.prepare(
    `SELECT id, session_id, person_key, person_name, dimension, label_zh, score, evidence_count
     FROM dimension_scores
     WHERE session_id = ?1
     ORDER BY person_key, dimension`,
  ).bind(sessionId).all();

  return result.results as unknown as D1DimensionScoreRow[];
}
