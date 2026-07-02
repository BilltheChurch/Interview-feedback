/**
 * Worker-native LLM report synthesizer (A5).
 *
 * Ports `inference/app/services/report_synthesizer.py` +
 * `inference/app/services/dashscope_llm.py` to a pure, fetch-based Cloudflare
 * Worker module. It builds the synthesis prompt, calls Alibaba DashScope via the
 * OpenAI-compatible chat-completions endpoint, and parses the LLM JSON back into
 * the exact shapes the finalize orchestrator consumes.
 *
 * Scope (matches the Worker TS contract):
 *   - The LLM produces ONLY `overall` + `per_person` (+ `summary` and
 *     `personalized_memo` when requested). It NEVER produces `cleaned_transcript`
 *     — that is computed deterministically elsewhere (§9.3.1 transcript-cleaner).
 *   - `synthesizeReportInWorker` returns the contract envelope:
 *     `{ data, backend_used: 'worker-dashscope', degraded, warnings }`.
 *
 * Exported pure helpers (individually testable):
 *   - estimateTokens(text)              — CJK-aware token estimate
 *   - truncateTranscript(transcript)    — keep first-per-speaker + recent (~4000 tok)
 *   - buildSynthesisMessages(payload)   — system + user chat messages
 *   - parseSynthesisResponse(raw)       — robust JSON extraction + safe defaults
 *   - synthesizeReportInWorker(env, …)  — main entry point (calls the LLM)
 *
 * IMPORTANT: This file is self-contained and does not modify other files. The
 * orchestrator wiring is done separately.
 */

import type { Env } from "../config";
import type {
  DimensionClaim,
  DimensionFeedback,
  EvidenceItem,
  MemoItem,
  MemoSpeakerBinding,
  OverallFeedback,
  PersonFeedbackItem,
  ReportQualityMeta,
  SpeakerStatItem,
  SuggestedDimension,
  SynthesizeRequestPayload,
} from "../types_v2";

// ── Constants (ported verbatim from Python) ─────────────────────────────────

/** OpenAI-compatible DashScope endpoint (same one dashscope_llm.py uses). */
const DASHSCOPE_CHAT_COMPLETIONS_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

/**
 * Default model. The Python service read REPORT_MODEL_NAME from env; per the
 * task the Worker uses `env.LLM_MODEL ?? "qwen-plus"`. `qwen-plus` is the model
 * the Python pipeline used for report synthesis (per project memory / CLAUDE.md).
 */
const DEFAULT_LLM_MODEL = "qwen-plus";

/** Low temperature for deterministic, consistent reports (Python: 0.2). */
const LLM_TEMPERATURE = 0.2;

/** Default request timeout (Python REPORT_TIMEOUT_MS default = 45000ms). */
const DEFAULT_TIMEOUT_MS = 45_000;

/** Retry policy (Python dashscope_llm.py). */
const MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 502, 503]);

/**
 * Generous completion cap so long multi-person reports are not truncated mid-JSON.
 * Headroom matters more with reasoning models (e.g. qwen3.7-plus) whose hidden
 * reasoning_content shares the completion budget with the visible JSON answer.
 */
const DEFAULT_MAX_TOKENS = 16_384;

/** Transcript truncation budget (Python: max_tokens=4000). */
const TRANSCRIPT_MAX_TOKENS = 4000;

/** Legacy default dimension keys (Python DIMENSIONS). */
const DEFAULT_DIMENSION_KEYS = [
  "leadership",
  "collaboration",
  "logic",
  "structure",
  "initiative",
] as const;

/**
 * Default dimension presets (Python DEFAULT_DIMENSION_PRESETS). Each carries an
 * explicit `weight: 1.0` so the no-rubric fallback path also has a defined
 * weight (never undefined). Equal weights = unchanged, unweighted behavior.
 */
const DEFAULT_DIMENSION_PRESETS: Array<{
  key: string;
  label_zh: string;
  description: string;
  weight: number;
}> = [
  { key: "leadership", label_zh: "领导力", description: "展现领导力、主动推进讨论、统筹全局的能力", weight: 1.0 },
  { key: "collaboration", label_zh: "协作能力", description: "团队合作、倾听他人、建设性互动的能力", weight: 1.0 },
  { key: "logic", label_zh: "逻辑思维", description: "分析问题、推理论证、逻辑清晰度", weight: 1.0 },
  { key: "structure", label_zh: "结构化表达", description: "表达条理性、信息组织能力、框架化思维", weight: 1.0 },
  { key: "initiative", label_zh: "主动性", description: "主动提出方案、积极参与、展现进取心", weight: 1.0 },
];

// ── Local error type (mirrors Python ValidationError semantics) ─────────────

/** Raised when the LLM call/response is unusable. Caller falls back to memo-first. */
export class SynthesizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynthesizerError";
  }
}

// ── Public types ────────────────────────────────────────────────────────────

/** Chat message in the OpenAI-compatible request body. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Parsed LLM payload. Mirrors the `data` slice the orchestrator reads:
 * `per_person`, `overall`, plus optional `summary` / `personalized_memo`.
 */
export interface ParsedSynthesis {
  overall: OverallFeedback;
  per_person: PersonFeedbackItem[];
  summary?: string;
  personalized_memo?: string;
}

/** Contract envelope returned by `synthesizeReportInWorker`. */
export interface WorkerSynthesisResult {
  data: {
    per_person: PersonFeedbackItem[];
    overall: OverallFeedback;
    quality?: Partial<ReportQualityMeta>;
    summary?: string;
    personalized_memo?: string;
  };
  /** Distinguishes this Worker-native path from the inference-helpers backends. */
  backend_used: "worker-dashscope";
  /** true if synthesis hit non-blocking warnings or partial failures. */
  degraded: boolean;
  warnings: string[];
}

// ── Token estimation (Python _estimate_tokens) ──────────────────────────────

