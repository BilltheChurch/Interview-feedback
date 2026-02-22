/**
 * Local Whisper ASR provider.
 * Calls the inference service's /asr/transcribe-window endpoint.
 * Runs Whisper on local GPU (MPS/CUDA) for high-quality transcription.
 */
import type { ASRProvider, ASRStreamConfig, Utterance, AudioInput } from "./types";

export interface LocalWhisperConfig {
  /** Base URL of the inference service (e.g., "http://127.0.0.1:8000") */
  endpoint: string;
  /** Language hint */
  language?: string;
  /** Request timeout in ms */
  timeout_ms?: number;
  /** API key for authenticating with the inference service */
  apiKey?: string;
}

export class LocalWhisperASRProvider implements ASRProvider {
  readonly name = "local-whisper";
  readonly mode = "both" as const;

  private endpoint: string;
  private language: string;
  private timeout_ms: number;
  private apiKey: string;

  constructor(config: LocalWhisperConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.language = config.language ?? "auto";
    this.timeout_ms = config.timeout_ms ?? 30000;
    this.apiKey = config.apiKey ?? "";
  }

  /**
   * Transcribe a single audio window by calling the local inference service.
   * This is the primary method used during recording.
   */
  async transcribeWindow(wavBytes: Uint8Array): Promise<{
    text: string;
    latencyMs: number;
    utterances?: Array<{
      id: string;
      text: string;
      start_ms: number;
      end_ms: number;
      words?: Array<{ word: string; start_ms: number; end_ms: number; confidence?: number }>;
      language?: string;
      confidence?: number;
    }>;
  }> {
    const url = `${this.endpoint}/asr/transcribe-window?sample_rate=16000&language=${this.language}`;
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout_ms);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
      if (this.apiKey) headers["x-api-key"] = this.apiKey;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: wavBytes,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`local-whisper HTTP ${resp.status}: ${body.slice(0, 200)}`);
      }

      const data = await resp.json() as {
        text: string;
        utterances: Array<{
          id: string; text: string; start_ms: number; end_ms: number;
          words?: Array<{ word: string; start_ms: number; end_ms: number; confidence?: number }>;
          language?: string; confidence?: number;
        }>;
        language: string;
        processing_time_ms: number;
        backend: string;
      };

      return {
        text: data.text,
        latencyMs: Date.now() - startedAt,
        utterances: data.utterances,
      };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /** Check if the local Whisper service is available. */
  async isAvailable(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers["x-api-key"] = this.apiKey;
      const resp = await fetch(`${this.endpoint}/asr/status`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ASRProvider interface methods (for ProviderRegistry compatibility)
  async *startStreaming(_config: ASRStreamConfig): AsyncIterable<Utterance> {
    // Streaming is handled window-by-window via transcribeWindow()
    // This is a no-op for interface compatibility
  }

  async transcribeBatch(audio: AudioInput): Promise<Utterance[]> {
    // For batch mode, call /batch/transcribe instead
    const url = `${this.endpoint}/batch/transcribe`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: "inline",
        language: this.language,
      }),
    });
    if (!resp.ok) throw new Error(`batch transcribe failed: ${resp.status}`);
    const data = await resp.json() as { utterances: Utterance[] };
    return data.utterances;
  }
}
