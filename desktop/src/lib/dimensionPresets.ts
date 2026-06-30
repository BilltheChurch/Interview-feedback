export interface DimensionPresetItem {
  key: string;
  label_zh: string;
  label_en: string;
  description: string;
  weight: number;
}

export interface DimensionPresetTemplate {
  interview_type: string;
  label_zh: string;
  dimensions: DimensionPresetItem[];
}

export const DIMENSION_PRESETS: DimensionPresetTemplate[] = [
  {
    interview_type: "academic",
    label_zh: "学术面试",
    dimensions: [
      { key: "academic_motivation", label_zh: "学术动机", label_en: "Academic Motivation", description: "Depth of understanding of the target program/field and how well-reasoned their motivation is", weight: 1.0 },
      { key: "domain_knowledge", label_zh: "专业知识", label_en: "Domain Knowledge", description: "Command of subject fundamentals and ability to integrate cross-disciplinary knowledge", weight: 1.0 },
      { key: "logical_reasoning", label_zh: "逻辑推理", label_en: "Logical Reasoning", description: "Ability to analyze and reason through problems with rigorous argumentation", weight: 1.0 },
      { key: "expression_structure", label_zh: "表达结构", label_en: "Expression & Structure", description: "Organization, clarity, and persuasiveness of their answers", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "Willingness to ask questions, spirit of inquiry, and independent thinking", weight: 1.0 },
    ],
  },
  {
    interview_type: "technical",
    label_zh: "技术面试",
    dimensions: [
      { key: "problem_analysis", label_zh: "问题分析", label_en: "Problem Analysis", description: "Ability to grasp the essence of a problem and break down complex requirements", weight: 1.0 },
      { key: "coding_ability", label_zh: "代码能力", label_en: "Coding Ability", description: "Code quality, choice of algorithms, and handling of edge cases", weight: 1.0 },
      { key: "system_design", label_zh: "系统设计", label_en: "System Design", description: "Architectural thinking, scalability considerations, and trade-off decisions", weight: 1.0 },
      { key: "communication", label_zh: "沟通表达", label_en: "Communication", description: "Clarity in explaining technical solutions and quality of interaction with the interviewer", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "Asking questions proactively, considering edge cases, and exploring optimizations", weight: 1.0 },
    ],
  },
  {
    interview_type: "behavioral",
    label_zh: "行为面试",
    dimensions: [
      { key: "leadership", label_zh: "领导力", label_en: "Leadership", description: "Ability to guide others in team settings and own decisions", weight: 1.0 },
      { key: "collaboration", label_zh: "协作能力", label_en: "Collaboration", description: "Teamwork mindset, conflict handling, and supporting others", weight: 1.0 },
      { key: "resilience", label_zh: "抗压能力", label_en: "Resilience", description: "Coping strategies under setbacks and emotional self-management", weight: 1.0 },
      { key: "self_awareness", label_zh: "自我认知", label_en: "Self-Awareness", description: "Awareness of their own strengths and weaknesses and reflection on growth", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "Going beyond the basics and solving problems independently", weight: 1.0 },
    ],
  },
  {
    interview_type: "group",
    label_zh: "小组面试",
    dimensions: [
      { key: "leadership", label_zh: "领导力", label_en: "Leadership", description: "Driving the discussion forward, managing pace, and steering direction", weight: 1.0 },
      { key: "collaboration", label_zh: "协作能力", label_en: "Collaboration", description: "Listening, responding to others' points, and constructive interaction", weight: 1.0 },
      { key: "logical_reasoning", label_zh: "逻辑推理", label_en: "Logical Reasoning", description: "Structure of arguments, use of data, and depth of analysis", weight: 1.0 },
      { key: "expression_structure", label_zh: "表达结构", label_en: "Expression & Structure", description: "Organization of remarks, emphasis on key points, and time management", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "Speaking up first, introducing new perspectives, and summarizing proactively", weight: 1.0 },
    ],
  },
];

export function getPresetByType(interviewType: string): DimensionPresetTemplate | undefined {
  return DIMENSION_PRESETS.find((p) => p.interview_type === interviewType);
}

/**
 * English display labels for the four interview types, keyed by `interview_type`.
 * Single source of truth (D6 English-only): the rubric type pills and the Review
 * summary both read from here. `DimensionPresetTemplate` only carries `label_zh`,
 * so the English names live here.
 */
