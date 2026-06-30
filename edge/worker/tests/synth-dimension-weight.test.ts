import { describe, expect, it } from "vitest";
import {
  buildSynthesisMessages,
  getDimensionPresets,
} from "../src/services/llm-synthesizer";
import type {
  SpeakerStatItem,
  SynthesizeRequestPayload,
} from "../src/types_v2";

// ── Fixtures (minimal, mirrors llm-synthesizer.test.ts style) ────────────────

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
    transcript: over.transcript ?? [utt()],
    memos: over.memos ?? [],
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getDimensionPresets weight handling", () => {
  it("includes weight from session_context.dimension_presets (not stripped)", () => {
    const p = payload({
      session_context: {
        dimension_presets: [
          { key: "a", label_zh: "A", label_en: "A", description: "d", weight: 5 },
          { key: "b", label_zh: "B", label_en: "B", description: "d", weight: 1 },
        ],
      } as SynthesizeRequestPayload["session_context"],
    });

    const presets = getDimensionPresets(p);

    expect(presets).toHaveLength(2);
    expect(presets[0]).toMatchObject({ key: "a", weight: 5 });
    expect(presets[1]).toMatchObject({ key: "b", weight: 1 });
    // The weighted dimension must carry a defined numeric weight (was undefined/stripped before).
    expect(presets.map((d) => d.weight)).toEqual([5, 1]);
  });

  it("falls back label_zh to label_en for a custom dim with empty label_zh", () => {
    // A user-added custom dimension only sets label_en in the editor, leaving
    // label_zh "". The report's Chinese dimension label would otherwise be blank,
    // so getDimensionPresets must fall back to the English name (then key).
    const p = payload({
      session_context: {
        dimension_presets: [
          { key: "adaptability", label_zh: "", label_en: "Adaptability", description: "d", weight: 2 },
        ],
      } as SynthesizeRequestPayload["session_context"],
    });

    const presets = getDimensionPresets(p);
    expect(presets[0].label_zh).toBe("Adaptability");
  });

  it("falls back label_zh to key when both label_zh and label_en are empty", () => {
    const p = payload({
      session_context: {
        dimension_presets: [
          { key: "custom_xyz_abc123", label_zh: "", label_en: "", description: "d", weight: 1 },
        ],
      } as SynthesizeRequestPayload["session_context"],
    });

    const presets = getDimensionPresets(p);
    expect(presets[0].label_zh).toBe("custom_xyz_abc123");
  });

  it("keeps a non-empty preset label_zh unchanged (no fallback)", () => {
    const p = payload({
      session_context: {
        dimension_presets: [
          { key: "leadership", label_zh: "领导力", label_en: "Leadership", description: "d", weight: 1 },
        ],
      } as SynthesizeRequestPayload["session_context"],
    });

    const presets = getDimensionPresets(p);
    expect(presets[0].label_zh).toBe("领导力");
  });

  it("defaults weight to 1 when a preset omits it", () => {
    const p = payload({
      session_context: {
        dimension_presets: [
          // weight intentionally omitted to exercise the `?? 1` fallback.
          { key: "x", label_zh: "X", label_en: "X", description: "d" },
        ],
      } as unknown as SynthesizeRequestPayload["session_context"],
    });

    const presets = getDimensionPresets(p);
    expect(presets[0]).toMatchObject({ key: "x", weight: 1 });
  });

  it("falls back to the default 5 dimensions (each with a defined weight) when no presets", () => {
    const p = payload({ session_context: null });
    const presets = getDimensionPresets(p);

    expect(presets).toHaveLength(5);
    expect(presets.map((d) => d.key)).toEqual([
      "leadership",
      "collaboration",
      "logic",
      "structure",
      "initiative",
    ]);
    // Default weights must be defined (1), so the default path is unweighted but never undefined.
    for (const d of presets) {
      expect(typeof d.weight).toBe("number");
      expect(d.weight).toBe(1);
    }
  });
});

describe("system prompt weighting directive", () => {
  it("instructs the LLM to weight dimensions by their weight", () => {
    const messages = buildSynthesisMessages(payload());
    const system = messages.find((m) => m.role === "system")!.content;

    // weight is mentioned as a scoring concept.
    expect(system).toMatch(/weight/);
    // ...and it is explicitly tied to ranking / overall, not just present.
    expect(system).toMatch(/排名|ranking/);
    // ...and the per-dimension 0-10 scores are NOT scaled by weight (no-scaling guarantee).
    expect(system).toMatch(/绝不按 weight 缩放|不.*缩放/);
  });

  it("places weight into evaluation_dimensions in the user prompt JSON", () => {
    const p = payload({
      session_context: {
        dimension_presets: [
          { key: "a", label_zh: "A", label_en: "A", description: "d", weight: 5 },
          { key: "b", label_zh: "B", label_en: "B", description: "d", weight: 1 },
        ],
      } as SynthesizeRequestPayload["session_context"],
    });
    const messages = buildSynthesisMessages(p);
    const user = messages.find((m) => m.role === "user")!.content;

    expect(user).toContain("evaluation_dimensions");
    // promptData is serialized with compact JSON.stringify (no spaces).
    expect(user).toContain("\"weight\":5");
    expect(user).toContain("\"weight\":1");
    // The mapped objects under evaluation_dimensions carry weight, not just key/label/desc.
    const parsed = JSON.parse(user) as {
      evaluation_dimensions: Array<{ key: string; weight: number }>;
    };
    expect(parsed.evaluation_dimensions.map((d) => d.weight)).toEqual([5, 1]);
  });
});
