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
      { key: "academic_motivation", label_zh: "学术动机", label_en: "Academic Motivation", description: "对目标项目/专业的理解深度、选择理由的逻辑性", weight: 1.0 },
      { key: "domain_knowledge", label_zh: "专业知识", label_en: "Domain Knowledge", description: "学科基础掌握程度、跨学科知识整合能力", weight: 1.0 },
      { key: "logical_reasoning", label_zh: "逻辑推理", label_en: "Logical Reasoning", description: "问题分析与推导能力、论证的严密性", weight: 1.0 },
      { key: "expression_structure", label_zh: "表达结构", label_en: "Expression & Structure", description: "回答的组织性、清晰度和说服力", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "提问意愿、探索精神、独立思考能力", weight: 1.0 },
    ],
  },
  {
    interview_type: "technical",
    label_zh: "技术面试",
    dimensions: [
      { key: "problem_analysis", label_zh: "问题分析", label_en: "Problem Analysis", description: "理解问题本质、拆解复杂需求的能力", weight: 1.0 },
      { key: "coding_ability", label_zh: "代码能力", label_en: "Coding Ability", description: "代码质量、算法选择、边界处理", weight: 1.0 },
      { key: "system_design", label_zh: "系统设计", label_en: "System Design", description: "架构思维、扩展性考虑、权衡取舍", weight: 1.0 },
      { key: "communication", label_zh: "沟通表达", label_en: "Communication", description: "技术方案阐述的清晰度、与面试官的互动质量", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "主动提问、考虑边界条件、探索优化方案", weight: 1.0 },
    ],
  },
  {
    interview_type: "behavioral",
    label_zh: "行为面试",
    dimensions: [
      { key: "leadership", label_zh: "领导力", label_en: "Leadership", description: "在团队情境中的引导能力、决策承担", weight: 1.0 },
      { key: "collaboration", label_zh: "协作能力", label_en: "Collaboration", description: "团队合作意识、冲突处理、支持他人", weight: 1.0 },
      { key: "resilience", label_zh: "抗压能力", label_en: "Resilience", description: "面对挫折的应对策略、情绪管理", weight: 1.0 },
      { key: "self_awareness", label_zh: "自我认知", label_en: "Self-Awareness", description: "对自身优劣势的认识、成长反思", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "超越基本要求的行动、独立解决问题", weight: 1.0 },
    ],
  },
  {
    interview_type: "group",
    label_zh: "小组面试",
    dimensions: [
      { key: "leadership", label_zh: "领导力", label_en: "Leadership", description: "议题推进、节奏把控、引导方向", weight: 1.0 },
      { key: "collaboration", label_zh: "协作能力", label_en: "Collaboration", description: "倾听、回应他人观点、建设性互动", weight: 1.0 },
      { key: "logical_reasoning", label_zh: "逻辑推理", label_en: "Logical Reasoning", description: "论证结构、数据运用、分析深度", weight: 1.0 },
      { key: "expression_structure", label_zh: "表达结构", label_en: "Expression & Structure", description: "发言组织性、重点突出、时间管理", weight: 1.0 },
      { key: "initiative", label_zh: "主动性", label_en: "Initiative", description: "首发发言、引入新视角、主动总结", weight: 1.0 },
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
 */
export type LooseDimensionItem = Omit<DimensionPresetItem, "key" | "weight"> & {
  key?: string;
  weight?: number;
};

/**
 * Lazy-migration helper: ensure every item in `dims` has a `key` (and a `weight`).
 * - Items with an existing non-empty `key` are left untouched (idempotent: a key
 *   generated on a previous pass is preserved on the next).
 * - Items missing a key (or with an empty string key) get a freshly generated one
 *   derived from `label_en` (the field used by DimensionPresetItem).
 * - `weight` defaults to `1` when a loaded item lacks it (old templates may predate
 *   weights).
 *
 * Returns a new `DimensionPresetItem[]`; does not mutate the input.
 */
export function ensureDimensionKeys(dims: LooseDimensionItem[]): DimensionPresetItem[] {
  return dims.map((d) => ({
    ...d,
    key: d.key || generateDimensionKey(d.label_en ?? ""),
    weight: d.weight ?? 1,
  }));
}
