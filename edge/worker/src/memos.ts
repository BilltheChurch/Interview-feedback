import type { MemoAnchor, MemoItem, MemoType } from "./types_v2";

interface MemoRequestPayload {
  type?: string;
  tags?: unknown;
  text?: unknown;
  anchors?: unknown;
}

const ALLOWED_MEMO_TYPES: Set<MemoType> = new Set([
  "observation",
  "evidence",
  "question",
  "decision",
  "score",
]);

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseAnchor(input: unknown): MemoAnchor | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const mode = asNonEmptyString(obj.mode);
  if (mode !== "time" && mode !== "utterance") {
    throw new Error("anchors.mode must be time|utterance");
  }

  const anchor: MemoAnchor = { mode };
  if (mode === "time") {
    if (!Array.isArray(obj.time_range_ms) || obj.time_range_ms.length !== 2) {
      throw new Error("anchors.time_range_ms must be [start_ms,end_ms]");
    }
    const start = Number(obj.time_range_ms[0]);
    const end = Number(obj.time_range_ms[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error("anchors.time_range_ms must be non-negative and ordered");
    }
    anchor.time_range_ms = [Math.floor(start), Math.floor(end)];
  }

  if (mode === "utterance") {
    if (!Array.isArray(obj.utterance_ids)) {
      throw new Error("anchors.utterance_ids must be string[]");
    }
    const ids = obj.utterance_ids
      .map((item) => asNonEmptyString(item))
      .filter(Boolean)
      .slice(0, 20);
    if (ids.length === 0) {
      throw new Error("anchors.utterance_ids must contain at least one id");
    }
    anchor.utterance_ids = ids;
  }
  return anchor;
}

export function parseMemoPayload(
  payload: MemoRequestPayload,
  options: {
    memoId: string;
    createdAtMs: number;
  }
): MemoItem {
  const typeRaw = asNonEmptyString(payload.type).toLowerCase();
  if (!ALLOWED_MEMO_TYPES.has(typeRaw as MemoType)) {
    throw new Error("memo.type must be observation|evidence|question|decision|score");
  }

  const text = asNonEmptyString(payload.text);
  if (!text) {
    throw new Error("memo.text is required");
  }
  if (text.length > 3000) {
    throw new Error("memo.text length must be <= 3000");
  }

  const tags = Array.isArray(payload.tags)
    ? payload.tags
        .map((item) => asNonEmptyString(item).toLowerCase())
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const memo: MemoItem = {
    memo_id: options.memoId,
    created_at_ms: Math.max(0, Math.floor(options.createdAtMs)),
    author_role: "teacher",
    type: typeRaw as MemoType,
    tags,
    text,
  };

  const anchors = parseAnchor(payload.anchors);
  if (anchors) {
    memo.anchors = anchors;
  }

  return memo;
}

export function nextMemoId(existing: MemoItem[], nowMs: number): string {
  const seq = existing.length + 1;
  return `m_${String(seq).padStart(6, "0")}_${nowMs}`;
}

export function filterMemos(
  memos: MemoItem[],
  {
    limit,
    fromMs,
    toMs,
  }: {
    limit: number;
    fromMs?: number | null;
    toMs?: number | null;
  }
): MemoItem[] {
  let scoped = memos;
  if (Number.isFinite(fromMs)) {
    scoped = scoped.filter((item) => item.created_at_ms >= Number(fromMs));
  }
  if (Number.isFinite(toMs)) {
    scoped = scoped.filter((item) => item.created_at_ms <= Number(toMs));
  }
  return scoped.slice(-Math.max(1, Math.min(limit, 500)));
}