/**
 * CJK-aware token estimate.
 * - Chinese-dominant text: ~1.5 tokens/char.
 * - Otherwise: ~1.3 tokens/whitespace-delimited word.
 * "Chinese-dominant" = CJK chars > 30% of length (matches Python threshold).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // CJK Unified Ideographs (4e00–9fff) + Extension A (3400–4dbf)
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) {
      cjk += 1;
    }
  }
  if (cjk > text.length * 0.3) {
    return Math.trunc(text.length * 1.5); // Chinese
  }
  // English: split on whitespace, drop empties
  const words = text.split(/\s+/).filter(Boolean);
  return Math.trunc(words.length * 1.3);
}

// ── Transcript truncation (Python _truncate_transcript) ─────────────────────

type TranscriptUtterance = SynthesizeRequestPayload["transcript"][number];

/**
 * Truncate the transcript if the total estimated token count exceeds
 * `maxTokens`. Strategy (ported exactly):
 *   1. If total <= budget → return all, wasTruncated=false.
 *   2. Sort by start_ms; keep the FIRST utterance per speaker
 *      (key = speaker_name || cluster_id || "unknown").
 *   3. Fill remaining budget with the most-recent utterances (iterate reversed),
 *      skipping any whose token cost would overflow the budget.
 *   4. Re-sort by start_ms; return that subset, wasTruncated=true.
 */
export function truncateTranscript(
  transcript: TranscriptUtterance[],
  maxTokens: number = TRANSCRIPT_MAX_TOKENS
): { transcript: TranscriptUtterance[]; wasTruncated: boolean } {
  const total = transcript.reduce((sum, u) => sum + estimateTokens(u.text), 0);
  if (total <= maxTokens) {
    return { transcript: [...transcript], wasTruncated: false };
  }

  const sorted = [...transcript].sort((a, b) => a.start_ms - b.start_ms);

  // First utterance per speaker.
  const firstPerSpeaker = new Map<string, TranscriptUtterance>();
  for (const u of sorted) {
    const key = u.speaker_name || u.cluster_id || "unknown";
    if (!firstPerSpeaker.has(key)) firstPerSpeaker.set(key, u);
  }
  const mustKeepIds = new Set<string>();
  for (const u of firstPerSpeaker.values()) mustKeepIds.add(u.utterance_id);

  const result: TranscriptUtterance[] = sorted.filter((u) =>
    mustKeepIds.has(u.utterance_id)
  );
  let currentTokens = result.reduce((sum, u) => sum + estimateTokens(u.text), 0);

  // Fill from the end (most recent = most relevant).
  for (let i = sorted.length - 1; i >= 0; i--) {
    const u = sorted[i];
    if (mustKeepIds.has(u.utterance_id)) continue;
    const cost = estimateTokens(u.text);
    if (currentTokens + cost > maxTokens) continue;
    result.push(u);
    currentTokens += cost;
  }

  result.sort((a, b) => a.start_ms - b.start_ms);
  return { transcript: result, wasTruncated: true };
}

// ── Dimension preset resolution (Python _get_dimension_keys / _dicts) ───────

function getDimensionKeys(payload: SynthesizeRequestPayload): string[] {
  const presets = payload.session_context?.dimension_presets;
  if (presets && presets.length > 0) return presets.map((d) => d.key);
  return [...DEFAULT_DIMENSION_KEYS];
}

/**
 * Resolve the evaluation dimensions for synthesis, preserving each dimension's
 * `weight` (default 1) so the LLM can weight the per-person overall assessment
 * and cross-person ranking. Weight is NOT applied to the per-dimension 0-10
 * scores — only to how the overall conclusion/ranking is formed (see rule 4).
 * Exported for unit testing.
 */
export function getDimensionPresets(
  payload: SynthesizeRequestPayload
): Array<{ key: string; label_zh: string; description: string; weight: number }> {
  const presets = payload.session_context?.dimension_presets;
  if (presets && presets.length > 0) {
    return presets.map((d) => ({
      key: d.key,
      // Custom dimensions only set label_en in the editor, so label_zh is "".
      // Fall back to the English name (then key) so the report's Chinese
      // dimension label is never blank. Preset dims keep their non-empty label_zh.
      label_zh: d.label_zh || d.label_en || d.key,
      description: d.description,
      weight: d.weight ?? 1,
    }));
  }
  return [...DEFAULT_DIMENSION_PRESETS];
}

function getDimensionLabelMap(payload: SynthesizeRequestPayload): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of getDimensionPresets(payload)) map[d.key] = d.label_zh;
  return map;
}

// ── Alias normalization (Python _normalize_alias_in_text) ───────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace bare alias mentions with "alias(PrimaryName)" so the LLM never
 * misattributes an alias. Skips mentions already followed by "(Primary)" /
 * "（Primary）". Mirrors the Python negative-lookahead regex.
 */
function normalizeAliasInText(
  text: string,
  nameAliases: Record<string, string[]> | undefined
): string {
  if (!nameAliases) return text;
  let out = text;
  for (const [primary, aliases] of Object.entries(nameAliases)) {
    for (const alias of aliases) {
      const pattern = new RegExp(
        escapeRegExp(alias) + "(?!\\s*[（(]" + escapeRegExp(primary) + ")",
        "g"
      );
      out = out.replace(pattern, `${alias}(${primary})`);
    }
  }
  return out;
}

// ── Speaker identification / filtering (Python helpers) ──────────────────────

/** Cluster-id sentinel like c1, c2 — not a real display name. */
const CLUSTER_ID_RE = /^c\d+$/;

function identifyInterviewerKeys(payload: SynthesizeRequestPayload): Set<string> {
  const keys = new Set<string>();
  for (const u of payload.transcript) {
    if (u.stream_role === "teacher" && u.speaker_name) keys.add(u.speaker_name);
  }
  const interviewer = payload.session_context?.interviewer_name;
  if (interviewer) keys.add(interviewer);
  return keys;
}

