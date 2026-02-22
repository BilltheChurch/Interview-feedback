import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GroqASRProvider } from "../src/providers/asr-groq";
import { OpenAIASRProvider } from "../src/providers/asr-openai";
import type { AudioInput } from "../src/providers/types";

/* ── Helpers ──────────────────────────────────── */

/** Create a minimal PCM audio input (1 second of silence at 16kHz mono). */
function makeSilentAudio(durationMs: number = 1000): AudioInput {
  const sampleRate = 16000;
  const channels = 1;
  const numSamples = Math.round((durationMs / 1000) * sampleRate * channels);
  return {
    data: new ArrayBuffer(numSamples * 2), // 16-bit PCM = 2 bytes per sample
    sample_rate: sampleRate,
    channels,
    duration_ms: durationMs,
  };
}

/** Build a mock Groq/OpenAI verbose_json transcription response. */
function makeTranscriptionResponse(opts?: {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
  }>;
  words?: Array<{ word: string; start: number; end: number }>;
}) {
  return {
    text: opts?.text ?? "Hello world",
    language: opts?.language ?? "en",
    duration: opts?.duration ?? 2.0,
    segments: opts?.segments ?? [
      {
        id: 0,
        seek: 0,
        start: 0.0,
        end: 1.2,
        text: "Hello",
        tokens: [1, 2],
        temperature: 0,
        avg_logprob: -0.3,
        compression_ratio: 1.2,
        no_speech_prob: 0.01,
      },
      {
        id: 1,
        seek: 0,
        start: 1.2,
        end: 2.0,
        text: "world",
        tokens: [3, 4],
        temperature: 0,
        avg_logprob: -0.2,
        compression_ratio: 1.1,
        no_speech_prob: 0.02,
      },
    ],
    words: opts?.words ?? [
      { word: "Hello", start: 0.0, end: 0.8 },
      { word: "world", start: 1.2, end: 1.9 },
    ],
  };
}

/** Capture the last fetch call for assertion. */
let lastFetchCall: { url: string; init: RequestInit } | null = null;

function mockFetchSuccess(responseBody: unknown) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    lastFetchCall = { url, init: init ?? {} };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function mockFetchError(status: number, body: string) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    lastFetchCall = { url, init: init ?? {} };
    return new Response(body, { status });
  });
}

/* ── GroqASRProvider ──────────────────────────── */

describe("GroqASRProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    lastFetchCall = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name and mode", () => {
    const provider = new GroqASRProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("groq-whisper");
    expect(provider.mode).toBe("both");
  });

  it("calls Groq API with correct URL and auth header", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new GroqASRProvider({ apiKey: "gsk_test123" });
    await provider.transcribeBatch(makeSilentAudio());

    expect(lastFetchCall).not.toBeNull();
    expect(lastFetchCall!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((lastFetchCall!.init.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer gsk_test123"
    );
  });

  it("sends FormData with model and response_format", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new GroqASRProvider({
      apiKey: "test-key",
      model: "whisper-large-v3",
    });
    await provider.transcribeBatch(makeSilentAudio());

    // Verify that body is FormData
    expect(lastFetchCall!.init.body).toBeInstanceOf(FormData);
    const formData = lastFetchCall!.init.body as FormData;
    expect(formData.get("model")).toBe("whisper-large-v3");
    expect(formData.get("response_format")).toBe("verbose_json");
  });

  it("parses segments into utterances", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new GroqASRProvider({ apiKey: "test-key" });
    const utterances = await provider.transcribeBatch(makeSilentAudio(2000));

    expect(utterances).toHaveLength(2);
    expect(utterances[0].text).toBe("Hello");
    expect(utterances[0].start_ms).toBe(0);
    expect(utterances[0].end_ms).toBe(1200);
    expect(utterances[0].language).toBe("en");

    expect(utterances[1].text).toBe("world");
    expect(utterances[1].start_ms).toBe(1200);
    expect(utterances[1].end_ms).toBe(2000);
  });

  it("includes word-level timestamps in utterances", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new GroqASRProvider({ apiKey: "test-key" });
    const utterances = await provider.transcribeBatch(makeSilentAudio(2000));

    // "Hello" word falls in first segment [0, 1200ms]
    expect(utterances[0].words).toBeDefined();
    expect(utterances[0].words).toHaveLength(1);
    expect(utterances[0].words![0].word).toBe("Hello");
    expect(utterances[0].words![0].start_ms).toBe(0);
    expect(utterances[0].words![0].end_ms).toBe(800);

    // "world" word falls in second segment [1200, 2000ms]
    expect(utterances[1].words).toBeDefined();
    expect(utterances[1].words).toHaveLength(1);
    expect(utterances[1].words![0].word).toBe("world");
  });

  it("computes confidence from avg_logprob", async () => {
    const response = makeTranscriptionResponse({
      segments: [
        {
          id: 0,
          start: 0,
          end: 1,
          text: "Test",
          avg_logprob: -0.5,
        },
      ],
    });
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new GroqASRProvider({ apiKey: "test-key" });
    const utterances = await provider.transcribeBatch(makeSilentAudio());

    expect(utterances[0].confidence).toBeCloseTo(Math.exp(-0.5), 5);
  });

  it("falls back to text-only when no segments", async () => {
    const response = makeTranscriptionResponse({
      text: "Fallback text",
      segments: undefined as unknown as Array<{ id: number; start: number; end: number; text: string }>,
      words: undefined as unknown as Array<{ word: string; start: number; end: number }>,
      duration: 3.5,
    });
    // Override to remove segments/words
    (response as Record<string, unknown>).segments = undefined;
    (response as Record<string, unknown>).words = undefined;
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new GroqASRProvider({ apiKey: "test-key" });
    const utterances = await provider.transcribeBatch(makeSilentAudio(3500));

    expect(utterances).toHaveLength(1);
    expect(utterances[0].text).toBe("Fallback text");
    expect(utterances[0].start_ms).toBe(0);
    expect(utterances[0].end_ms).toBe(3500);
  });

  it("throws on API error", async () => {
    globalThis.fetch = mockFetchError(429, '{"error": "rate limit"}');

    const provider = new GroqASRProvider({ apiKey: "test-key" });
    await expect(provider.transcribeBatch(makeSilentAudio())).rejects.toThrow(
      /Groq ASR transcription failed.*status=429/
    );
  });

  it("uses default model whisper-large-v3-turbo", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new GroqASRProvider({ apiKey: "test-key" });
    await provider.transcribeBatch(makeSilentAudio());

    const formData = lastFetchCall!.init.body as FormData;
    expect(formData.get("model")).toBe("whisper-large-v3-turbo");
  });

  it("startStreaming yields no utterances (placeholder)", async () => {
    const provider = new GroqASRProvider({ apiKey: "test-key" });
    const utterances: unknown[] = [];
    for await (const u of provider.startStreaming({ language: "en", sample_rate: 16000 })) {
      utterances.push(u);
    }
    expect(utterances).toHaveLength(0);
  });
});

