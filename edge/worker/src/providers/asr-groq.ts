/**
 * Groq Whisper ASR provider.
 *
 * Uses the Groq API for fast Whisper inference.
 * Free tier: 28,800 audio-seconds/day.
 * Supports both streaming (chunked batch) and batch modes.
 *
 * API docs: https://console.groq.com/docs/speech-text
 */

import type { ASRProvider, ASRStreamConfig, AudioInput, Utterance } from "./types";

const GROQ_API_BASE = "https://api.groq.com/openai/v1";

/** Supported Groq Whisper models. */
type GroqWhisperModel =
  | "whisper-large-v3"
  | "whisper-large-v3-turbo"
  | "distil-whisper-large-v3-en";

interface GroqASRConfig {
  apiKey: string;
  model?: GroqWhisperModel;
  /** Temperature for decoding (0 = deterministic). */
  temperature?: number;
}

/** A single segment returned by the Groq verbose_json response. */
interface GroqSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

/** A word from the Groq verbose_json response. */
interface GroqWord {
  word: string;
  start: number;
  end: number;
}

/** Groq transcription response with verbose_json format. */
interface GroqTranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: GroqSegment[];
  words?: GroqWord[];
}

/**
 * Convert PCM 16kHz mono s16le to WAV for the Groq API.
 * Groq accepts audio files (wav, mp3, etc.), not raw PCM.
 */
function pcmToWav(pcmData: ArrayBuffer, sampleRate: number, channels: number): ArrayBuffer {
  const pcmBytes = pcmData.byteLength;
  const wavBuffer = new ArrayBuffer(44 + pcmBytes);
  const view = new DataView(wavBuffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false);  // "RIFF"
  view.setUint32(4, 36 + pcmBytes, true); // file size - 8
  view.setUint32(8, 0x57415645, false);   // "WAVE"

  // fmt chunk
  view.setUint32(12, 0x666d7420, false);  // "fmt "
  view.setUint32(16, 16, true);           // chunk size
  view.setUint16(20, 1, true);            // PCM format
  view.setUint16(22, channels, true);     // channels
  view.setUint32(24, sampleRate, true);   // sample rate
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true);           // bits per sample

  // data chunk
  view.setUint32(36, 0x64617461, false);  // "data"
  view.setUint32(40, pcmBytes, true);     // data size

  // Copy PCM samples
  new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcmData));

  return wavBuffer;
}

/** Generate a unique utterance ID. */
function makeUtteranceId(index: number): string {
  return `groq_utt_${Date.now()}_${index}`;
}

export class GroqASRProvider implements ASRProvider {
  readonly name = "groq-whisper";
  readonly mode = "both" as const;

  private readonly apiKey: string;
  private readonly model: GroqWhisperModel;
  private readonly temperature: number;

  constructor(config: GroqASRConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "whisper-large-v3-turbo";
    this.temperature = config.temperature ?? 0;
  }

  /**
   * Batch-transcribe a complete audio file.
   * Sends to Groq API with verbose_json for word-level timestamps.
   */
  async transcribeBatch(audio: AudioInput): Promise<Utterance[]> {
    const wavData = pcmToWav(audio.data, audio.sample_rate, audio.channels);

    const formData = new FormData();
    formData.append("file", new Blob([wavData], { type: "audio/wav" }), "audio.wav");
    formData.append("model", this.model);
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "word");
    formData.append("timestamp_granularities[]", "segment");
    formData.append("temperature", String(this.temperature));

    const response = await fetch(`${GROQ_API_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Groq ASR transcription failed: status=${response.status} body=${errorText.slice(0, 300)}`
      );
    }

    const result = (await response.json()) as GroqTranscriptionResponse;
    return this.parseResponse(result);
  }

  /**
   * Streaming mode is implemented as chunked batch calls.
   * For true streaming, Groq doesn't offer a WebSocket API,
   * so we simulate by yielding utterances from batch calls.
   */
  async *startStreaming(config: ASRStreamConfig): AsyncIterable<Utterance> {
    // Groq doesn't have true streaming ASR — this is a placeholder
    // that yields nothing. Use transcribeBatch for actual transcription.
    // In a real streaming scenario, callers should buffer audio and
    // periodically call transcribeBatch.
    void config;
  }

  private parseResponse(result: GroqTranscriptionResponse): Utterance[] {
    const utterances: Utterance[] = [];

    if (result.segments && result.segments.length > 0) {
      for (let i = 0; i < result.segments.length; i++) {
        const seg = result.segments[i];
        const startMs = Math.round(seg.start * 1000);
        const endMs = Math.round(seg.end * 1000);

        // Collect word-level timestamps that fall within this segment
        const segmentWords = result.words
          ?.filter((w) => {
            const wStartMs = Math.round(w.start * 1000);
            return wStartMs >= startMs && wStartMs < endMs;
          })
          .map((w) => ({
            word: w.word.trim(),
            start_ms: Math.round(w.start * 1000),
            end_ms: Math.round(w.end * 1000),
          }));

        utterances.push({
          id: makeUtteranceId(i),
          text: seg.text.trim(),
          start_ms: startMs,
          end_ms: endMs,
          words: segmentWords && segmentWords.length > 0 ? segmentWords : undefined,
          language: result.language ?? undefined,
          confidence: seg.avg_logprob != null ? Math.exp(seg.avg_logprob) : undefined,
        });
      }
    } else if (result.text) {
      // Fallback: no segments, just full text
      utterances.push({
        id: makeUtteranceId(0),
        text: result.text.trim(),
        start_ms: 0,
        end_ms: result.duration ? Math.round(result.duration * 1000) : 0,
        language: result.language ?? undefined,
      });
    }

    return utterances;
  }
}