function extractMemoMentionedKeys(payload: SynthesizeRequestPayload): Set<string> {
  const keys = new Set<string>();

  // 1. Explicit memo-speaker bindings.
  for (const binding of payload.memo_speaker_bindings) {
    for (const k of binding.matched_speaker_keys) keys.add(k);
  }

  // 2. name → speaker_key lookup (lowercased).
  const nameToKey: Record<string, string> = {};
  for (const s of payload.stats) {
    nameToKey[s.speaker_key.toLowerCase()] = s.speaker_key;
    if (s.speaker_name) nameToKey[s.speaker_name.toLowerCase()] = s.speaker_key;
  }

  // 3. Aliases → primary speaker_key.
  const nameAliases = payload.name_aliases ?? {};
  for (const [primaryName, aliases] of Object.entries(nameAliases)) {
    let targetKey: string | null = null;
    for (const s of payload.stats) {
      if (s.speaker_key === primaryName || s.speaker_name === primaryName) {
        targetKey = s.speaker_key;
        break;
      }
    }
    if (targetKey) {
      for (const alias of aliases) nameToKey[alias.toLowerCase()] = targetKey;
    }
  }

  // 4. Scan memo text + free-form notes for any of those names.
  let allText = payload.memos.map((m) => m.text).join(" ");
  if (payload.free_form_notes) allText += " " + payload.free_form_notes;
  const lower = allText.toLowerCase();
  for (const [name, speakerKey] of Object.entries(nameToKey)) {
    if (lower.includes(name)) keys.add(speakerKey);
  }
  return keys;
}

function hasValidName(s: SpeakerStatItem): boolean {
  return (
    !!s.speaker_name &&
    !CLUSTER_ID_RE.test(s.speaker_name) &&
    s.speaker_name !== "unknown"
  );
}

/**
 * Returns { active, zeroTurn }.
 *   active:   turns > 0 && talk_time > 0, not interviewer, has name or in memos.
 *   zeroTurn: turns == 0 but mentioned in memos.
 * Unresolved clusters (no name, not in memos) are dropped entirely.
 */
function filterEligibleSpeakers(
  stats: SpeakerStatItem[],
  interviewerKeys: Set<string>,
  memoKeys: Set<string>
): { active: SpeakerStatItem[]; zeroTurn: SpeakerStatItem[] } {
  const active: SpeakerStatItem[] = [];
  const zeroTurn: SpeakerStatItem[] = [];
  for (const s of stats) {
    if (interviewerKeys.has(s.speaker_key)) continue;
    if (interviewerKeys.has(s.speaker_name ?? "")) continue;
    const named = !!s.speaker_name && !CLUSTER_ID_RE.test(s.speaker_name);
    const inMemos = memoKeys.has(s.speaker_key) || memoKeys.has(s.speaker_name ?? "");
    if (!named && !inMemos) continue;
    if (s.turns > 0 && s.talk_time_ms > 0) {
      active.push(s);
    } else if (inMemos) {
      zeroTurn.push(s);
    }
  }
  return { active, zeroTurn };
}

/**
 * Shared eligibility oracle (R2). Runs the EXACT same three-layer filter the
 * synthesis prompt uses to decide which speakers become `interviewee_stats`
 * (and therefore whether the LLM can produce any per_person items):
 *   ① exclude interviewer keys (teacher-stream speaker names + interviewer_name)
 *   ② drop clusters that are neither named nor mentioned in memos
 *   ③ require turns > 0 && talk_time_ms > 0 to count as "active"
 *
 * The finalize orchestrator calls this so its "no eligible student speech"
 * decision can never diverge from what the synthesizer actually did. Returns
 * both the active (spoke) and zeroTurn (mentioned-but-silent) speakers plus the
 * interviewer/memo key sets for reuse.
 */
export function computeEligibleSpeakers(payload: SynthesizeRequestPayload): {
  active: SpeakerStatItem[];
  zeroTurn: SpeakerStatItem[];
  interviewerKeys: Set<string>;
  memoKeys: Set<string>;
} {
  const interviewerKeys = identifyInterviewerKeys(payload);
  const memoKeys = extractMemoMentionedKeys(payload);
  const { active, zeroTurn } = filterEligibleSpeakers(payload.stats, interviewerKeys, memoKeys);
  return { active, zeroTurn, interviewerKeys, memoKeys };
}

// ── Evidence speaker_key accessor ───────────────────────────────────────────
// `buildSynthesizePayload` (finalize_v2.ts) attaches a normalized `speaker_key`
// onto each evidence item via `{ ...e, speaker_key }`. The base EvidenceItem
// type doesn't declare it, so read it defensively.
function evidenceSpeakerKey(e: EvidenceItem): string | null {
  const sk = (e as EvidenceItem & { speaker_key?: string | null }).speaker_key;
  return sk ?? e.speaker?.display_name ?? e.speaker?.cluster_id ?? null;
}

// ── System prompt (Python _build_system_prompt) ─────────────────────────────

