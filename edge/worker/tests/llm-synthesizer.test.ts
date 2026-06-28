import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSynthesisMessages,
  estimateTokens,
  parseSynthesisResponse,
  synthesizeReportInWorker,
  truncateTranscript,
  type ChatMessage,
} from "../src/services/llm-synthesizer";
import type { Env } from "../src/config";
import type {
  MemoItem,
  SpeakerStatItem,
  SynthesizeRequestPayload,
} from "../src/types_v2";

// ── Fixtures ────────────────────────────────────────────────────────────────

type Utterance = SynthesizeRequestPayload["transcript"][number];

function utt(over: Partial<Utterance> = {}): Utterance {
  const start = over.start_ms ?? 0;
  const end = over.end_ms ?? start + 1000;
  return {
    utterance_id: over.utterance_id ?? "u1",
    stream_role: over.stream_role ?? "students",
    speaker_name: over.speaker_name ?? "Alice",
    cluster_id: over.cluster_id ?? "c1",
    decision: over.decision ?? "auto",
    text: over.text ?? "hello world",
    start_ms: start,
    end_ms: end,
    duration_ms: over.duration_ms ?? end - start,
  };
}

function memo(over: Partial<MemoItem> = {}): MemoItem {
  return {
    memo_id: over.memo_id ?? "m1",
    created_at_ms: over.created_at_ms ?? 1000,
    author_role: "teacher",
    type: over.type ?? "observation",
    tags: over.tags ?? [],
    text: over.text ?? "candidate was confident",
    ...(over.stage ? { stage: over.stage } : {}),
  };
}

function stat(over: Partial<SpeakerStatItem> = {}): SpeakerStatItem {
  return {
    speaker_key: over.speaker_key ?? "Alice",
    speaker_name: over.speaker_name ?? "Alice",
    talk_time_ms: over.talk_time_ms ?? 5000,
    talk_time_pct: over.talk_time_pct ?? 50,
    turns: over.turns ?? 3,
    silence_ms: over.silence_ms ?? 0,
    interruptions: over.interruptions ?? 0,
    interrupted_by_others: over.interrupted_by_others ?? 0,
    binding_status: over.binding_status ?? "resolved",
  };
}

function payload(over: Partial<SynthesizeRequestPayload> = {}): SynthesizeRequestPayload {
  return {
    session_id: over.session_id ?? "sess-1",
    transcript: over.transcript ?? [
      utt({ utterance_id: "u1", text: "I led the design discussion", start_ms: 0 }),
      utt({ utterance_id: "u2", text: "we should consider scalability", start_ms: 2000 }),
    ],
    memos: over.memos ?? [memo({ memo_id: "m1", text: "strong leadership signal" })],
    free_form_notes: over.free_form_notes ?? null,
    evidence: over.evidence ?? [],
    stats: over.stats ?? [stat()],
    events: over.events ?? [],
    rubric: over.rubric ?? null,
    session_context: over.session_context ?? null,
    memo_speaker_bindings: over.memo_speaker_bindings ?? [],
    historical: over.historical ?? [],
    stages: over.stages ?? [],
    locale: over.locale ?? "en-US",
    name_aliases: over.name_aliases,
    stats_observations: over.stats_observations,
    deliverable: over.deliverable,
    want_summary: over.want_summary,
    want_cleaned_transcript: over.want_cleaned_transcript,
    personalize_to_notes: over.personalize_to_notes,
  };
}

// A well-formed LLM JSON response covering overall + per_person + summary + memo.
const WELL_FORMED = {
  overall: {
    narrative: "The candidate showed strong leadership throughout the interview.",
    narrative_evidence_refs: ["e_001"],
    key_findings: [
      { type: "strength", text: "Drove the discussion forward", evidence_refs: ["e_001"] },
      { type: "risk", text: "Occasionally interrupted peers", evidence_refs: [] },
    ],
  },
  per_person: [
    {
      person_key: "Alice",
      display_name: "Alice",
      dimensions: [
        {
          dimension: "leadership",
          label_zh: "领导力",
          score: 8.5,
          score_rationale: "Took initiative repeatedly.",
          strengths: [
            {
              claim_id: "c_Alice_leadership_01",
              text: "Led the design discussion.",
              evidence_refs: ["e_001"],
              confidence: 0.85,
              supporting_utterances: ["u1"],
            },
          ],
          risks: [],
          actions: [],
        },
      ],
      summary: {
        strengths: ["Clear leadership"],
        risks: ["Interrupting"],
        actions: ["Practice active listening"],
      },
    },
  ],
  summary: "A 30-minute interview where Alice led the team toward a scalable design.",
  personalized_memo: "You noted strong leadership — confirmed by Alice driving the design.",
};

// ── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates English by word count (~1.3/word)", () => {
    // 4 words → trunc(4 * 1.3) = 5
    expect(estimateTokens("one two three four")).toBe(5);
  });

  it("estimates Chinese-dominant text by char count (~1.5/char)", () => {
    // 4 CJK chars → trunc(4 * 1.5) = 6
    expect(estimateTokens("领导能力")).toBe(6);
  });
});

// ── truncateTranscript ───────────────────────────────────────────────────────

describe("truncateTranscript", () => {
  it("returns all utterances unchanged when under budget", () => {
    const t = [
      utt({ utterance_id: "u1", text: "short", start_ms: 0 }),
      utt({ utterance_id: "u2", text: "also short", start_ms: 1000 }),
    ];
    const { transcript, wasTruncated } = truncateTranscript(t, 1000);
    expect(wasTruncated).toBe(false);
    expect(transcript).toHaveLength(2);
    // returns a copy, not the same array reference
    expect(transcript).not.toBe(t);
  });

  it("bounds output token count when over budget", () => {
    // 20 utterances of ~10 English words each (~13 tokens) → ~260 tokens total.
    const big: Utterance[] = [];
    for (let i = 0; i < 20; i++) {
      big.push(
        utt({
          utterance_id: `u${i}`,
          speaker_name: `Speaker${i % 3}`,
          cluster_id: `c${i % 3}`,
          text: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
          start_ms: i * 1000,
        })
      );
    }
    const budget = 60;
    const total = big.reduce((sum, u) => sum + estimateTokens(u.text), 0);
    expect(total).toBeGreaterThan(budget); // precondition: actually over budget

    const { transcript, wasTruncated } = truncateTranscript(big, budget);
    expect(wasTruncated).toBe(true);
    expect(transcript.length).toBeLessThan(big.length);

    const keptTokens = transcript.reduce((sum, u) => sum + estimateTokens(u.text), 0);
    expect(keptTokens).toBeLessThanOrEqual(budget);
  });

  it("keeps the first utterance per speaker and re-sorts by start_ms", () => {
    const big: Utterance[] = [];
    for (let i = 0; i < 12; i++) {
      big.push(
        utt({
          utterance_id: `u${i}`,
          speaker_name: `S${i % 3}`, // 3 distinct speakers
          cluster_id: `c${i % 3}`,
          text: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
          start_ms: i * 1000,
        })
      );
    }
    const { transcript, wasTruncated } = truncateTranscript(big, 40);
    expect(wasTruncated).toBe(true);
    // First utterance for each of the 3 speakers must survive: u0, u1, u2.
    const ids = new Set(transcript.map((u) => u.utterance_id));
    expect(ids.has("u0")).toBe(true);
    expect(ids.has("u1")).toBe(true);
    expect(ids.has("u2")).toBe(true);
    // Output is sorted ascending by start_ms.
    const starts = transcript.map((u) => u.start_ms);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

// ── buildSynthesisMessages ───────────────────────────────────────────────────

describe("buildSynthesisMessages", () => {
  it("produces a system + user message pair", () => {
    const msgs: ChatMessage[] = buildSynthesisMessages(payload());
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[0].content.length).toBeGreaterThan(0);
    expect(msgs[1].content.length).toBeGreaterThan(0);
  });

  it("includes transcript text in the user message", () => {
    const msgs = buildSynthesisMessages(
      payload({
        transcript: [
          utt({ utterance_id: "u1", text: "scalability tradeoffs matter here", start_ms: 0 }),
        ],
      })
    );
    expect(msgs[1].content).toContain("scalability tradeoffs matter here");
    expect(msgs[1].content).toContain("u1");
  });

  it("includes memo text in the user message", () => {
    const msgs = buildSynthesisMessages(
      payload({
        memos: [memo({ memo_id: "m9", text: "displayed excellent ownership" })],
      })
    );
    expect(msgs[1].content).toContain("displayed excellent ownership");
    expect(msgs[1].content).toContain("m9");
  });

  it("includes free-form notes when present", () => {
    const msgs = buildSynthesisMessages(
      payload({ free_form_notes: "overall a promising hire candidate" })
    );
    expect(msgs[1].content).toContain("overall a promising hire candidate");
  });

  it("user message content is valid JSON with expected top-level keys", () => {
    const msgs = buildSynthesisMessages(payload());
    const parsed = JSON.parse(msgs[1].content) as Record<string, unknown>;
    expect(parsed.task).toBe("synthesize_report");
    expect(parsed.session_id).toBe("sess-1");
    expect(parsed).toHaveProperty("transcript_segments");
    expect(parsed).toHaveProperty("memos_with_bindings");
    expect(parsed).toHaveProperty("output_contract");
  });

  it("instructs the summary deliverable in the system prompt by default", () => {
    const msgs = buildSynthesisMessages(payload());
    expect(msgs[0].content).toContain("SUMMARY");
  });
});

// ── parseSynthesisResponse: well-formed ──────────────────────────────────────

describe("parseSynthesisResponse (well-formed)", () => {
  it("parses overall, per_person, summary, and personalized_memo", () => {
    const result = parseSynthesisResponse(JSON.stringify(WELL_FORMED));

    expect(result.overall.narrative).toContain("strong leadership");
    expect(result.overall.key_findings).toHaveLength(2);
    expect(result.overall.key_findings?.[0].type).toBe("strength");

    expect(result.per_person).toHaveLength(1);
    const person = result.per_person[0];
    expect(person.person_key).toBe("Alice");
    expect(person.display_name).toBe("Alice");
    expect(person.dimensions).toHaveLength(1);
    expect(person.dimensions[0].dimension).toBe("leadership");
    expect(person.dimensions[0].score).toBe(8.5);
    expect(person.dimensions[0].strengths[0].claim_id).toBe("c_Alice_leadership_01");
    expect(person.dimensions[0].strengths[0].evidence_refs).toEqual(["e_001"]);

    expect(result.summary).toBe(WELL_FORMED.summary);
    expect(result.personalized_memo).toBe(WELL_FORMED.personalized_memo);
  });

  it("clamps out-of-range scores and confidences into valid bounds", () => {
    const raw = {
      overall: { narrative: "n", key_findings: [] },
      per_person: [
        {
          person_key: "Bob",
          display_name: "Bob",
          dimensions: [
            {
              dimension: "logic",
              score: 99, // → clamp to 10
              score_rationale: "r",
              strengths: [
                { claim_id: "x", text: "t", evidence_refs: [], confidence: 5, supporting_utterances: [] },
              ],
              risks: [],
              actions: [],
            },
          ],
          summary: { strengths: [], risks: [], actions: [] },
        },
      ],
    };
    const result = parseSynthesisResponse(JSON.stringify(raw));
    expect(result.per_person[0].dimensions[0].score).toBe(10);
    expect(result.per_person[0].dimensions[0].strengths[0].confidence).toBe(1);
  });

  it("auto-generates a claim_id when the LLM omits one", () => {
    const raw = {
      overall: { narrative: "n", key_findings: [] },
      per_person: [
        {
          person_key: "Carol",
          display_name: "Carol",
          dimensions: [
            {
              dimension: "structure",
              score: 7,
              score_rationale: "r",
              strengths: [{ text: "well organized", evidence_refs: ["e_2"] }],
              risks: [],
              actions: [],
            },
          ],
          summary: { strengths: [], risks: [], actions: [] },
        },
      ],
    };
    const result = parseSynthesisResponse(JSON.stringify(raw));
    expect(result.per_person[0].dimensions[0].strengths[0].claim_id).toBe(
      "c_Carol_structure_01"
    );
  });

  it("parses a fenced ```json block correctly", () => {
    const fenced = "Here is the report:\n```json\n" + JSON.stringify(WELL_FORMED) + "\n```\nDone.";
    const result = parseSynthesisResponse(fenced);
    expect(result.per_person).toHaveLength(1);
    expect(result.per_person[0].person_key).toBe("Alice");
  });

  it("recovers JSON wrapped in leading/trailing prose (brace-slicing)", () => {
    const wrapped = "Sure! " + JSON.stringify(WELL_FORMED) + " Let me know if you need more.";
    const result = parseSynthesisResponse(wrapped);
    expect(result.per_person).toHaveLength(1);
    expect(result.overall.narrative).toContain("strong leadership");
  });
});

// ── parseSynthesisResponse: malformed / empty (safe defaults, no throw) ───────

describe("parseSynthesisResponse (malformed / empty)", () => {
  it("returns safe empty defaults for empty input", () => {
    const result = parseSynthesisResponse("");
    expect(result.per_person).toEqual([]);
    expect(result.overall.narrative).toBe("");
    expect(result.overall.key_findings).toEqual([]);
    expect(result.summary).toBeUndefined();
    expect(result.personalized_memo).toBeUndefined();
  });

  it("does not throw and returns defaults for non-JSON garbage", () => {
    expect(() => parseSynthesisResponse("this is not json at all {{{")).not.toThrow();
    const result = parseSynthesisResponse("this is not json at all {{{");
    expect(result.per_person).toEqual([]);
    expect(result.overall.narrative).toBe("");
  });

  it("returns defaults for a JSON array (not an object)", () => {
    const result = parseSynthesisResponse("[1, 2, 3]");
    expect(result.per_person).toEqual([]);
  });

  it("returns defaults for truncated / partial JSON", () => {
    const result = parseSynthesisResponse('{"overall": {"narrative": "incompl');
    expect(result.per_person).toEqual([]);
    expect(result.overall.narrative).toBe("");
  });

  it("tolerates an object missing per_person (defaults per_person to empty)", () => {
    const result = parseSynthesisResponse(
      JSON.stringify({ overall: { narrative: "only overall here", key_findings: [] } })
    );
    expect(result.overall.narrative).toBe("only overall here");
    expect(result.per_person).toEqual([]);
  });

  it("skips malformed per_person entries (missing person_key / wrong types)", () => {
    const raw = {
      overall: { narrative: "n", key_findings: [] },
      per_person: [
        null,
        "not an object",
        { display_name: "no key" }, // missing person_key → dropped
        { person_key: "Dave", display_name: "Dave", dimensions: "not-an-array", summary: {} },
      ],
    };
    const result = parseSynthesisResponse(JSON.stringify(raw));
    expect(result.per_person).toHaveLength(1);
    expect(result.per_person[0].person_key).toBe("Dave");
    expect(result.per_person[0].dimensions).toEqual([]);
  });

  it("normalizes invalid key_finding type to 'observation'", () => {
    const raw = {
      overall: {
        narrative: "n",
        key_findings: [{ type: "bogus", text: "something", evidence_refs: [] }],
      },
      per_person: [],
    };
    const result = parseSynthesisResponse(JSON.stringify(raw));
    expect(result.overall.key_findings?.[0].type).toBe("observation");
  });
});

// ── synthesizeReportInWorker (global fetch stubbed — no real network) ─────────

describe("synthesizeReportInWorker (fetch stubbed)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubFetchOnce(content: string, status = 200) {
    const fetchMock = vi.fn(async () => ({
      status,
      json: async () => ({ choices: [{ message: { content } }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const env = (): Env =>
    ({ ALIYUN_DASHSCOPE_API_KEY: "test-key" } as unknown as Env);

  it("returns the contract envelope on a well-formed LLM response", async () => {
    const fetchMock = stubFetchOnce(JSON.stringify(WELL_FORMED));
    const result = await synthesizeReportInWorker(env(), payload());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.backend_used).toBe("worker-dashscope");
    expect(result.degraded).toBe(false);
    expect(result.data.per_person).toHaveLength(1);
    expect(result.data.per_person[0].person_key).toBe("Alice");
    expect(result.data.quality?.report_source).toBe("llm_synthesized");
    expect(result.data.quality?.claim_count).toBe(1);
  });

  it("marks degraded=true when the LLM yields no per_person", async () => {
    stubFetchOnce(JSON.stringify({ overall: { narrative: "n", key_findings: [] }, per_person: [] }));
    const result = await synthesizeReportInWorker(env(), payload());
    expect(result.degraded).toBe(true);
    expect(result.warnings).toContain("llm_synthesis_no_per_person");
    expect(result.data.per_person).toEqual([]);
  });

  it("throws SynthesizerError when the API key is missing (no network call)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const noKeyEnv = {} as unknown as Env;
    await expect(synthesizeReportInWorker(noKeyEnv, payload())).rejects.toThrow(
      /API_KEY is required/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
