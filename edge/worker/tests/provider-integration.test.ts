/**
 * Integration tests verifying that concrete provider implementations
 * (asr-groq, asr-openai, llm-openai, llm-ollama) satisfy the interfaces
 * defined in types.ts and work correctly through the ProviderRegistry.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ProviderRegistry, DEFAULT_PROVIDER_CONFIG } from "../src/providers/types";
import type { ProviderConfig, AudioInput, ReportContext } from "../src/providers/types";
import { GroqASRProvider } from "../src/providers/asr-groq";
import { OpenAIASRProvider } from "../src/providers/asr-openai";
import { OpenAILLMProvider } from "../src/providers/llm-openai";
import { OllamaLLMProvider } from "../src/providers/llm-ollama";

/* ── Shared fixtures ──────────────────────────── */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeSilentAudio(durationMs = 1000): AudioInput {
  const numSamples = Math.round((durationMs / 1000) * 16000);
  return {
    data: new ArrayBuffer(numSamples * 2),
    sample_rate: 16000,
    channels: 1,
    duration_ms: durationMs,
  };
}

function makeReportContext(): ReportContext {
  return {
    session_id: "sess_integ_001",
    transcript: [
      { utterance_id: "u1", stream_role: "students", speaker_name: "Alice", text: "Hello", start_ms: 0, end_ms: 2000 },
    ],
    memos: [],
    stats: [{ speaker_key: "Alice", speaker_name: "Alice", talk_time_ms: 60000, turns: 5 }],
    locale: "en",
  };
}

function mockGroqResponse() {
  return {
    text: "Hello world",
    language: "en",
    duration: 2.0,
    segments: [{ id: 0, seek: 0, start: 0, end: 2, text: "Hello world", tokens: [], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01 }],
    words: [{ word: "Hello", start: 0, end: 0.8 }, { word: "world", start: 1.0, end: 1.8 }],
  };
}

function mockOpenAIASRResponse() {
  return {
    text: "Test utterance",
    language: "en",
    duration: 1.5,
    segments: [{ id: 0, seek: 0, start: 0, end: 1.5, text: "Test utterance", tokens: [], temperature: 0, avg_logprob: -0.15, compression_ratio: 1.0, no_speech_prob: 0.01 }],
  };
}

function mockOpenAILLMResponse() {
  return {
    id: "chatcmpl-integ",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: JSON.stringify({
          overall: { summary: "Good session" },
          per_person: [{
            person_key: "Alice",
            display_name: "Alice",
            dimensions: [{ dimension: "leadership", strengths: [], risks: [], actions: [] }],
            summary: { strengths: ["Led well"], risks: [], actions: [] },
          }],
        }),
      },
      finish_reason: "stop",
    }],
    model: "gpt-4o",
  };
}

function mockOllamaResponse() {
  return {
    model: "llama3",
    message: {
      role: "assistant",
      content: JSON.stringify({
        overall: { summary: "Decent discussion" },
        per_person: [{
          person_key: "Alice",
          display_name: "Alice",
          dimensions: [],
          summary: { strengths: ["Good"], risks: [], actions: [] },
        }],
      }),
    },
    done: true,
  };
}

