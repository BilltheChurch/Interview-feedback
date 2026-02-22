import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAILLMProvider } from "../src/providers/llm-openai";
import { OllamaLLMProvider } from "../src/providers/llm-ollama";
import type { Claim, ReportContext } from "../src/providers/types";

/* ── Helpers ──────────────────────────────────── */

function makeReportContext(overrides?: Partial<ReportContext>): ReportContext {
  return {
    session_id: "sess_test_001",
    transcript: [
      {
        utterance_id: "u1",
        stream_role: "teacher",
        speaker_name: "Interviewer",
        text: "Let's begin. Please introduce yourselves.",
        start_ms: 0,
        end_ms: 3000,
      },
      {
        utterance_id: "u2",
        stream_role: "students",
        speaker_name: "Alice",
        text: "Hi, I'm Alice. I think we should start with the market analysis.",
        start_ms: 3500,
        end_ms: 7000,
      },
      {
        utterance_id: "u3",
        stream_role: "students",
        speaker_name: "Bob",
        text: "I agree with Alice. Let me add some data points.",
        start_ms: 7500,
        end_ms: 11000,
      },
    ],
    memos: [
      {
        memo_id: "m1",
        text: "Alice showed strong leadership in structuring the discussion",
        type: "observation",
        tags: ["leadership"],
      },
    ],
    stats: [
      { speaker_key: "Alice", speaker_name: "Alice", talk_time_ms: 120000, turns: 15 },
      { speaker_key: "Bob", speaker_name: "Bob", talk_time_ms: 90000, turns: 12 },
    ],
    locale: "en",
    ...overrides,
  };
}

/** A valid report JSON that the LLM might return. */
function makeValidReportJson(): string {
  return JSON.stringify({
    overall: {
      summary: "Good group discussion with clear structure.",
      highlights: ["Strong leadership from Alice"],
      concerns: ["Bob could contribute more proactively"],
    },
    per_person: [
      {
        person_key: "Alice",
        display_name: "Alice",
        dimensions: [
          {
            dimension: "leadership",
            strengths: [
              { claim_id: "clm_l1", text: "Led the discussion effectively", evidence_refs: ["u2"], confidence: 0.85 },
            ],
            risks: [
              { claim_id: "clm_l2", text: "Could delegate more", evidence_refs: [], confidence: 0.6 },
            ],
            actions: [
              { claim_id: "clm_l3", text: "Try asking others to lead sections", evidence_refs: [], confidence: 0.7 },
            ],
          },
        ],
        summary: {
          strengths: ["Strong leadership"],
          risks: ["Could delegate more"],
          actions: ["Practice delegation"],
        },
      },
    ],
  });
}

function makeValidClaimJson(): string {
  return JSON.stringify({
    claim_id: "clm_l1_regen",
    text: "Regenerated claim with better evidence",
    evidence_refs: ["u2", "u3"],
    confidence: 0.92,
  });
}

let lastFetchCall: { url: string; init: RequestInit } | null = null;

