/**
 * OpenAI Whisper ASR provider.
 *
 * Uses the OpenAI Audio Transcription API (batch only).
 * Cost: $0.006 per minute of audio.
 * Word-level timestamps via verbose_json response format.
 *
 * API docs: https://platform.openai.com/docs/api-reference/audio/createTranscription
 */

import type { ASRProvider, AudioInput, Utterance } from "./types";

const OPENAI_API_BASE = "https://api.openai.com/v1";

/** Supported OpenAI Whisper models. */
type OpenAIWhisperModel = "whisper-1" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe";

interface OpenAIASRConfig {
  apiKey: string;
  model?: OpenAIWhisperModel;
  /** Temperature for decoding (0 = deterministic). */
  temperature?: number;
}

/** A single segment from the OpenAI verbose_json response. */
interface OpenAISegment {
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

/** A word from the OpenAI verbose_json response. */
interface OpenAIWord {
  word: string;
  start: number;
  end: number;
}

/** OpenAI transcription response with verbose_json format. */
interface OpenAITranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: OpenAISegment[];
  words?: OpenAIWord[];
}

/**
 * Convert PCM 16kHz mono s16le to WAV.
 * OpenAI accepts audio files (wav, mp3, etc.), not raw PCM.
 */
function pcmToWav(pcmData: ArrayBuffer, sampleRate: number, channels: number): ArrayBuffer {
  const pcmBytes = pcmData.byteLength;
  const wavBuffer = new ArrayBuffer(44 + pcmBytes);
  const view = new DataView(wavBuffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false);  // "RIFF"
  view.setUint32(4, 36 + pcmBytes, true);
  view.setUint32(8, 0x57415645, false);   // "WAVE"

  // fmt chunk
  view.setUint32(12, 0x666d7420, false);  // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);

  // data chunk
  view.setUint32(36, 0x64617461, false);  // "data"
  view.setUint32(40, pcmBytes, true);

  new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcmData));

  return wavBuffer;
}

function makeUtteranceId(index: number): string {
  return `openai_utt_${Date.now()}_${index}`;
}

export class OpenAIASRProvider implements ASRProvider {
  readonly name = "openai-whisper";
  readonly mode = "batch" as const;

  private readonly apiKey: string;
  private readonly model: OpenAIWhisperModel;
  private readonly temperature: number;

  constructor(config: OpenAIASRConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "whisper-1";
    this.temperature = config.temperature ?? 0;
  }

  /**
   * Batch-transcribe a complete audio file using OpenAI's Audio API.
   * Returns utterances with word-level timestamps when available.
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

    const response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI ASR transcription failed: status=${response.status} body=${errorText.slice(0, 300)}`
      );
    }

    const result = (await response.json()) as OpenAITranscriptionResponse;
    return this.parseResponse(result);
  }

  private parseResponse(result: OpenAITranscriptionResponse): Utterance[] {
    const utterances: Utterance[] = [];

    if (result.segments && result.segments.length > 0) {
      for (let i = 0; i < result.segments.length; i++) {
        const seg = result.segments[i];
        const startMs = Math.round(seg.start * 1000);
        const endMs = Math.round(seg.end * 1000);

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
