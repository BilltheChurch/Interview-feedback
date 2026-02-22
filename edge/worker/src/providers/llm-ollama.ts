/**
 * Ollama LLM provider for report synthesis.
 *
 * Connects to a local Ollama instance for fully offline LLM inference.
 * Works with any Ollama model (llama3, qwen2.5, mistral, etc.).
 *
 * API docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import type { Claim, LLMProvider, Report, ReportContext } from "./types";

const DEFAULT_OLLAMA_BASE = "http://localhost:11434";

interface OllamaLLMConfig {
  /** Ollama server base URL. Defaults to http://localhost:11434. */
  baseUrl?: string;
  /** Model name as configured in Ollama (e.g. "llama3", "qwen2.5:14b"). */
  model?: string;
  /** Temperature (0 = deterministic). */
  temperature?: number;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/**
 * Build the system prompt for interview feedback report synthesis.
 * Same structure as the OpenAI provider for consistency.
 */
function buildSystemPrompt(locale: string): string {
  const lang = locale.startsWith("zh") ? "Chinese" : "English";
  return `You are an expert interview feedback analyst. Analyze the transcript, memos, and speaker statistics to produce a structured feedback report.

Output ONLY valid JSON matching this schema (no markdown, no code blocks, no explanations):
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

export class OllamaLLMProvider implements LLMProvider {
  readonly name = "ollama";

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(config?: OllamaLLMConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_OLLAMA_BASE).replace(/\/$/, "");
    this.model = config?.model ?? "llama3";
    this.temperature = config?.temperature ?? 0.3;
    this.timeoutMs = config?.timeoutMs ?? 120_000;
  }

  async synthesizeReport(context: ReportContext): Promise<Report> {
    const startTime = Date.now();

    const messages: OllamaChatMessage[] = [
      { role: "system", content: buildSystemPrompt(context.locale) },
      { role: "user", content: buildUserMessage(context) },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          format: "json",
          options: {
            temperature: this.temperature,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Ollama LLM synthesis failed: status=${response.status} body=${errorText.slice(0, 300)}`
        );
      }

      const result = (await response.json()) as OllamaChatResponse;
      const content = result.message?.content;
      if (!content) {
        throw new Error("Ollama LLM returned empty response");
      }

      const generationMs = Date.now() - startTime;
      return parseReportResponse(content, result.model ?? this.model, generationMs);
    } finally {
      clearTimeout(timer);
    }
  }

  async regenerateClaim(claim: Claim, context: ReportContext): Promise<Claim> {
    const messages: OllamaChatMessage[] = [
      {
        role: "system",
        content: `You are an interview feedback analyst. Regenerate the following claim with improved evidence and confidence. Output ONLY valid JSON matching: { "claim_id": "string", "text": "string", "evidence_refs": ["string"], "confidence": number }`,
      },
      {
        role: "user",
        content: JSON.stringify({
          current_claim: claim,
          transcript: context.transcript.slice(0, 50),
          memos: context.memos,
        }),
      },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          format: "json",
          options: { temperature: 0.2 },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Ollama claim regeneration failed: status=${response.status} body=${errorText.slice(0, 300)}`
        );
      }

      const result = (await response.json()) as OllamaChatResponse;
      const content = result.message?.content;
      if (!content) {
        throw new Error("Ollama LLM returned empty response for claim regeneration");
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
    } finally {
      clearTimeout(timer);
    }
  }
}
