/**
 * speechmatics-asr.ts — Speechmatics realtime ASR protocol + outbound WS (A1).
 *
 * Speechmatics is the cloud STT provider chosen for the cloud-companion pivot (D3): it
 * provides realtime transcription + realtime speaker diarization + bilingual cmn_en in a
 * single session. Empirically validated 2026-06-27 (scripts/speechmatics_rt_validate.mjs):
 * cmn_en + diarization=speaker + 16kHz raw PCM work simultaneously and return per-word
 * speaker labels (S1/S2/…) with word-level timestamps.
 *
 * This module holds the pure protocol logic (message builders + parser) plus the outbound
 * WebSocket handshake. The realtime lifecycle (persistent streaming, silence keepalive,
 * R2-replay reconnect, backpressure) is wired into realtime-asr-processor by the dispatch
 * layer (A1b) and reuses these primitives.
 *
 * Protocol ref: wss://eu.rt.speechmatics.com/v2/ , Authorization: Bearer <key>.
 *   client → StartRecognition (JSON) → binary PCM frames (AddAudio) → EndOfStream (JSON)
 *   server → RecognitionStarted, AudioAdded{seq_no}, AddPartialTranscript, AddTranscript,
 *            EndOfTranscript, Error, Warning
 */

import type { Env } from "./config";

export const SPEECHMATICS_DEFAULT_WS_URL = "wss://eu.rt.speechmatics.com/v2/";

/** Per-channel Speechmatics realtime configuration. */
export interface SpeechmaticsConfig {
  /** Language code, e.g. "en" or bilingual "cmn_en" (Mandarin+English). */
  language: string;
  /** Enable speaker diarization. Off for the teacher channel (single speaker, §9.3.4). */
  diarization: boolean;
  /** Emit partial (interim) transcripts. */
  enablePartials: boolean;
  /** Final-transcript latency budget in seconds (0.7–4). */
  maxDelaySeconds: number;
  /** Audio sample rate (16000 for our pipeline). */
  sampleRate: number;
  /** Maximum number of speakers for diarization. Speechmatics enforces a minimum of 2;
   *  undefined lets Speechmatics auto-detect. Only applied when diarization is true. */
  maxSpeakers?: number;
}

export const DEFAULT_SPEECHMATICS_CONFIG: Omit<SpeechmaticsConfig, "language" | "diarization"> = {
  enablePartials: true,
  maxDelaySeconds: 2.0,
  sampleRate: 16000,
};

/** Build the StartRecognition control message. */
export function buildStartRecognition(cfg: SpeechmaticsConfig): Record<string, unknown> {
  const transcription_config: Record<string, unknown> = {
    language: cfg.language,
    enable_partials: cfg.enablePartials,
    max_delay: cfg.maxDelaySeconds,
  };
  // Only request diarization when wanted — the teacher channel is single-speaker and
  // enabling it there would split the interviewer into phantom S1/S2 (§9.3.4).
  if (cfg.diarization) {
    transcription_config.diarization = "speaker";
    // speaker_diarization_config.max_speakers caps the number of distinct speakers
    // Speechmatics will separate. Speechmatics enforces a minimum of 2; omit when
    // undefined to let it auto-detect (see resolveMaxSpeakers in config.ts).
    if (cfg.maxSpeakers !== undefined) {
      transcription_config.speaker_diarization_config = { max_speakers: cfg.maxSpeakers };
    }
  }
  return {
    message: "StartRecognition",
    audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: cfg.sampleRate },
    transcription_config,
  };
}

/** Build the EndOfStream control message. `lastSeqNo` = number of audio frames sent. */
export function buildEndOfStream(lastSeqNo: number): Record<string, unknown> {
  return { message: "EndOfStream", last_seq_no: lastSeqNo };
}

export interface SpeechmaticsWord {
  text: string;
  start_ms: number;
  end_ms: number;
  /** Diarization label (e.g. "S1") or null when diarization is off/absent. */
  speaker: string | null;
  confidence: number | null;
  /** True for punctuation results (attached without a leading space). */
  is_punctuation: boolean;
}

export interface SpeechmaticsTranscript {
  is_partial: boolean;
  text: string;
  words: SpeechmaticsWord[];
  start_ms: number;
  end_ms: number;
  /** Distinct speaker labels appearing in this message. */
  speakers: string[];
}

