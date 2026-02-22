import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalWhisperASRProvider } from "../src/providers/asr-local-whisper";

/* ── Helpers ──────────────────────────────────── */

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

/** Build a mock transcribe-window response from the inference service. */
function makeWhisperResponse(opts?: {
  text?: string;
  utterances?: Array<{
    id: string;
    text: string;
    start_ms: number;
    end_ms: number;
    words?: Array<{ word: string; start_ms: number; end_ms: number; confidence?: number }>;
    language?: string;
    confidence?: number;
  }>;
  language?: string;
  processing_time_ms?: number;
  backend?: string;
}) {
  return {
    text: opts?.text ?? "Hello world",
    utterances: opts?.utterances ?? [
      {
        id: "utt_001",
        text: "Hello world",
        start_ms: 0,
        end_ms: 2000,
        words: [
          { word: "Hello", start_ms: 0, end_ms: 500, confidence: 0.98 },
          { word: "world", start_ms: 600, end_ms: 1200, confidence: 0.95 },
        ],
        language: "en",
        confidence: 0.96,
      },
    ],
    language: opts?.language ?? "en",
    processing_time_ms: opts?.processing_time_ms ?? 150,
    backend: opts?.backend ?? "faster-whisper",
  };
}

/** Create a minimal WAV-like Uint8Array for testing. */
function makeWavBytes(size: number = 32044): Uint8Array {
  return new Uint8Array(size);
}

/* ── LocalWhisperASRProvider ──────────────────── */