function buildSystemPrompt(payload: SynthesizeRequestPayload): string {
  const localeHint = payload.locale === "zh-CN" ? "Chinese (zh-CN)" : "English";

  const ctx = payload.session_context ?? null;
  const interviewType = ctx?.interview_type || "未指定";
  const positionTitle = ctx?.position_title || "未指定";
  const companyName = ctx?.company_name || "";
  const interviewerName = ctx?.interviewer_name || "未指定";

  const contextAnchor =
    `你正在为以下面试生成评估报告：\n` +
    `- 面试类型: ${interviewType}\n` +
    `- 目标职位/项目: ${positionTitle}${companyName ? " @ " + companyName : ""}\n` +
    `- 面试官: ${interviewerName}\n` +
    `\n所有评价必须围绕候选人是否适合「${positionTitle !== "未指定" ? positionTitle : "该职位"}」展开。` +
    `不要给出泛泛的能力评估——每个 claim 都要与目标职位/项目的具体要求关联。\n\n`;

  const scoringRubric =
    `评分标准（0-10 量表）：\n` +
    `  0-2: 严重不足 — 缺乏基本能力表现\n` +
    `  3-4: 偏弱 — 有零星表现但整体不足\n` +
    `  5-6: 基本达标 — 满足基本要求但无亮点\n` +
    `  7-8: 良好 — 有明显优势和具体案例支撑\n` +
    `  9-10: 优秀 — 表现突出，有多个强有力的证据\n\n`;

  // RULES 1-10 are ported verbatim from report_synthesizer.py.
  let prompt =
    "You are an expert interview analyst generating structured feedback reports.\n\n" +
    contextAnchor +
    scoringRubric +
    "RULES:\n" +
    "1. EVIDENCE: Every claim cites 1-5 evidence_ids from evidence_pack only (no invented IDs). " +
    "Memos/free-form notes are first-class evidence — cross-reference with transcript. " +
    "Match evidence to speakers via speaker_key AND quote text content. " +
    "evidence_kind='interviewer_note' 是面试官自己写的笔记/观察，绝不是候选人说过的原话——" +
    "可作为面试官观察的依据，但严禁把它的 quote 当成候选人 transcript 引用照抄或标注为候选人发言；" +
    "只有 evidence_kind='candidate_quote' 才是候选人真实转写。" +
    "claim.text 必须是纯自然语言，引用放 evidence_refs 数组。优先 tier_1 证据，tier_3 仅作补充。\n" +
    "2. CONFIDENCE: Single-evidence claims → confidence < 0.4. Weak-evidence dimensions → ONE claim at 0.3-0.4. " +
    "binding_status='unresolved' speakers → ALL claim confidence ≤ 0.5 (code-enforced).\n" +
    '3. SCOPE: Only evaluate INTERVIEWEES (stream_role: "students"), never the interviewer. ' +
    "Zero-turn speakers are pre-filtered — do NOT generate entries for speakers not in interviewee_stats. " +
    "For each person in interviewee_stats (all have turns > 0), generate ≥1 strength + ≥1 risk claim.\n" +
    "4. DIMENSIONS: 使用 dimension_presets 评估框架，每维度独立按表现打 0-10 分。" +
    "证据不足设 not_applicable: true + score: 5。如需额外维度，输出 suggested_dimensions。\n" +
    "   WEIGHTING: 每个维度带一个 `weight`（默认 1，越大越重要）。0-10 的单维度分数本身绝不按 weight 缩放——" +
    "weight 只用于形成 per_person 的整体结论（overall assessment）和候选人之间的横向排名（ranking）：" +
    "高 weight 维度应对整体结论和排名产生更大影响，低 weight 维度影响更小。" +
    "当所有 weight 相等（如默认全为 1）时，按等权处理，行为与未加权一致。\n" +
    "5. ALIASES: name_aliases 中的别名是同一人，合并到 primary name 的 per_person entry（person_key = primary name）。\n" +
    "6. CLAIMS: Each claim includes supporting_utterances (1-3 utterance_ids). " +
    "Group observations by stage when available. Incorporate stats_observations naturally.\n" +
    "7. OVERALL: 生成 narrative（2-4句连贯段落，围绕 position_title）+ ≥3 key_findings。" +
    "Memo 与 transcript 矛盾时标注差异。\n" +
    "8. RECOMMENDATION: decision (recommend/tentative/not_recommend), confidence (0-1), rationale (中文), context_type.\n" +
    "9. QUESTION_ANALYSIS: 每个面试官问题 → question_text, answer_utterance_ids, answer_quality (A/B/C/D), comment, " +
    "related_dimensions, scoring_rationale, answer_highlights, answer_weaknesses, suggested_better_answer。\n" +
    "10. INTERVIEW_QUALITY: coverage_ratio (0-1), follow_up_depth (int), structure_score (0-10), suggestions (中文).\n\n";

  // NEW (Worker A5) deliverable instructions for summary / personalized_memo.
  // These fields are NOT produced by the Python service; they are gated by the
  // payload flags and instructed only when requested.
  const wantSummary = payload.want_summary !== false; // default true
  const personalize = payload.personalize_to_notes === true; // default false
  if (wantSummary) {
    prompt +=
      "11. SUMMARY: Output `summary` — a concise meeting summary (3-6 sentences, " +
      `${localeHint}) covering what was discussed, key moments, and the outcome. ` +
      "Plain prose, no citations.\n";
  }
  if (wantSummary && personalize) {
    prompt +=
      "12. PERSONALIZED_MEMO: Output `personalized_memo` — a short note-aware memo " +
      `(${localeHint}) that weaves the interviewer's own free_form_notes/memos into ` +
      "a personalized takeaway. Reflect their priorities and wording where possible.\n";
  }

  prompt +=
    "\nOUTPUT FORMAT: Strict JSON matching the output_contract.\n" +
    `LANGUAGE: ${localeHint} — use professional, concise language.\n`;

  return prompt;
}

// ── User prompt (Python _build_user_prompt) ─────────────────────────────────