function mockFetchWithResponse(body: unknown, status = 200) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    lastFetchCall = { url, init: init ?? {} };
    return new Response(JSON.stringify(body), {
      status,
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

/* ── OpenAILLMProvider ────────────────────────── */

describe("OpenAILLMProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    lastFetchCall = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    const provider = new OpenAILLMProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("openai");
  });

  it("calls OpenAI chat completions endpoint", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o-2025-01-06",
    });

    const provider = new OpenAILLMProvider({ apiKey: "sk-test" });
    await provider.synthesizeReport(makeReportContext());

    expect(lastFetchCall).not.toBeNull();
    expect(lastFetchCall!.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("sends correct authorization header", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({ apiKey: "sk-secretkey" });
    await provider.synthesizeReport(makeReportContext());

    const headers = JSON.parse(lastFetchCall!.init.body as string);
    expect((lastFetchCall!.init.headers as Record<string, string>)?.Authorization).toBe("Bearer sk-secretkey");
    // Verify model in request body
    expect(headers.model).toBe("gpt-4o");
  });

  it("uses custom model when specified", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o-mini",
    });

    const provider = new OpenAILLMProvider({ apiKey: "test", model: "gpt-4o-mini" });
    await provider.synthesizeReport(makeReportContext());

    const body = JSON.parse(lastFetchCall!.init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("parses report response correctly", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({ apiKey: "test" });
    const report = await provider.synthesizeReport(makeReportContext());

    expect(report.model_used).toBe("gpt-4o");
    expect(report.generation_ms).toBeGreaterThanOrEqual(0);
    expect(report.per_person).toHaveLength(1);
    expect(report.per_person[0].person_key).toBe("Alice");
    expect(report.per_person[0].display_name).toBe("Alice");
    expect(report.per_person[0].summary.strengths).toContain("Strong leadership");
    expect(report.overall).toBeDefined();
  });

  it("handles JSON wrapped in markdown code blocks", async () => {
    const reportJson = "```json\n" + makeValidReportJson() + "\n```";
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({ apiKey: "test" });
    const report = await provider.synthesizeReport(makeReportContext());

    expect(report.per_person).toHaveLength(1);
    expect(report.per_person[0].person_key).toBe("Alice");
  });

  it("sends json_object response format", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({ apiKey: "test" });
    await provider.synthesizeReport(makeReportContext());

    const body = JSON.parse(lastFetchCall!.init.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("includes transcript, memos, and stats in user message", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({ apiKey: "test" });
    await provider.synthesizeReport(makeReportContext());

    const body = JSON.parse(lastFetchCall!.init.body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toContain("## Transcript");
    expect(userMessage).toContain("Alice");
    expect(userMessage).toContain("## Interviewer Memos");
    expect(userMessage).toContain("## Speaker Statistics");
    expect(userMessage).toContain("2.0min talk time");
  });

  it("uses Chinese in system prompt for zh locale", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({ apiKey: "test" });
    await provider.synthesizeReport(makeReportContext({ locale: "zh-CN" }));

    const body = JSON.parse(lastFetchCall!.init.body as string);
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toContain("Chinese");
  });

  it("throws on API error", async () => {
    globalThis.fetch = mockFetchError(500, "Internal Server Error");

    const provider = new OpenAILLMProvider({ apiKey: "test" });
    await expect(provider.synthesizeReport(makeReportContext())).rejects.toThrow(
      /OpenAI LLM synthesis failed.*status=500/
    );
  });

  it("throws on empty response", async () => {
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({ apiKey: "test" });
    await expect(provider.synthesizeReport(makeReportContext())).rejects.toThrow(
      /empty response/
    );
  });

  it("supports custom baseUrl for Azure or proxies", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: reportJson }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({
      apiKey: "test",
      baseUrl: "https://my-proxy.example.com/v1/",
    });
    await provider.synthesizeReport(makeReportContext());

    expect(lastFetchCall!.url).toBe("https://my-proxy.example.com/v1/chat/completions");
  });

  it("regenerateClaim calls API with claim context", async () => {
    const claimJson = makeValidClaimJson();
    globalThis.fetch = mockFetchWithResponse({
      id: "chatcmpl-456",
      choices: [{ index: 0, message: { role: "assistant", content: claimJson }, finish_reason: "stop" }],
      model: "gpt-4o",
    });

    const provider = new OpenAILLMProvider({ apiKey: "test" });
    const claim: Claim = {
      claim_id: "clm_l1",
      text: "Original claim",
      evidence_refs: ["u2"],
      confidence: 0.7,
    };

    const result = await provider.regenerateClaim(claim, makeReportContext());

    expect(result.claim_id).toBe("clm_l1_regen");
    expect(result.confidence).toBe(0.92);
    expect(result.evidence_refs).toContain("u2");
    expect(result.evidence_refs).toContain("u3");
  });
});

/* ── OllamaLLMProvider ────────────────────────── */

