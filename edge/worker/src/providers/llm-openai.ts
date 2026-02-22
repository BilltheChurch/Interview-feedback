/**
 * OpenAI LLM provider for report synthesis.
 *
 * Uses the OpenAI Chat Completions API to generate interview feedback reports.
 * Supports GPT-4o, GPT-4o-mini, and other OpenAI chat models.
 *
 * API docs: https://platform.openai.com/docs/api-reference/chat/create
 */

import type { Claim, LLMProvider, Report, ReportContext } from "./types";

const OPENAI_API_BASE = "https://api.openai.com/v1";

type OpenAIChatModel = "gpt-4o" | "gpt-4o-mini" | "gpt-4-turbo" | "gpt-3.5-turbo" | (string & {});

interface OpenAILLMConfig {
  apiKey: string;
  model?: OpenAIChatModel;
  /** Maximum tokens for the response. */
  maxTokens?: number;
  /** Temperature (0 = deterministic, higher = more creative). */
  temperature?: number;
  /** Base URL override (for Azure OpenAI or proxies). */
  baseUrl?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Build the system prompt for interview feedback report synthesis.
 * Instructs the model to produce structured JSON matching the Report interface.
 */
function buildSystemPrompt(locale: string): string {
  const lang = locale.startsWith("zh") ? "Chinese" : "English";
  return `You are an expert interview feedback analyst. Analyze the transcript, memos, and speaker statistics to produce a structured feedback report.

Output ONLY valid JSON matching this schema (no markdown, no code blocks):
{
  "overall": {
    "summary": "string — 2-3 sentence overall assessment",
    "highlights": ["string — key positive moments"],
    "concerns": ["string — areas needing improvement"]
  },
  "per_person": [
    {
      "person_key": "string — speaker identifier from stats",
      "display_name": "string — speaker name",
      "dimensions": [
        {
          "dimension": "leadership" | "collaboration" | "logic" | "structure" | "initiative",
          "strengths": [{ "claim_id": "str", "text": "claim text", "evidence_refs": [], "confidence": 0.8 }],
          "risks": [{ "claim_id": "str", "text": "risk text", "evidence_refs": [], "confidence": 0.7 }],
          "actions": [{ "claim_id": "str", "text": "action text", "evidence_refs": [], "confidence": 0.8 }]
        }
      ],
      "summary": {
        "strengths": ["string"],
        "risks": ["string"],
        "actions": ["string"]
      }
    }
  ]
}

Rules:
- Evaluate each speaker on all 5 dimensions: leadership, collaboration, logic, structure, initiative
- Write feedback in ${lang}
- Ground claims in specific transcript evidence where possible
- Generate claim_id values as "clm_" + dimension initial + sequential number (e.g. "clm_l1", "clm_c1")
- Exclude the "teacher" speaker (interviewer) from per_person feedback
- If a speaker has minimal contributions, note it but still provide feedback on visible dimensions`;
}

/**
 * Build the user message containing the session context.
 */
function buildUserMessage(context: ReportContext): string {
  const parts: string[] = [];

  parts.push("## Transcript");
  for (const item of context.transcript) {
    const speaker = item.speaker_name ?? item.stream_role;
    const timeStr = `[${formatMs(item.start_ms)}-${formatMs(item.end_ms)}]`;
    parts.push(`${timeStr} ${speaker}: ${item.text}`);
  }

  if (context.memos.length > 0) {
    parts.push("\n## Interviewer Memos");
    for (const memo of context.memos) {
      const tags = memo.tags.length > 0 ? ` [${memo.tags.join(", ")}]` : "";
      parts.push(`- (${memo.type}${tags}) ${memo.text}`);
    }
  }

  parts.push("\n## Speaker Statistics");
  for (const stat of context.stats) {
    const name = stat.speaker_name ?? stat.speaker_key;
    const talkMin = (stat.talk_time_ms / 60000).toFixed(1);
    parts.push(`- ${name}: ${talkMin}min talk time, ${stat.turns} turns`);
  }

  return parts.join("\n");
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/**
 * Parse the LLM response into a Report object.
 * Handles both clean JSON and JSON wrapped in markdown code blocks.
 */
function parseReportResponse(content: string, modelUsed: string, generationMs: number): Report {
  // Strip markdown code blocks if present
  let jsonStr = content.trim();
  if (jsonStr.startsWith("```")) {
    const firstNewline = jsonStr.indexOf("\n");
    const lastFence = jsonStr.lastIndexOf("```");
    if (firstNewline !== -1 && lastFence > firstNewline) {
      jsonStr = jsonStr.slice(firstNewline + 1, lastFence).trim();
    }
  }

  const parsed = JSON.parse(jsonStr) as {
    overall?: unknown;
    per_person?: Array<{
      person_key: string;
      display_name: string;
      dimensions: unknown[];
      summary: { strengths: string[]; risks: string[]; actions: string[] };
    }>;
  };

  return {
    overall: parsed.overall ?? {},
    per_person: (parsed.per_person ?? []).map((p) => ({
      person_key: p.person_key,
      display_name: p.display_name,
      dimensions: p.dimensions,
      summary: p.summary ?? { strengths: [], risks: [], actions: [] },
    })),
    model_used: modelUsed,
    generation_ms: generationMs,
  };
}

export class OpenAILLMProvider implements LLMProvider {
  readonly name = "openai";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly baseUrl: string;

  constructor(config: OpenAILLMConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-4o";
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.3;
    this.baseUrl = (config.baseUrl ?? OPENAI_API_BASE).replace(/\/$/, "");
  }

  async synthesizeReport(context: ReportContext): Promise<Report> {
    const startTime = Date.now();

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(context.locale) },
      { role: "user", content: buildUserMessage(context) },
    ];

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI LLM synthesis failed: status=${response.status} body=${errorText.slice(0, 300)}`
      );
    }

    const result = (await response.json()) as OpenAIChatResponse;
    const content = result.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI LLM returned empty response");
    }

    const generationMs = Date.now() - startTime;
    return parseReportResponse(content, result.model ?? this.model, generationMs);
  }

  async regenerateClaim(claim: Claim, context: ReportContext): Promise<Claim> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are an interview feedback analyst. Regenerate the following claim with improved evidence and confidence. Output ONLY valid JSON matching: { "claim_id": "string", "text": "string", "evidence_refs": ["string"], "confidence": number }`,
      },
      {
        role: "user",
        content: JSON.stringify({
          current_claim: claim,
          transcript: context.transcript.slice(0, 50), // Limit context size
          memos: context.memos,
        }),
      },
    ];

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: 512,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI claim regeneration failed: status=${response.status} body=${errorText.slice(0, 300)}`
      );
    }

    const result = (await response.json()) as OpenAIChatResponse;
    const content = result.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI LLM returned empty response for claim regeneration");
    }

    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      const firstNl = jsonStr.indexOf("\n");
      const lastFence = jsonStr.lastIndexOf("```");
      if (firstNl !== -1 && lastFence > firstNl) {
        jsonStr = jsonStr.slice(firstNl + 1, lastFence).trim();
      }
    }

    return JSON.parse(jsonStr) as Claim;
  }
}