function buildUserPrompt(
  payload: SynthesizeRequestPayload,
  truncatedTranscript: TranscriptUtterance[]
): string {
  // Evidence pack with source_tier (default 1).
  // evidence_kind marks whether the text is a candidate transcript quote or the
  // interviewer's own free-form note. A "note" must NEVER be cited as something
  // the candidate said (see RULE 1).
  const evidencePack = payload.evidence.map((e) => ({
    evidence_id: e.evidence_id,
    speaker_key: evidenceSpeakerKey(e),
    time_range_ms: e.time_range_ms,
    quote: (e.quote ?? "").slice(0, 400),
    source_tier: e.source_tier ?? 1,
    evidence_kind: e.type === "note" ? "interviewer_note" : "candidate_quote",
  }));

  const transcriptSegments = truncatedTranscript.map((u) => ({
    utterance_id: u.utterance_id,
    speaker_name: u.speaker_name ?? null,
    text: (u.text ?? "").slice(0, 600),
    start_ms: u.start_ms,
    end_ms: u.end_ms,
  }));

  // Alias normalization applied to memo text + free-form notes.
  const normalize = (t: string): string => normalizeAliasInText(t, payload.name_aliases);

  const bindingMap = new Map<string, MemoSpeakerBinding>();
  for (const b of payload.memo_speaker_bindings) bindingMap.set(b.memo_id, b);

  const memosWithBindings = payload.memos.map((memo: MemoItem) => {
    const entry: Record<string, unknown> = {
      memo_id: memo.memo_id,
      text: normalize(memo.text),
      type: memo.type,
      tags: memo.tags,
      created_at_ms: memo.created_at_ms,
    };
    if (memo.stage) entry.stage = memo.stage;
    const binding = bindingMap.get(memo.memo_id);
    if (binding) entry.bound_speakers = binding.matched_speaker_keys;
    return entry;
  });

  // Speaker filtering.
  const interviewerKeys = identifyInterviewerKeys(payload);
  const memoMentionedKeys = extractMemoMentionedKeys(payload);
  const { active: activeStats } = filterEligibleSpeakers(
    payload.stats,
    interviewerKeys,
    memoMentionedKeys
  );

  // all_stats: only named speakers (avoids LLM inventing cluster-id entries).
  const allStats = payload.stats
    .filter((s) => hasValidName(s))
    .map((s) => ({
      speaker_key: s.speaker_key,
      speaker_name: s.speaker_name,
      talk_time_ms: s.talk_time_ms,
      turns: s.turns,
    }));

  const intervieweeStats = activeStats.map((s) => ({
    speaker_key: s.speaker_key,
    speaker_name: hasValidName(s) ? s.speaker_name : `${s.speaker_key} (未确认身份)`,
    talk_time_ms: s.talk_time_ms,
    turns: s.turns,
    binding_status: s.binding_status ?? "resolved",
  }));

  const dimPresets = getDimensionPresets(payload);

  // Output contract (v2 + v3 enrichment), ported from Python.
  const outputContract: Record<string, unknown> = {
    overall: {
      narrative: "string — cohesive 2-4 sentence paragraph, NO [e_XXXXX] references",
      narrative_evidence_refs: ["e_XXXXX"],
      key_findings: [
        {
          type: "strength|risk|observation",
          text: "string — pure text, no citations",
          evidence_refs: ["e_XXXXX"],
        },
      ],
      suggested_dimensions: [
        {
          key: "string",
          label_zh: "string",
          reason: "string",
          action: "add|replace|mark_not_applicable",
          replaces: "string|null",
        },
      ],
      recommendation: {
        decision: "recommend / tentative / not_recommend",
        confidence: 0.85,
        rationale: "一句话推荐理由（中文）",
        context_type: "hiring",
      },
      question_analysis: [
        {
          question_text: "面试官的原始问题",
          answer_utterance_ids: ["回答的utterance id列表"],
          answer_quality: "A/B/C/D",
          comment: "回答质量简评（中文，1-2句）",
          related_dimensions: ["关联的维度key"],
          scoring_rationale: "评分理由（中文，2-3句）",
          answer_highlights: ["亮点1：引用候选人具体表述", "亮点2"],
          answer_weaknesses: ["不足1：具体缺陷描述", "不足2"],
          suggested_better_answer: "改进方向建议（中文，2-3句）",
        },
      ],
      interview_quality: {
        coverage_ratio: "被有效探查的维度数/总维度数 (0-1)",
        follow_up_depth: "面试官有效追问次数 (int)",
        structure_score: "0-10",
        suggestions: "对面试官的建议（中文，1-2句）",
      },
    },
    per_person: [
      {
        person_key: "string (from stats speaker_key, interviewees only)",
        display_name: "string",
        dimensions: [
          {
            dimension: "string (from dimension_presets[].key)",
            label_zh: "string (from dimension_presets[].label_zh)",
            score: 8.5,
            score_rationale: "string — 1-2 sentences",
            evidence_insufficient: false,
            not_applicable: false,
            strengths: [
              {
                claim_id: "c_{person}_{dim}_{nn}",
                text: "string — pure natural language, NO [e_XXXXX]",
                evidence_refs: ["e_XXXXX"],
                confidence: 0.85,
                supporting_utterances: ["utterance_id"],
              },
            ],
            risks: ["...same structure as strengths..."],
            actions: ["...same structure as strengths..."],
          },
        ],
        summary: {
          strengths: ["string"],
          risks: ["string"],
          actions: ["string"],
        },
      },
    ],
  };

  // NEW deliverable fields in the output contract, gated by flags.
  const wantSummary = payload.want_summary !== false;
  const personalize = payload.personalize_to_notes === true;
  if (wantSummary) {
    outputContract.summary = "string — concise meeting summary (3-6 sentences)";
  }
  if (wantSummary && personalize) {
    outputContract.personalized_memo =
      "string — note-aware personalized memo reflecting the interviewer's own notes";
  }

  const promptData: Record<string, unknown> = {
    task: "synthesize_report",
    session_id: payload.session_id,
    transcript_segments: transcriptSegments,
    memos_with_bindings: memosWithBindings,
    evidence_pack: evidencePack,
    all_stats: allStats,
    "interviewee_stats (ONLY generate per_person entries for these speakers)": intervieweeStats,
    "interviewer_keys (DO NOT evaluate these speakers)": Array.from(interviewerKeys),
    stages: payload.stages,
    evaluation_dimensions: dimPresets,
    output_contract: outputContract,
  };

  if (payload.rubric) {
    promptData.rubric = {
      template_name: payload.rubric.template_name,
      dimensions: payload.rubric.dimensions.map((d) => ({
        name: d.name,
        description: d.description,
        weight: d.weight,
      })),
    };
  }

  if (payload.session_context) {
    const sc: Record<string, unknown> = {
      mode: payload.session_context.mode,
      interviewer_name: payload.session_context.interviewer_name,
      position_title: payload.session_context.position_title,
    };
    if (payload.session_context.company_name) sc.company_name = payload.session_context.company_name;
    if (payload.session_context.interview_type) sc.interview_type = payload.session_context.interview_type;
    promptData.session_context = sc;
  }

  if (payload.free_form_notes) {
    promptData.free_form_notes = normalize(payload.free_form_notes.slice(0, 2000));
  }

  if (payload.name_aliases) {
    promptData["name_aliases (SAME person, merge into primary name's per_person entry)"] =
      payload.name_aliases;
  }

  if (payload.stats_observations && payload.stats_observations.length > 0) {
    promptData.stats_observations = payload.stats_observations;
  }

  if (payload.historical && payload.historical.length > 0) {
    promptData.historical = payload.historical.map((h) => ({
      session_id: h.session_id,
      date: h.date,
      summary: h.summary,
      strengths: h.strengths,
      risks: h.risks,
    }));
  }

  // ensure_ascii=False equivalent — JSON.stringify preserves UTF-8.
  return JSON.stringify(promptData);
}