describe("OllamaLLMProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    lastFetchCall = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    const provider = new OllamaLLMProvider();
    expect(provider.name).toBe("ollama");
  });

  it("uses default localhost URL and llama3 model", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: reportJson },
      done: true,
    });

    const provider = new OllamaLLMProvider();
    await provider.synthesizeReport(makeReportContext());

    expect(lastFetchCall!.url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(lastFetchCall!.init.body as string);
    expect(body.model).toBe("llama3");
  });

  it("uses custom baseUrl and model", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      model: "qwen2.5:14b",
      message: { role: "assistant", content: reportJson },
      done: true,
    });

    const provider = new OllamaLLMProvider({
      baseUrl: "http://gpu-server:11434",
      model: "qwen2.5:14b",
    });
    await provider.synthesizeReport(makeReportContext());

    expect(lastFetchCall!.url).toBe("http://gpu-server:11434/api/chat");
    const body = JSON.parse(lastFetchCall!.init.body as string);
    expect(body.model).toBe("qwen2.5:14b");
  });

  it("sends stream: false for non-streaming inference", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: reportJson },
      done: true,
    });

    const provider = new OllamaLLMProvider();
    await provider.synthesizeReport(makeReportContext());

    const body = JSON.parse(lastFetchCall!.init.body as string);
    expect(body.stream).toBe(false);
    expect(body.format).toBe("json");
  });

  it("parses report response correctly", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: reportJson },
      done: true,
    });

    const provider = new OllamaLLMProvider();
    const report = await provider.synthesizeReport(makeReportContext());

    expect(report.model_used).toBe("llama3");
    expect(report.generation_ms).toBeGreaterThanOrEqual(0);
    expect(report.per_person).toHaveLength(1);
    expect(report.per_person[0].person_key).toBe("Alice");
  });

  it("handles JSON wrapped in code blocks", async () => {
    const reportJson = "```json\n" + makeValidReportJson() + "\n```";
    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: reportJson },
      done: true,
    });

    const provider = new OllamaLLMProvider();
    const report = await provider.synthesizeReport(makeReportContext());

    expect(report.per_person).toHaveLength(1);
  });

  it("does not send Authorization header (local server)", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: reportJson },
      done: true,
    });

    const provider = new OllamaLLMProvider();
    await provider.synthesizeReport(makeReportContext());

    const headers = lastFetchCall!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws on API error", async () => {
    globalThis.fetch = mockFetchError(500, "model not found");

    const provider = new OllamaLLMProvider();
    await expect(provider.synthesizeReport(makeReportContext())).rejects.toThrow(
      /Ollama LLM synthesis failed.*status=500/
    );
  });

  it("throws on empty response", async () => {
    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: "" },
      done: true,
    });

    const provider = new OllamaLLMProvider();
    await expect(provider.synthesizeReport(makeReportContext())).rejects.toThrow(
      /empty response/
    );
  });

  it("sends temperature in options field", async () => {
    const reportJson = makeValidReportJson();
    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: reportJson },
      done: true,
    });

    const provider = new OllamaLLMProvider({ temperature: 0.5 });
    await provider.synthesizeReport(makeReportContext());

    const body = JSON.parse(lastFetchCall!.init.body as string);
    expect(body.options.temperature).toBe(0.5);
  });

  it("regenerateClaim calls Ollama API", async () => {
    const claimJson = makeValidClaimJson();
    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: claimJson },
      done: true,
    });

    const provider = new OllamaLLMProvider();
    const claim: Claim = {
      claim_id: "clm_l1",
      text: "Original claim",
      evidence_refs: ["u2"],
      confidence: 0.7,
    };

    const result = await provider.regenerateClaim(claim, makeReportContext());

    expect(result.claim_id).toBe("clm_l1_regen");
    expect(result.confidence).toBe(0.92);
    expect(lastFetchCall!.url).toBe("http://localhost:11434/api/chat");
  });

  it("handles missing summary in per_person with defaults", async () => {
    const jsonWithoutSummary = JSON.stringify({
      overall: { summary: "Test" },
      per_person: [
        {
          person_key: "Alice",
          display_name: "Alice",
          dimensions: [],
          // summary intentionally missing
        },
      ],
    });

    globalThis.fetch = mockFetchWithResponse({
      model: "llama3",
      message: { role: "assistant", content: jsonWithoutSummary },
      done: true,
    });

    const provider = new OllamaLLMProvider();
    const report = await provider.synthesizeReport(makeReportContext());

    expect(report.per_person[0].summary).toEqual({
      strengths: [],
      risks: [],
      actions: [],
    });
  });
});

/* ── Provider registration compatibility ──────── */

describe("LLM providers work with ProviderRegistry", () => {
  it("OpenAI provider implements LLMProvider interface", () => {
    const provider = new OpenAILLMProvider({ apiKey: "test" });
    expect(provider.name).toBe("openai");
    expect(typeof provider.synthesizeReport).toBe("function");
    expect(typeof provider.regenerateClaim).toBe("function");
  });

  it("Ollama provider implements LLMProvider interface", () => {
    const provider = new OllamaLLMProvider();
    expect(provider.name).toBe("ollama");
    expect(typeof provider.synthesizeReport).toBe("function");
    expect(typeof provider.regenerateClaim).toBe("function");
  });
});