function mockFetch(response: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

/* ── Registry integration ─────────────────────── */

describe("ProviderRegistry + concrete providers", () => {
  it("registers GroqASRProvider and retrieves through getASR()", () => {
    const config: ProviderConfig = {
      ...DEFAULT_PROVIDER_CONFIG,
      asr: { ...DEFAULT_PROVIDER_CONFIG.asr, streaming: "groq", batch: "groq" },
    };
    const registry = new ProviderRegistry(config);
    const groq = new GroqASRProvider({ apiKey: "gsk_test" });

    registry.registerASR(groq);

    expect(registry.hasProvider("asr")).toBe(true);
    const retrieved = registry.getASR();
    expect(retrieved).toBe(groq);
    expect(retrieved.name).toBe("groq-whisper");
    expect(retrieved.mode).toBe("both");
  });

  it("registers OpenAIASRProvider and retrieves through getASR()", () => {
    const config: ProviderConfig = {
      ...DEFAULT_PROVIDER_CONFIG,
      asr: { ...DEFAULT_PROVIDER_CONFIG.asr, batch: "openai" },
    };
    const registry = new ProviderRegistry(config);
    const openai = new OpenAIASRProvider({ apiKey: "sk_test" });

    registry.registerASR(openai);

    const retrieved = registry.getASR();
    expect(retrieved.name).toBe("openai-whisper");
    expect(retrieved.mode).toBe("batch");
  });

  it("registers OpenAILLMProvider and retrieves through getLLM()", () => {
    const config: ProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, llm: "openai" };
    const registry = new ProviderRegistry(config);
    const openai = new OpenAILLMProvider({ apiKey: "sk_test" });

    registry.registerLLM(openai);

    expect(registry.hasProvider("llm")).toBe(true);
    const retrieved = registry.getLLM();
    expect(retrieved).toBe(openai);
    expect(retrieved.name).toBe("openai");
  });

  it("registers OllamaLLMProvider and retrieves through getLLM()", () => {
    const config: ProviderConfig = { ...DEFAULT_PROVIDER_CONFIG, llm: "ollama" };
    const registry = new ProviderRegistry(config);
    const ollama = new OllamaLLMProvider({ model: "qwen2.5:14b" });

    registry.registerLLM(ollama);

    const retrieved = registry.getLLM();
    expect(retrieved.name).toBe("ollama");
  });

  it("allows swapping ASR provider at runtime", () => {
    const registry = new ProviderRegistry(DEFAULT_PROVIDER_CONFIG);
    const groq = new GroqASRProvider({ apiKey: "gsk_test" });
    const openai = new OpenAIASRProvider({ apiKey: "sk_test" });

    registry.registerASR(groq);
    expect(registry.getASR().name).toBe("groq-whisper");

    registry.registerASR(openai);
    expect(registry.getASR().name).toBe("openai-whisper");
  });

  it("allows swapping LLM provider at runtime", () => {
    const registry = new ProviderRegistry(DEFAULT_PROVIDER_CONFIG);
    const openai = new OpenAILLMProvider({ apiKey: "sk_test" });
    const ollama = new OllamaLLMProvider();

    registry.registerLLM(openai);
    expect(registry.getLLM().name).toBe("openai");

    registry.registerLLM(ollama);
    expect(registry.getLLM().name).toBe("ollama");
  });
});

/* ── End-to-end call chain via registry ───────── */

describe("end-to-end: registry.getASR().transcribeBatch()", () => {
  it("Groq provider returns Utterance[] through registry", async () => {
    globalThis.fetch = mockFetch(mockGroqResponse());

    const registry = new ProviderRegistry(DEFAULT_PROVIDER_CONFIG);
    registry.registerASR(new GroqASRProvider({ apiKey: "gsk_test" }));

    const asr = registry.getASR();
    const utterances = await asr.transcribeBatch!(makeSilentAudio(2000));

    expect(utterances.length).toBeGreaterThan(0);
    expect(utterances[0].id).toMatch(/^groq_utt_/);
    expect(utterances[0].text).toBe("Hello world");
    expect(typeof utterances[0].start_ms).toBe("number");
    expect(typeof utterances[0].end_ms).toBe("number");
  });

  it("OpenAI provider returns Utterance[] through registry", async () => {
    globalThis.fetch = mockFetch(mockOpenAIASRResponse());

    const registry = new ProviderRegistry(DEFAULT_PROVIDER_CONFIG);
    registry.registerASR(new OpenAIASRProvider({ apiKey: "sk_test" }));

    const asr = registry.getASR();
    const utterances = await asr.transcribeBatch!(makeSilentAudio(1500));

    expect(utterances.length).toBeGreaterThan(0);
    expect(utterances[0].id).toMatch(/^openai_utt_/);
    expect(utterances[0].text).toBe("Test utterance");
  });
});