/* ── OpenAIASRProvider ────────────────────────── */

describe("OpenAIASRProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    lastFetchCall = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name and mode", () => {
    const provider = new OpenAIASRProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("openai-whisper");
    expect(provider.mode).toBe("batch");
  });

  it("calls OpenAI API with correct URL and auth header", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new OpenAIASRProvider({ apiKey: "sk-test123" });
    await provider.transcribeBatch(makeSilentAudio());

    expect(lastFetchCall).not.toBeNull();
    expect(lastFetchCall!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((lastFetchCall!.init.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer sk-test123"
    );
  });

  it("sends FormData with correct model", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new OpenAIASRProvider({
      apiKey: "test-key",
      model: "gpt-4o-transcribe",
    });
    await provider.transcribeBatch(makeSilentAudio());

    const formData = lastFetchCall!.init.body as FormData;
    expect(formData.get("model")).toBe("gpt-4o-transcribe");
  });

  it("uses default model whisper-1", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new OpenAIASRProvider({ apiKey: "test-key" });
    await provider.transcribeBatch(makeSilentAudio());

    const formData = lastFetchCall!.init.body as FormData;
    expect(formData.get("model")).toBe("whisper-1");
  });

  it("parses segments with word timestamps", async () => {
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new OpenAIASRProvider({ apiKey: "test-key" });
    const utterances = await provider.transcribeBatch(makeSilentAudio(2000));

    expect(utterances).toHaveLength(2);
    expect(utterances[0].text).toBe("Hello");
    expect(utterances[0].start_ms).toBe(0);
    expect(utterances[0].end_ms).toBe(1200);
    expect(utterances[0].words).toHaveLength(1);
    expect(utterances[0].words![0].word).toBe("Hello");
  });

  it("throws on API error with error detail", async () => {
    globalThis.fetch = mockFetchError(401, '{"error": {"message": "invalid api key"}}');

    const provider = new OpenAIASRProvider({ apiKey: "bad-key" });
    await expect(provider.transcribeBatch(makeSilentAudio())).rejects.toThrow(
      /OpenAI ASR transcription failed.*status=401/
    );
  });

  it("does not have startStreaming method", () => {
    const provider = new OpenAIASRProvider({ apiKey: "test-key" });
    // batch-only provider should not have startStreaming
    expect(provider.startStreaming).toBeUndefined();
  });

  it("handles empty segments with text-only fallback", async () => {
    const response = {
      text: "Single utterance fallback",
      language: "zh",
      duration: 5.0,
    };
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new OpenAIASRProvider({ apiKey: "test-key" });
    const utterances = await provider.transcribeBatch(makeSilentAudio(5000));

    expect(utterances).toHaveLength(1);
    expect(utterances[0].text).toBe("Single utterance fallback");
    expect(utterances[0].language).toBe("zh");
    expect(utterances[0].end_ms).toBe(5000);
  });
});

/* ── WAV header validation ────────────────────── */

describe("PCM to WAV conversion", () => {
  it("produces valid WAV file with correct header", async () => {
    // We test indirectly by verifying the FormData file has audio/wav type
    const response = makeTranscriptionResponse();
    globalThis.fetch = mockFetchSuccess(response);

    const provider = new GroqASRProvider({ apiKey: "test-key" });
    await provider.transcribeBatch(makeSilentAudio(1000));

    const formData = lastFetchCall!.init.body as FormData;
    const file = formData.get("file") as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe("audio/wav");

    // Read the WAV header
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);

    // RIFF magic
    expect(view.getUint32(0, false)).toBe(0x52494646);
    // WAVE magic
    expect(view.getUint32(8, false)).toBe(0x57415645);
    // fmt chunk
    expect(view.getUint32(12, false)).toBe(0x666d7420);
    // PCM format = 1
    expect(view.getUint16(20, true)).toBe(1);
    // Mono
    expect(view.getUint16(22, true)).toBe(1);
    // 16kHz
    expect(view.getUint32(24, true)).toBe(16000);
    // 16-bit
    expect(view.getUint16(34, true)).toBe(16);
    // data chunk
    expect(view.getUint32(36, false)).toBe(0x64617461);

    // PCM data size = 16000 samples * 2 bytes = 32000
    expect(view.getUint32(40, true)).toBe(32000);
    // Total WAV size = 44 header + 32000 data
    expect(buffer.byteLength).toBe(44 + 32000);
  });
});
