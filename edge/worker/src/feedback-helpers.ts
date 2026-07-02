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

// ── R2: degraded overview-only report (no student speech) ────────────

/**
 * User-facing notice (English — surfaced in the desktop UI) shown when a
 * session produced no eligible student speech and only an overview is
 * available.
 */
export const NO_STUDENT_SPEECH_NOTICE =
  "No student speech detected — overview only. This report shows session overview and the interviewer's notes; no per-student feedback could be generated because no student speech was captured.";

/**
 * R2 fork: distinguish the two kinds of "the LLM produced no real per_person".
 *
 *   1. No eligible student speech (`eligibleActiveStudentCount === 0`) → a
 *      LEGITIMATE "interviewer monologue / silent student side" session. The
 *      only per_person present are memo-first PLACEHOLDER cards
 *      (buildMemoFirstReport always emits ≥1 person — a synthetic "unknown" or a
 *      zero-turn roster entry), NOT real scored feedback. Emit a clean
 *      overview-only degraded report instead of a hard block.
 *   2. Eligible students exist (`> 0`) but synthesis still returned nothing →
 *      genuine LLM failure; NOT degraded, keep the existing blocking path.
 *
 * `eligibleActiveStudentCount` MUST come from the shared eligibility oracle
 * (`computeEligibleSpeakers` in llm-synthesizer.ts) so this decision can never
 * diverge from what the synthesizer actually did. Do NOT pass `studentStats.length`
 * or a naive turns/talk-time count — those over-count relative to the synthesizer's
 * three-layer filter (which also excludes the interviewer by name and drops
 * unnamed/unmentioned clusters), which would wrongly keep the red bar.
 */
export function resolveNoStudentSpeechDegradation(
  eligibleActiveStudentCount: number
): { degraded: boolean; eligibleStudentCount: number; notice: string } {
  const degraded = eligibleActiveStudentCount === 0;
  return { degraded, eligibleStudentCount: eligibleActiveStudentCount, notice: NO_STUDENT_SPEECH_NOTICE };
}

// ── R2: 降级报告的 summary 重建（确定性拼接，无 LLM）─────────────────────

/** 降级 summary 单条 bullet 的字符上限（避免整段转写灌进 overview）。 */
const DEGRADED_BULLET_MAX_CHARS = 140;
/** 降级 summary 里面试官发言要点的最大条数。 */
const DEGRADED_TEACHER_BULLET_MAX = 4;
/** 一条发言要作为"有信息量的要点"至少需要的字符数（滤掉"早上好。"这类开场白）。 */
const DEGRADED_MIN_UTTERANCE_CHARS = 12;
/** 放宽门槛的兜底：teacher 要点为空时，退回取最长的这么多条发言（不设字数门槛）。 */
const DEGRADED_TEACHER_FALLBACK_MAX = 2;
/** session notes 摘要的字符上限。 */
const DEGRADED_NOTES_MAX_CHARS = 400;
/** notice 首段的字符上限——notice 是完整的用户告知文案（约 200 字符），绝不能拦腰
 *  截断成 "…could be…"；此上限远大于文案长度，仅防御异常超长输入。 */
const DEGRADED_NOTICE_MAX_CHARS = 400;
/** LLM 内容小结的最大条数 / 单条字符上限（R5）。 */
const DEGRADED_LLM_BULLET_MAX = 5;
const DEGRADED_LLM_BULLET_MAX_CHARS = 280;

/** 折叠空白 + 截断到 maxChars（超出加省略号）。 */
function clampText(text: string, maxChars: number): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

/**
 * 把富文本 HTML（TipTap notes / memo `<mark>` 标记）剥成纯文本（R5）。
 *
 * 降级 summary 曾把 notes 原样拼进 bullet，用户在报告里看到
 * `<p><mark data-memo-type="highlight" …>` 这类结构性泄漏。Worker 无 DOM，
 * 用保守正则处理：仅当输入确实像标记语言时才剥 tag（纯文本里孤立的 "<" 不受
 * 影响），随后解码常见 entity、折叠空白。
 */