/**
 * Build the chat messages array (system + user) for the DashScope request.
 * Pure and independently testable: applies transcript truncation internally.
 */
export function buildSynthesisMessages(payload: SynthesizeRequestPayload): ChatMessage[] {
  const { transcript: truncated } = truncateTranscript(payload.transcript, TRANSCRIPT_MAX_TOKENS);
  return [
    { role: "system", content: buildSystemPrompt(payload) },
    { role: "user", content: buildUserPrompt(payload, truncated) },
  ];
}

// ── Robust JSON extraction ──────────────────────────────────────────────────

/**
 * Extract a JSON object from a raw LLM string that may contain code fences or
 * leading/trailing prose. Returns null if nothing parseable is found.
 *
 * Strategy:
 *   1. Try JSON.parse on the trimmed string directly.
 *   2. Strip ```json / ``` fences and retry.
 *   3. Slice from the first "{" to the last "}" and retry (balances stray text).
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  // 1. Direct.
  let parsed = tryParse(trimmed);
  if (parsed) return parsed;

  // 2. Strip code fences (```json ... ``` or ``` ... ```).
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    parsed = tryParse(fenceMatch[1].trim());
    if (parsed) return parsed;
  }

  // 3. First "{" to last "}".
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    parsed = tryParse(trimmed.slice(first, last + 1));
    if (parsed) return parsed;
  }

  return null;
}

// ── Parse helpers ───────────────────────────────────────────────────────────

function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function toFloat(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(asString(v));
  return Number.isFinite(n) ? n : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x).trim()).filter((s) => s.length > 0);
}

// ── Response parsing (Python _parse_llm_output) ─────────────────────────────

/**
 * Parse the raw LLM string into { overall, per_person, summary?, personalized_memo? }.
 *
 * Robust: handles code fences / leading prose, and falls back to safe empty
 * defaults on malformed output (never throws). Note: an empty `per_person`
 * causes the orchestrator to fall back to memo-first, which is the desired
 * behavior on a bad response.
 *
 * NOTE: Unlike the Python version, evidence-ref validity filtering, alias
 * merging, eligibility filtering, zero-turn placeholders, and the unresolved-
 * speaker confidence clamp are applied downstream in the orchestrator
 * (sanitizeClaimEvidenceRefs / validateClaimEvidenceRefs / backfill). This
 * parser preserves the LLM-produced refs and claims as-is so the orchestrator's
 * existing sanitization owns the single source of truth.
 */
export function parseSynthesisResponse(raw: string): ParsedSynthesis {
  const empty: ParsedSynthesis = {
    overall: { narrative: "", narrative_evidence_refs: [], key_findings: [] },
    per_person: [],
  };

  const parsed = extractJsonObject(raw);
  if (!parsed) return empty;

  const overall = parseOverall(parsed.overall);
  const perPerson = parsePerPerson(parsed.per_person);

  const result: ParsedSynthesis = { overall, per_person: perPerson };

  const summary = asString(parsed.summary).trim();
  if (summary) result.summary = summary;

  const personalizedMemo = asString(parsed.personalized_memo).trim();
  if (personalizedMemo) result.personalized_memo = personalizedMemo;

  return result;
}

function parseOverall(raw: unknown): OverallFeedback {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const narrative = asString(o.narrative).trim();
  const narrativeRefs = asStringArray(o.narrative_evidence_refs);

  const keyFindings: NonNullable<OverallFeedback["key_findings"]> = [];
  if (Array.isArray(o.key_findings)) {
    for (const kf of o.key_findings) {
      if (!kf || typeof kf !== "object") continue;
      const k = kf as Record<string, unknown>;
      let type = asString(k.type, "observation").trim();
      if (type !== "strength" && type !== "risk" && type !== "observation") {
        type = "observation";
      }
      const text = asString(k.text).trim();
      if (!text) continue;
      keyFindings.push({
        type: type as "strength" | "risk" | "observation",
        text,
        evidence_refs: asStringArray(k.evidence_refs).slice(0, 5),
      });
    }
  }

  const suggestedDimensions: SuggestedDimension[] = [];
  if (Array.isArray(o.suggested_dimensions)) {
    for (const sd of o.suggested_dimensions) {
      if (!sd || typeof sd !== "object") continue;
      const d = sd as Record<string, unknown>;
      const key = asString(d.key).trim();
      if (!key) continue;
      let action = asString(d.action, "add").trim();
      if (action !== "add" && action !== "replace" && action !== "mark_not_applicable") {
        action = "add";
      }
      suggestedDimensions.push({
        key,
        label_zh: asString(d.label_zh).trim(),
        reason: asString(d.reason).trim(),
        action: action as SuggestedDimension["action"],
        replaces: d.replaces != null ? asString(d.replaces) : undefined,
      });
    }
  }

  // Legacy backward-compat: summary_sections + team_dynamics.
  const summarySections: NonNullable<OverallFeedback["summary_sections"]> = [];
  if (Array.isArray(o.summary_sections)) {
    for (const sec of o.summary_sections) {
      if (!sec || typeof sec !== "object") continue;
      const s = sec as Record<string, unknown>;
      const topic = asString(s.topic).trim();
      if (!topic) continue;
      summarySections.push({
        topic,
        bullets: asStringArray(s.bullets).slice(0, 6),
        evidence_ids: asStringArray(s.evidence_ids).slice(0, 6),
      });
    }
  }

  const teamRaw = o.team_dynamics && typeof o.team_dynamics === "object"
    ? (o.team_dynamics as Record<string, unknown>)
    : {};
  const highlights = asStringArray(teamRaw.highlights).slice(0, 6);
  const risks = asStringArray(teamRaw.risks).slice(0, 6);

  // Fallback: derive narrative from legacy summary_sections if missing.
  let finalNarrative = narrative;
  if (!finalNarrative && summarySections.length > 0) {
    finalNarrative = summarySections
      .map((s) => s.bullets.join(" "))
      .join(" ")
      .slice(0, 2000);
  }

  // Fallback: derive key_findings from team_dynamics if none provided.
  if (keyFindings.length === 0) {
    for (const h of highlights) keyFindings.push({ type: "strength", text: h, evidence_refs: [] });
    for (const r of risks) keyFindings.push({ type: "risk", text: r, evidence_refs: [] });
  }

  return {
    narrative: finalNarrative,
    narrative_evidence_refs: narrativeRefs.slice(0, 10),
    key_findings: keyFindings.slice(0, 10),
    suggested_dimensions: suggestedDimensions.slice(0, 5),
    summary_sections: summarySections.slice(0, 6),
    team_dynamics: { highlights, risks },
  };
}