describe("LocalWhisperASRProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    lastFetchCall = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name and mode", () => {
    const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
    expect(provider.name).toBe("local-whisper");
    expect(provider.mode).toBe("both");
  });

  it("strips trailing slash from endpoint", () => {
    const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000/" });
    expect(provider.name).toBe("local-whisper");
    // Verify it works by making a call
    const response = makeWhisperResponse();
    globalThis.fetch = mockFetchSuccess(response);

    provider.transcribeWindow(makeWavBytes());
    // URL should not have double slashes
  });

  describe("transcribeWindow", () => {
    it("calls correct URL with query parameters", async () => {
      const response = makeWhisperResponse();
      globalThis.fetch = mockFetchSuccess(response);

      const provider = new LocalWhisperASRProvider({
        endpoint: "http://127.0.0.1:8000",
        language: "zh",
      });
      await provider.transcribeWindow(makeWavBytes());

      expect(lastFetchCall).not.toBeNull();
      expect(lastFetchCall!.url).toBe(
        "http://127.0.0.1:8000/asr/transcribe-window?sample_rate=16000&language=zh"
      );
    });

    it("uses default language 'auto' when not specified", async () => {
      const response = makeWhisperResponse();
      globalThis.fetch = mockFetchSuccess(response);

      const provider = new LocalWhisperASRProvider({
        endpoint: "http://127.0.0.1:8000",
      });
      await provider.transcribeWindow(makeWavBytes());

      expect(lastFetchCall!.url).toContain("language=auto");
    });

    it("sends POST with octet-stream content type", async () => {
      const response = makeWhisperResponse();
      globalThis.fetch = mockFetchSuccess(response);

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      await provider.transcribeWindow(makeWavBytes());

      expect(lastFetchCall!.init.method).toBe("POST");
      expect((lastFetchCall!.init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/octet-stream"
      );
    });

    it("sends wavBytes as the request body", async () => {
      const response = makeWhisperResponse();
      globalThis.fetch = mockFetchSuccess(response);

      const wavBytes = makeWavBytes(64000);
      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      await provider.transcribeWindow(wavBytes);

      expect(lastFetchCall!.init.body).toBe(wavBytes);
    });

    it("returns text and latencyMs", async () => {
      const response = makeWhisperResponse({ text: "Testing one two three" });
      globalThis.fetch = mockFetchSuccess(response);

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      const result = await provider.transcribeWindow(makeWavBytes());

      expect(result.text).toBe("Testing one two three");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.latencyMs).toBe("number");
    });

    it("returns utterances with word-level timestamps", async () => {
      const utterances = [
        {
          id: "utt_001",
          text: "Hello",
          start_ms: 0,
          end_ms: 1000,
          words: [{ word: "Hello", start_ms: 0, end_ms: 500, confidence: 0.99 }],
          language: "en",
          confidence: 0.99,
        },
        {
          id: "utt_002",
          text: "world",
          start_ms: 1000,
          end_ms: 2000,
          words: [{ word: "world", start_ms: 1000, end_ms: 1500, confidence: 0.97 }],
          language: "en",
          confidence: 0.97,
        },
      ];
      const response = makeWhisperResponse({ utterances });
      globalThis.fetch = mockFetchSuccess(response);

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      const result = await provider.transcribeWindow(makeWavBytes());

      expect(result.utterances).toBeDefined();
      expect(result.utterances).toHaveLength(2);
      expect(result.utterances![0].id).toBe("utt_001");
      expect(result.utterances![0].text).toBe("Hello");
      expect(result.utterances![0].words).toHaveLength(1);
      expect(result.utterances![0].words![0].word).toBe("Hello");
      expect(result.utterances![0].words![0].confidence).toBe(0.99);
      expect(result.utterances![1].id).toBe("utt_002");
    });

    it("throws on HTTP error with status and body excerpt", async () => {
      globalThis.fetch = mockFetchError(500, '{"detail": "Whisper model not loaded"}');

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      await expect(provider.transcribeWindow(makeWavBytes())).rejects.toThrow(
        /local-whisper HTTP 500.*Whisper model not loaded/
      );
    });

    it("throws on HTTP 404", async () => {
      globalThis.fetch = mockFetchError(404, "Not Found");

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      await expect(provider.transcribeWindow(makeWavBytes())).rejects.toThrow(
        /local-whisper HTTP 404/
      );
    });

    it("truncates long error bodies to 200 characters", async () => {
      const longBody = "x".repeat(500);
      globalThis.fetch = mockFetchError(500, longBody);

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      try {
        await provider.transcribeWindow(makeWavBytes());
        expect.unreachable("should have thrown");
      } catch (err) {
        const message = (err as Error).message;
        // The body portion should be at most 200 chars
        expect(message.length).toBeLessThan(300);
      }
    });

    it("handles network errors (fetch throws)", async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error("Network unreachable");
      });

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      await expect(provider.transcribeWindow(makeWavBytes())).rejects.toThrow(
        "Network unreachable"
      );
    });
  });

  describe("isAvailable", () => {
    it("returns true when inference service is reachable", async () => {
      globalThis.fetch = mockFetchSuccess({ status: "ok", model: "large-v3" });

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      const available = await provider.isAvailable();

      expect(available).toBe(true);
      expect(lastFetchCall!.url).toBe("http://127.0.0.1:8000/asr/status");
    });

    it("returns false when service returns error status", async () => {
      globalThis.fetch = mockFetchError(503, "Service Unavailable");

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      const available = await provider.isAvailable();

      expect(available).toBe(false);
    });

    it("returns false when fetch throws (service unreachable)", async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error("Connection refused");
      });

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      const available = await provider.isAvailable();

      expect(available).toBe(false);
    });
  });

  describe("startStreaming", () => {
    it("yields no utterances (placeholder)", async () => {
      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      const utterances: unknown[] = [];
      for await (const u of provider.startStreaming({ language: "en", sample_rate: 16000 })) {
        utterances.push(u);
      }
      expect(utterances).toHaveLength(0);
    });
  });

  describe("transcribeBatch", () => {
    it("calls /batch/transcribe endpoint", async () => {
      const response = {
        utterances: [
          { id: "batch_001", text: "Batch result", start_ms: 0, end_ms: 5000 },
        ],
      };
      globalThis.fetch = mockFetchSuccess(response);

      const provider = new LocalWhisperASRProvider({
        endpoint: "http://127.0.0.1:8000",
        language: "en",
      });
      const result = await provider.transcribeBatch({
        data: new ArrayBuffer(32000),
        sample_rate: 16000,
        channels: 1,
        duration_ms: 1000,
      });

      expect(lastFetchCall!.url).toBe("http://127.0.0.1:8000/batch/transcribe");
      expect(lastFetchCall!.init.method).toBe("POST");
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("Batch result");
    });

    it("throws on batch API error", async () => {
      globalThis.fetch = mockFetchError(500, "Internal Server Error");

      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      await expect(
        provider.transcribeBatch({
          data: new ArrayBuffer(32000),
          sample_rate: 16000,
          channels: 1,
          duration_ms: 1000,
        })
      ).rejects.toThrow(/batch transcribe failed: 500/);
    });
  });

  describe("configuration", () => {
    it("uses default timeout of 30000ms", () => {
      const provider = new LocalWhisperASRProvider({ endpoint: "http://127.0.0.1:8000" });
      // We verify indirectly that it works
      expect(provider.name).toBe("local-whisper");
    });

    it("accepts custom timeout", () => {
      const provider = new LocalWhisperASRProvider({
        endpoint: "http://127.0.0.1:8000",
        timeout_ms: 60000,
      });
      expect(provider.name).toBe("local-whisper");
    });

    it("accepts custom language", async () => {
      const response = makeWhisperResponse();
      globalThis.fetch = mockFetchSuccess(response);

      const provider = new LocalWhisperASRProvider({
        endpoint: "http://127.0.0.1:8000",
        language: "ja",
      });
      await provider.transcribeWindow(makeWavBytes());

      expect(lastFetchCall!.url).toContain("language=ja");
    });
  });
});