export function stripHtmlToText(input: string): string {
  if (typeof input !== "string" || input.length === 0) return "";
  let text = input;
  if (/<[a-z!/]/i.test(text)) {
    text = text
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从降级场景的 transcript 里挑出"面试官候选发言"。
 *
 * 优先取 `stream_role === "teacher"` 的发言；但降级场景（无候选人发言）里，若
 * 转写完全没有标为 teacher 的 utterance（stream_role 缺失 / mixed / 未来数据变化），
 * 就把所有非空 utterance 视为面试官候选 —— 反正学生一侧没发言，剩下的就是面试官。
 * 返回按时间序排好的原始文本数组（已折叠空白、去空串）。
 *
 * 导出给三条降级 fork 复用——同一份文本既作确定性拼接的素材，也作
 * `synthesizeDegradedOverviewSummary` 的 LLM 输入，保证两条路径看到的发言一致。
 */
export function collectInterviewerUtterances(transcript: TranscriptItem[]): string[] {
  const textOf = (item: TranscriptItem): string =>
    typeof item.text === "string" ? item.text.trim().replace(/\s+/g, " ") : "";
  const byTime = (a: TranscriptItem, b: TranscriptItem): number =>
    a.start_ms - b.start_ms || a.end_ms - b.end_ms;

  const teacherItems = transcript.filter((item) => item.stream_role === "teacher");
  // stream_role fallback：无任何 teacher 流 utterance 时，退回全部非空 utterance。
  const source = teacherItems.length > 0 ? teacherItems : transcript;
  return source
    .slice()
    .sort(byTime)
    .map(textOf)
    .filter((text) => text.length > 0);
}

/**
 * R2 降级 fork 专用 —— 用确定性拼接（不调用 LLM）重建 overview 的
 * `summary_sections`，让"只有面试官说话 / 无候选人发言"的场次也有一份能反映
 * 本场实际内容的概述，而不是那句通用占位。
 *
 * 组装内容：
 *   1. 首段：no-student-speech notice —— 明确告知本场未检测到候选人发言、
 *      无法生成个人维度评估。文案直接取调用方传入的 `notice`（三处降级 fork
 *      已算好同一常量），并在有面试官发言时补一句本场发言的确定性统计
 *      （共 N 段、总时长约 M 秒 —— 直接从 transcript 算，无 LLM）。
 *   2. 面试官/记录者发言要点：优先取较长/有信息量的发言（按时间序，滤掉过短
 *      开场白）；若过滤后为空，退回取最长的 1-2 条原始发言（去掉字数门槛），
 *      避免"面试官只说了短句 + 没记 notes → summary 只剩 notice"的空洞退化。
 *   3. （若有）session notes 摘要：free-form notes 折叠成一段。
 *
 * evidence_ids 一律为空 `[]` —— 降级 summary 不挂 footnote，杜绝旧代码"按
 * evidence 数组顺序盲取头 4 个"把面试官开场白 quote 误挂成 summary 证据的问题。
 * 这些 bullet 是从 transcript/notes 直接派生的概述，没有对应的语义 evidence。
 *
 * 纯函数、无副作用。三条降级 fork（feedback-cache-refresh 的 history-reload
 * 路径、finalize-orchestrator 的 full 与 report-only 路径）共用它，保证行为一致。
 */
export function buildDegradedSummarySections(params: {
  transcript: TranscriptItem[];
  freeFormNotes: string | null;
  notice: string;
  /**
   * R5 可选：轻量 LLM 生成的内容小结要点（`synthesizeDegradedOverviewSummary` 产物）。
   * 非空时替代"原样拼接发言 + notes 摘要"两段——LLM 输入已包含两者，避免同一内容
   * 在 summary 里出现两遍；为空/缺省时回退确定性拼接（原行为），降级报告绝不因
   * LLM 失败而变空。
   */
  llmBullets?: string[] | null;
}): Array<{ topic: string; bullets: string[]; evidence_ids: string[] }> {
  const sections: Array<{ topic: string; bullets: string[]; evidence_ids: string[] }> = [];

  // 面试官候选发言（含 stream_role fallback）。
  const interviewerUtterances = collectInterviewerUtterances(params.transcript);

  // 1. notice —— 本场未检测到候选人发言。首段 bullet 直接用调用方传入的 notice
  //    （专用大上限，不能把完整告知文案截成 "…could be…"），并在有面试官发言时
  //    补一句确定性统计（发言段数 + 总时长秒）。
  const noticeBullets: string[] = [clampText(params.notice, DEGRADED_NOTICE_MAX_CHARS)];
  const teacherStreamItems = params.transcript.filter((item) => item.stream_role === "teacher");
  const statSource = teacherStreamItems.length > 0 ? teacherStreamItems : params.transcript;
  const speechCount = statSource.filter(
    (item) => typeof item.text === "string" && item.text.trim().length > 0
  ).length;
  if (speechCount > 0) {
    const totalMs = statSource.reduce(
      (sum, item) => sum + Math.max(0, (item.end_ms ?? 0) - (item.start_ms ?? 0)),
      0
    );
    const totalSeconds = Math.round(totalMs / 1000);
    noticeBullets.push(`本场面试官共 ${speechCount} 段发言，总时长约 ${totalSeconds} 秒。`);
  }
  sections.push({
    topic: "本场概述",
    bullets: noticeBullets,
    evidence_ids: [],
  });

  // R5: LLM 内容小结可用 → 用它替代下面的"原样拼接发言 + notes"两段。
  const llmBullets = (params.llmBullets ?? [])
    .map((bullet) => (typeof bullet === "string" ? bullet : ""))
    .map((bullet) => clampText(bullet, DEGRADED_LLM_BULLET_MAX_CHARS))
    .filter((bullet) => bullet.length > 0)
    .slice(0, DEGRADED_LLM_BULLET_MAX);
  if (llmBullets.length > 0) {
    sections.push({
      topic: "内容小结",
      bullets: llmBullets,
      evidence_ids: [],
    });
    return sections;
  }

  // 2. 面试官/记录者发言要点。优先较长/有信息量的发言；过滤后为空则退回最长 1-2 条。
  let teacherBullets = interviewerUtterances
    .filter((text) => text.replace(/\s+/g, "").length >= DEGRADED_MIN_UTTERANCE_CHARS)
    .slice(0, DEGRADED_TEACHER_BULLET_MAX)
    .map((text) => clampText(text, DEGRADED_BULLET_MAX_CHARS));
  if (teacherBullets.length === 0 && interviewerUtterances.length > 0) {
    // 兜底：面试官只说了短句 —— 放宽门槛，取最长的 1-2 条，保证 summary 有实际发言。
    teacherBullets = interviewerUtterances
      .slice()
      .sort((a, b) => b.length - a.length)
      .slice(0, DEGRADED_TEACHER_FALLBACK_MAX)
      .map((text) => clampText(text, DEGRADED_BULLET_MAX_CHARS));
  }
  if (teacherBullets.length > 0) {
    sections.push({
      topic: "面试官发言要点",
      bullets: teacherBullets,
      evidence_ids: [],
    });
  }

  // 3. session notes 摘要（free-form notes）。notes 是 TipTap 富文本 HTML（含 memo
  //    <mark> 标记），必须剥成纯文本再进 summary（R5 修复：结构性 HTML 泄漏）。
  const notes = stripHtmlToText(typeof params.freeFormNotes === "string" ? params.freeFormNotes : "");
  if (notes.length > 0) {
    sections.push({
      topic: "面试记录（Notes）",
      bullets: [clampText(notes, DEGRADED_NOTES_MAX_CHARS)],
      evidence_ids: [],
    });
  }

  return sections;
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