function parseClaims(raw: unknown, personKey: string, dimName: string): DimensionClaim[] {
  if (!Array.isArray(raw)) return [];
  const claims: DimensionClaim[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const text = asString(obj.text).trim();
    if (!text) continue;
    const cid = asString(obj.claim_id).trim();
    const refs = asStringArray(obj.evidence_refs).slice(0, 5);
    const conf = clamp(toFloat(obj.confidence, 0.7), 0, 1);
    const supporting = asStringArray(obj.supporting_utterances).slice(0, 3);
    claims.push({
      // Auto-generate a stable id when the LLM omitted one (1-based, 2-digit).
      claim_id:
        cid ||
        `c_${personKey}_${dimName}_${String(claims.length + 1).padStart(2, "0")}`,
      text,
      evidence_refs: refs,
      confidence: conf,
      supporting_utterances: supporting,
    });
  }
  return claims;
}

function parsePerPerson(raw: unknown): PersonFeedbackItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PersonFeedbackItem[] = [];

  for (const personRaw of raw) {
    if (!personRaw || typeof personRaw !== "object") continue;
    const p = personRaw as Record<string, unknown>;
    const personKey = asString(p.person_key).trim();
    if (!personKey) continue;
    const displayName = asString(p.display_name, personKey).trim() || personKey;

    const dimensions: DimensionFeedback[] = [];
    if (Array.isArray(p.dimensions)) {
      for (const dimRaw of p.dimensions) {
        if (!dimRaw || typeof dimRaw !== "object") continue;
        const d = dimRaw as Record<string, unknown>;
        const dimName = asString(d.dimension).trim();
        if (!dimName) continue;
        dimensions.push({
          dimension: dimName,
          label_zh: asString(d.label_zh).trim(),
          score: clamp(toFloat(d.score, 5.0), 0, 10),
          score_rationale: asString(d.score_rationale).trim(),
          evidence_insufficient: Boolean(d.evidence_insufficient),
          not_applicable: Boolean(d.not_applicable),
          strengths: parseClaims(d.strengths, personKey, dimName),
          risks: parseClaims(d.risks, personKey, dimName),
          actions: parseClaims(d.actions, personKey, dimName),
        });
      }
    }

    const summaryRaw = p.summary && typeof p.summary === "object"
      ? (p.summary as Record<string, unknown>)
      : {};

    out.push({
      person_key: personKey,
      display_name: displayName,
      dimensions,
      summary: {
        strengths: asStringArray(summaryRaw.strengths).slice(0, 3),
        risks: asStringArray(summaryRaw.risks).slice(0, 3),
        actions: asStringArray(summaryRaw.actions).slice(0, 3),
      },
    });
  }

  return out;
}

// ── DashScope HTTP call (Python DashScopeLLM.generate_json) ─────────────────

function parseTimeoutMs(value: string | undefined): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call DashScope chat-completions and return the raw assistant message content.
 * Retries on timeout (AbortError) and retryable status codes (429/502/503),
 * with exponential backoff capped at 5s — matching the Python client.
 */