export type SpeechmaticsMessage =
  | { type: "RecognitionStarted"; id: string | null; language_pack: unknown }
  | { type: "AudioAdded"; seq_no: number }
  | { type: "Transcript"; transcript: SpeechmaticsTranscript }
  | { type: "EndOfTranscript" }
  | { type: "Error"; code: string | null; reason: string; raw: unknown }
  | { type: "Warning"; reason: string }
  | { type: "Unknown"; message: string; raw: unknown };

/**
 * Parse a raw Speechmatics text frame into a typed message.
 * Returns null if the frame is not valid JSON. Transcript text is reconstructed from the
 * word/punctuation results (reliable across format versions) with punctuation attached.
 */
export function parseSpeechmaticsMessage(raw: string): SpeechmaticsMessage | null {
  let msg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    msg = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const message = String(msg.message ?? "");
  switch (message) {
    case "RecognitionStarted":
      return { type: "RecognitionStarted", id: msg.id ? String(msg.id) : null, language_pack: msg.language_pack_info ?? null };
    case "AudioAdded":
      return { type: "AudioAdded", seq_no: Number(msg.seq_no ?? 0) };
    case "EndOfTranscript":
      return { type: "EndOfTranscript" };
    case "Error":
      return { type: "Error", code: msg.type ? String(msg.type) : null, reason: String(msg.reason ?? "speechmatics error"), raw: msg };
    case "Warning":
      return { type: "Warning", reason: String(msg.reason ?? "speechmatics warning") };
    case "AddPartialTranscript":
    case "AddTranscript":
      return { type: "Transcript", transcript: parseTranscript(msg, message === "AddPartialTranscript") };
    default:
      return { type: "Unknown", message, raw: msg };
  }
}

function parseTranscript(msg: Record<string, unknown>, isPartial: boolean): SpeechmaticsTranscript {
  const results = Array.isArray(msg.results) ? (msg.results as Array<Record<string, unknown>>) : [];
  const words: SpeechmaticsWord[] = [];
  const speakers = new Set<string>();
  let text = "";

  for (const r of results) {
    const alternatives = Array.isArray(r.alternatives) ? (r.alternatives as Array<Record<string, unknown>>) : [];
    const alt = alternatives[0] ?? {};
    const content = String(alt.content ?? "");
    if (!content) continue;
    const speaker = alt.speaker ? String(alt.speaker) : null;
    if (speaker) speakers.add(speaker);
    const isPunct = String(r.type ?? "") === "punctuation";

    words.push({
      text: content,
      start_ms: Math.round(Number(r.start_time ?? 0) * 1000),
      end_ms: Math.round(Number(r.end_time ?? 0) * 1000),
      speaker,
      confidence: typeof alt.confidence === "number" ? (alt.confidence as number) : null,
      is_punctuation: isPunct,
    });

    if (isPunct || text === "") text += content;
    else text += " " + content;
  }

  const metadata = (msg.metadata ?? null) as Record<string, unknown> | null;
  const metaStart = metadata && typeof metadata.start_time === "number" ? metadata.start_time : null;
  const metaEnd = metadata && typeof metadata.end_time === "number" ? metadata.end_time : null;
  const start_ms = metaStart !== null ? Math.round(metaStart * 1000) : words[0]?.start_ms ?? 0;
  const end_ms = metaEnd !== null ? Math.round(metaEnd * 1000) : words[words.length - 1]?.end_ms ?? start_ms;

  // Prefer the server-provided transcript string when present; otherwise use the
  // reconstruction from results (the realtime format may omit the top-level string).
  const serverText = typeof msg.transcript === "string" ? (msg.transcript as string).trim() : "";

  return { is_partial: isPartial, text: serverText || text.trim(), words, start_ms, end_ms, speakers: [...speakers] };
}

/**
 * Open an outbound WebSocket to Speechmatics realtime (Cloudflare Workers handshake style:
 * fetch with Upgrade header → response.webSocket). The caller is responsible for accepting,
 * sending StartRecognition, streaming audio, and teardown (see realtime-asr-processor A1b).
 */
export async function openSpeechmaticsSocket(env: Env): Promise<WebSocket> {
  const apiKey = (env.SPEECHMATICS_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("SPEECHMATICS_API_KEY is missing");
  }
  const wsUrl = (env.SPEECHMATICS_WS_URL ?? SPEECHMATICS_DEFAULT_WS_URL).trim() || SPEECHMATICS_DEFAULT_WS_URL;
  // wss:// → https:// for the fetch-based upgrade handshake.
  const handshakeUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");

  const response = await fetch(handshakeUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Upgrade: "websocket",
    },
  });

  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`speechmatics websocket handshake failed: HTTP ${response.status}`);
  }
  return response.webSocket;
}