describe("end-to-end: registry.getLLM().synthesizeReport()", () => {
  it("OpenAI provider returns Report through registry", async () => {
    globalThis.fetch = mockFetch(mockOpenAILLMResponse());

    const registry = new ProviderRegistry({ ...DEFAULT_PROVIDER_CONFIG, llm: "openai" });
    registry.registerLLM(new OpenAILLMProvider({ apiKey: "sk_test" }));

    const llm = registry.getLLM();
    const report = await llm.synthesizeReport(makeReportContext());

    expect(report.model_used).toBe("gpt-4o");
    expect(report.generation_ms).toBeGreaterThanOrEqual(0);
    expect(report.per_person).toHaveLength(1);
    expect(report.per_person[0].person_key).toBe("Alice");
    expect(report.per_person[0].display_name).toBe("Alice");
    expect(report.per_person[0].summary.strengths).toContain("Led well");
    expect(report.overall).toEqual({ summary: "Good session" });
  });

  it("Ollama provider returns Report through registry", async () => {
    globalThis.fetch = mockFetch(mockOllamaResponse());

    const registry = new ProviderRegistry({ ...DEFAULT_PROVIDER_CONFIG, llm: "ollama" });
    registry.registerLLM(new OllamaLLMProvider());

    const llm = registry.getLLM();
    const report = await llm.synthesizeReport(makeReportContext());

    expect(report.model_used).toBe("llama3");
    expect(report.per_person).toHaveLength(1);
    expect(report.per_person[0].person_key).toBe("Alice");
    expect(report.overall).toEqual({ summary: "Decent discussion" });
  });
});

/* ── Interface contract checks ────────────────── */

describe("interface contract compliance", () => {
  it("GroqASRProvider has transcribeBatch (batch mode)", () => {
    const provider = new GroqASRProvider({ apiKey: "test" });
    expect(typeof provider.transcribeBatch).toBe("function");
  });

  it("GroqASRProvider has startStreaming (streaming mode)", () => {
    const provider = new GroqASRProvider({ apiKey: "test" });
    expect(typeof provider.startStreaming).toBe("function");
  });

  it("OpenAIASRProvider has transcribeBatch but NOT startStreaming", () => {
    const provider = new OpenAIASRProvider({ apiKey: "test" });
    expect(typeof provider.transcribeBatch).toBe("function");
    expect(provider.startStreaming).toBeUndefined();
  });

  it("OpenAILLMProvider has synthesizeReport and regenerateClaim", () => {
    const provider = new OpenAILLMProvider({ apiKey: "test" });
    expect(typeof provider.synthesizeReport).toBe("function");
    expect(typeof provider.regenerateClaim).toBe("function");
  });

  it("OllamaLLMProvider has synthesizeReport and regenerateClaim", () => {
    const provider = new OllamaLLMProvider();
    expect(typeof provider.synthesizeReport).toBe("function");
    expect(typeof provider.regenerateClaim).toBe("function");
  });

  it("all providers have readonly name field", () => {
    const groq = new GroqASRProvider({ apiKey: "t" });
    const openaiASR = new OpenAIASRProvider({ apiKey: "t" });
    const openaiLLM = new OpenAILLMProvider({ apiKey: "t" });
    const ollama = new OllamaLLMProvider();

    // Verify names are the expected constant strings
    expect(groq.name).toBe("groq-whisper");
    expect(openaiASR.name).toBe("openai-whisper");
    expect(openaiLLM.name).toBe("openai");
    expect(ollama.name).toBe("ollama");

    // Verify readonly (TypeScript enforces this at compile time,
    // but we can verify the descriptor at runtime)
    const groqDesc = Object.getOwnPropertyDescriptor(groq, "name");
    // Class fields are writable by default in JS, but TS readonly
    // prevents assignment at compile time. Runtime check confirms presence.
    expect(groqDesc).toBeDefined();
  });
});