async function callDashScope(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number
): Promise<string> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new SynthesizerError("ALIYUN_DASHSCOPE_API_KEY is required for report generation");
  }

  const body = JSON.stringify({
    model,
    temperature: LLM_TEMPERATURE,
    max_tokens: DEFAULT_MAX_TOKENS,
    response_format: { type: "json_object" },
    // qwen3.7-plus is a reasoning model: with thinking on, hidden reasoning_content burns
    // ~5k extra tokens and ~3x latency (133s vs 40s in testing), blowing the timeout. For
    // structured JSON synthesis the reasoning adds little, so disable it. (Ignored by
    // non-reasoning models like qwen-plus, so this stays safe across LLM_MODEL choices.)
    enable_thinking: false,
    messages,
  });

  const headers = {
    Authorization: `Bearer ${trimmedKey}`,
    "Content-Type": "application/json",
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1000));
    let response: Response;
    try {
      response = await fetch(DASHSCOPE_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // Timeout / network abort → retry, else fail.
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(2 ** attempt * 500, 5000));
        continue;
      }
      throw new SynthesizerError("Report generation service timed out after retries");
    }
    clearTimeout(timer);

    if (response.status < 400) {
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const choices = json?.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new SynthesizerError("dashscope response missing choices");
      }
      const content = choices[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new SynthesizerError("dashscope response missing message content");
      }
      return content;
    }

    // Retryable status → backoff + retry.
    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
      await sleep(Math.min(2 ** attempt * 500, 5000));
      continue;
    }

    // Non-retryable or exhausted retries.
    throw new SynthesizerError(
      `Report generation service temporarily unavailable (status=${response.status})`
    );
  }

  // Unreachable, but satisfies the type checker.
  throw new SynthesizerError("Report generation failed after retries");
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Worker-native LLM report synthesis (A5).
 *
 * Builds the prompt, calls DashScope, parses the response, and returns the
 * contract envelope. Does NOT implement its own memo-first fallback — on a
 * hard failure it throws `SynthesizerError` so the orchestrator can run its own
 * fallback chain (matching the Python service's "raise to caller" design).
 *
 * On a successful call that yields no usable per_person, it returns a degraded
 * envelope (empty per_person) rather than throwing, letting the orchestrator's
 * existing empty-per_person handling fall back to memo-first.
 *
 * @throws SynthesizerError if the LLM call itself fails (timeout/HTTP/missing content).
 */
export async function synthesizeReportInWorker(
  env: Env,
  payload: SynthesizeRequestPayload
): Promise<WorkerSynthesisResult> {
  const warnings: string[] = [];
  let degraded = false;

  const apiKey = env.ALIYUN_DASHSCOPE_API_KEY ?? "";
  // `LLM_MODEL` is not declared on Env; read it without widening the interface.
  const model = (env as Env & { LLM_MODEL?: string }).LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const timeoutMs = parseTimeoutMs(env.INFERENCE_TIMEOUT_MS);

  // Build prompt (also tells us whether the transcript was truncated, for quality meta).
  const { wasTruncated } = truncateTranscript(payload.transcript, TRANSCRIPT_MAX_TOKENS);
  const messages = buildSynthesisMessages(payload);

  // Call the LLM (may throw SynthesizerError — caller handles fallback).
  const rawContent = await callDashScope(apiKey, model, messages, timeoutMs);

  // Parse (never throws; returns safe defaults on malformed output).
  const parsed = parseSynthesisResponse(rawContent);

  if (parsed.per_person.length === 0) {
    degraded = true;
    warnings.push("llm_synthesis_no_per_person");
  }

  // Count claims for quality meta.
  let claimCount = 0;
  let needsEvidence = 0;
  for (const person of parsed.per_person) {
    for (const dim of person.dimensions) {
      for (const claim of [...dim.strengths, ...dim.risks, ...dim.actions]) {
        claimCount += 1;
        if (!claim.evidence_refs || claim.evidence_refs.length === 0) needsEvidence += 1;
      }
    }
  }

  const quality: Partial<ReportQualityMeta> = {
    report_source: wasTruncated ? "llm_synthesized_truncated" : "llm_synthesized",
    report_model: model,
    report_error: null,
    claim_count: claimCount,
    needs_evidence_count: needsEvidence,
  };

  const wantSummary = payload.want_summary !== false;
  const deliverable = payload.deliverable !== false;

  const data: WorkerSynthesisResult["data"] = {
    per_person: parsed.per_person,
    overall: parsed.overall,
    quality,
  };

  // summary / personalized_memo are only delivered when requested AND deliverable.
  if (wantSummary && deliverable) {
    if (parsed.summary) data.summary = parsed.summary;
    if (parsed.personalized_memo) data.personalized_memo = parsed.personalized_memo;
  }

  return {
    data,
    backend_used: "worker-dashscope",
    degraded,
    warnings,
  };
}

// ── R5: degraded overview-only summary（无候选人发言场次的内容小结） ─────────

/** 降级小结：面试官发言输入上限（字符）——防长独白撑爆 prompt。 */
const DEGRADED_SUMMARY_SPEECH_MAX_CHARS = 8000;
/** 降级小结：notes 输入上限（字符）。 */
const DEGRADED_SUMMARY_NOTES_MAX_CHARS = 2000;
/** 降级小结：最多返回的要点条数。 */
const DEGRADED_SUMMARY_MAX_BULLETS = 5;

/**
 * R5：用一次轻量 LLM 调用把"只有面试官说话"场次的发言 + notes 概括成 2-5 条
 * 中文要点，供 `buildDegradedSummarySections` 作"内容小结"段。
 *
 * 背景（round-5 真人反馈）：降级 summary 的确定性拼接只能原样搬运 caption 文本，
 * 用户明确要"总结出说话的核心内容"——这只有 LLM 能做。此调用刻意与主报告合成
 * 解耦：prompt 极小（无 per-person/evidence 契约），失败/超时/欠费时抛
 * `SynthesizerError`，调用方 catch 后回退确定性拼接——降级报告永不因此变空。
 *
 * 入参约定：`notesText` 必须是已剥好 HTML 的纯文本（调用方过 `stripHtmlToText`）；
 * `interviewerUtterances` 用 `collectInterviewerUtterances` 取，保证与确定性
 * 拼接路径看到同一份发言。两者皆空时不发起网络调用，直接返回 []。
 */
export async function synthesizeDegradedOverviewSummary(
  env: Env,
  params: { interviewerUtterances: string[]; notesText: string }
): Promise<string[]> {
  const speech = params.interviewerUtterances
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter((text) => text.length > 0)
    .join("\n");
  const notes = typeof params.notesText === "string" ? params.notesText.trim() : "";
  if (!speech && !notes) return [];

  const apiKey = env.ALIYUN_DASHSCOPE_API_KEY ?? "";
  const model = (env as Env & { LLM_MODEL?: string }).LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const timeoutMs = parseTimeoutMs(env.INFERENCE_TIMEOUT_MS);

  const clip = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, max)}…`;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是面试记录助手。本场面试未检测到候选人发言，只有面试官的讲话和面试官写的笔记。" +
        "请用中文把面试官实际讲的核心内容概括为 2-5 条要点，每条一句完整的话，按需覆盖：" +
        "面试官的身份与来历、说明的面试流程或选拔标准、提出的问题或话题、笔记里的关键记录。" +
        '不要逐句复述原文，不要虚构未提及的内容，不要输出评价或建议。只返回 JSON：{"bullets": ["要点", "…"]}',
    },
    {
      role: "user",
      content:
        `【面试官发言（按时间序）】\n${clip(speech, DEGRADED_SUMMARY_SPEECH_MAX_CHARS) || "（无）"}\n\n` +
        `【面试官笔记】\n${clip(notes, DEGRADED_SUMMARY_NOTES_MAX_CHARS) || "（无）"}`,
    },
  ];

  const raw = await callDashScope(apiKey, model, messages, timeoutMs);
  const parsed = extractJsonObject(raw);
  return asStringArray(parsed?.["bullets"])
    .map((bullet) => bullet.trim())
    .filter((bullet) => bullet.length > 0)
    .slice(0, DEGRADED_SUMMARY_MAX_BULLETS);
}
