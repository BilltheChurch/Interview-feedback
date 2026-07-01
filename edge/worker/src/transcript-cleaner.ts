/**
 * transcript-cleaner.ts — Deterministic transcript cleaning (no LLM).
 *
 * Per design §9.3.1: the `cleaned_transcript` Granola deliverable must be produced
 * deterministically — Speechmatics/DashScope already transcribe the words, so we only
 * apply light, conservative cleanup (filler removal + whitespace normalization). The
 * LLM is reserved for summary / personalized_memo / scorecard, never the transcript.
 *
 * Conservative on purpose: we only strip unambiguous fillers (um/uh/嗯/呃…), never
 * meaning-bearing words like "like" / "you know" / "就是" / "那个".
 */

import type { StreamRole } from "./config";

export interface RawTranscriptItem {
  utterance_id: string;
  stream_role: StreamRole;
  speaker_name?: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface CleanedTranscriptItem {
  utterance_id: string;
  stream_role: StreamRole;
  speaker_name: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
}

/** Standalone English filler tokens (word-bounded so "summer"/"her"/"error" are safe). */
const EN_FILLER = /\b(?:u+m+|u+h+|e+rm+|er|a+h+|h+m+|uhh+)\b/gi;

/** Chinese filler characters that are almost always non-lexical interjections. */
const ZH_FILLER = ["嗯", "呃", "唔"];

/**
 * Sentence-final punctuation (ASCII + CJK). Used to decide whether an utterance
 * already terminates in a stop — if it does, we never append another one.
 */
const SENTENCE_FINAL_PUNCT = /[.。!！?？…；;]$/;

/**
 * Interrogative sentence-final particles in Chinese. When a CJK utterance ends
 * with one of these, we append `？` instead of `。`. Conservative on purpose:
 * `吧` is excluded — it is usually a suggestion/statement particle ("我们开始吧"
 * = "let's start"), so it takes the default `。`.
 */
const ZH_QUESTION_PARTICLE = /[吗呢]$/;

/**
 * Test whether a single character is CJK (Unicode ranges for the common
 * ideograph blocks). Used to pick the sentence-final punctuation flavor.
 */
function isCjkChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0x20000 && cp <= 0x2ebef) // CJK Extensions B–F (supplementary plane)
  );
}

/**
 * Append a deterministic sentence-final punctuation mark to a cleaned utterance
 * that lacks one. Each utterance is one pause = one sentence; Speechmatics
 * `cmn_en` emits no Chinese sentence-final punctuation on the output side, so we
 * restore readability here (no LLM — design §9.3.1). Idempotent: already-
 * terminated or empty strings are returned unchanged.
 */
function appendSentenceFinalPunct(text: string): string {
  if (!text) return text;
  if (SENTENCE_FINAL_PUNCT.test(text)) return text;

  // Use codepoint iteration so surrogate-pair CJK (supplementary plane) is intact.
  const chars = Array.from(text);
  const lastChar = chars[chars.length - 1];

  if (isCjkChar(lastChar)) {
    // Chinese sentence: `？` for interrogative particles, otherwise `。`.
    return ZH_QUESTION_PARTICLE.test(text) ? text + "？" : text + "。";
  }
  // Latin/ASCII sentence: plain period.
  return text + ".";
}

/**
 * Clean a single utterance's text deterministically.
 * Returns the cleaned string (may be empty if the utterance was pure filler).
 */
export function cleanUtteranceText(text: string): string {
  if (!text) return "";
  let out = text;

  // Remove English fillers (replace with a space to avoid joining adjacent words).
  out = out.replace(EN_FILLER, " ");

  // Remove Chinese filler characters outright (CJK text has no inter-word spaces).
  for (const f of ZH_FILLER) {
    out = out.split(f).join("");
  }

  // Collapse runs of whitespace.
  out = out.replace(/\s+/g, " ").trim();

  // Drop whitespace immediately before ASCII or CJK punctuation.
  out = out.replace(/\s+([,.!?;:，。！？；：、])/g, "$1");

  // Strip stray leading punctuation left behind by a removed leading filler.
  out = out.replace(/^[\s,，、.。;；:：]+/, "").trim();

  // Append a deterministic sentence-final punctuation mark if missing (§9.3.1,
  // no LLM). Speechmatics cmn_en emits no Chinese sentence-final punctuation.
  out = appendSentenceFinalPunct(out);

  return out;
}

/**
 * Produce the deterministic cleaned_transcript from reconciled utterances.
 * Utterances that become empty after cleaning (pure filler) are dropped.
 */
export function cleanTranscript(items: RawTranscriptItem[]): CleanedTranscriptItem[] {
  const cleaned: CleanedTranscriptItem[] = [];
  for (const item of items) {
    const text = cleanUtteranceText(item.text ?? "");
    if (!text) continue;
    cleaned.push({
      utterance_id: item.utterance_id,
      stream_role: item.stream_role,
      speaker_name: item.speaker_name ?? null,
      text,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
    });
  }
  return cleaned;
}