export const INTERVIEW_TYPE_LABELS_EN: Record<string, string> = {
  academic: "Academic",
  technical: "Technical",
  behavioral: "Behavioral",
  group: "Group",
};

/** Resolve the English label for an interview type, falling back to the raw type. */
export function getInterviewTypeLabelEn(type: string): string {
  return INTERVIEW_TYPE_LABELS_EN[type] ?? type;
}

// Base36 alphabet for building a guaranteed 6-char random suffix.
const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Generate a stable-looking but random 6-character lowercase base36 string.
 * `Math.random().toString(36).slice(2,8)` can occasionally produce fewer than
 * 6 characters when the fractional part has trailing zeros.  This loop-based
 * approach always returns exactly 6 chars.
 */
function randomBase36(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += BASE36_ALPHABET[Math.floor(Math.random() * 36)];
  }
  return result;
}

/**
 * Generate a unique key for a custom evaluation dimension.
 *
 * Key format (D3, locked):
 *   "custom_" + slug + "_" + <6-char lowercase base36 random>
 *
 * Where slug = name.toLowerCase()
 *                 .replace(/[^a-z0-9]+/g, "_")
 *                 .replace(/^_+|_+$/g, "")   // strip leading/trailing underscores
 *                 .slice(0, 20)
 *
 * If the resulting slug is empty, "dim" is used instead.
 */
export function generateDimensionKey(name: string): string {
  // LOCKED slug rule (design doc D3) — must match a future worker validator
  // byte-for-byte. Do NOT add any extra normalization (e.g. a post-slice
  // trailing-underscore strip): the leading/trailing strip happens BEFORE the
  // 20-char cap, and nothing happens after it.
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 20) || "dim";

  return `custom_${slug}_${randomBase36(6)}`;
}

/**
 * Loaded-from-JSON shape: a dimension item that may be missing its `key`
 * (e.g. legacy `ifb_rubric_templates` entries) and may predate `weight`.
 * Accepting this widened input lets callers feed untyped localStorage JSON
 * into `ensureDimensionKeys` without `as` casts.
 *
 * `label_en`/`label_zh` are also optional and `name` is accepted because the
 * OLDEST `ifb_rubric_templates` entries (written by the now-deleted
 * RubricTemplateModal) used `{ name, weight, description }` — no `key`, no
 * `label_en`/`label_zh`. Lazy migration backfills the English name from `name`.
 */
export type LooseDimensionItem = Omit<DimensionPresetItem, "key" | "weight" | "label_en" | "label_zh"> & {
  key?: string;
  weight?: number;
  label_en?: string;
  label_zh?: string;
  /** Legacy English dimension name (pre-`label_en` templates). */
  name?: string;
};

/** True for a non-null plain object (filters out null / strings / numbers). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Lazy-migration helper: ensure every item in `dims` has a `key` (and a `weight`).
 * - Items with an existing non-empty `key` are left untouched (idempotent: a key
 *   generated on a previous pass is preserved on the next).
 * - Items missing a key (or with an empty string key) get a freshly generated one
 *   derived from `name` (legacy) → `label_en`, matching the spec/plan rule
 *   `generateDimensionKey(d.name ?? d.label_en ?? "")`.
 * - The English name is backfilled from the legacy `name` field when `label_en`
 *   is absent, so old `{ name, weight, description }` templates don't render a
 *   blank name (and don't ship a blank name to the worker).
 * - `weight` defaults to `1` when a loaded item lacks it (old templates may predate
 *   weights); `label_zh` defaults to `""` when absent.
 * - Corrupt array elements (null / strings / non-objects) are skipped so a
 *   hand-edited local template can't crash the editor on select.
 *
 * Returns a new `DimensionPresetItem[]`; does not mutate the input.
 */
export function ensureDimensionKeys(dims: LooseDimensionItem[]): DimensionPresetItem[] {
  return dims.filter(isPlainObject).map((d) => {
    // Drop the legacy `name` field from the carried props — it has been migrated
    // into `label_en` and is not part of DimensionPresetItem.
    const { name: _legacyName, ...rest } = d;
    return {
      ...rest,
      label_en: d.label_en ?? d.name ?? "",
      label_zh: d.label_zh ?? "",
      description: d.description ?? "",
      key: d.key || generateDimensionKey(d.name ?? d.label_en ?? ""),
      weight: d.weight ?? 1,
    };
  });
}
