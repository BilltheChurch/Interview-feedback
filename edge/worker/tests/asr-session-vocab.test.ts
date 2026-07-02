import { describe, it, expect } from "vitest";
import { buildSessionVocab } from "../src/realtime-asr-processor";
import { SPEECHMATICS_ADDITIONAL_VOCAB_MAX } from "../src/config";
import type { SessionState } from "../src/config";

/**
 * R6-vocab — buildSessionVocab merges the static env vocab with per-session names
 * (roster names + aliases + interviewer) into one Speechmatics custom dictionary.
 * Pure function; the connect path degrades to static-only when state is unreadable.
 */

function makeState(overrides?: Partial<SessionState>): SessionState {
  return {
    config: {},
    roster: [],
    ...overrides,
  } as unknown as SessionState;
}

describe("buildSessionVocab (R6-vocab)", () => {
  it("merges static vocab with roster names, aliases, and the interviewer name", () => {
    const state = makeState({
      config: { interviewer_name: "Dr. Smith" } as SessionState["config"],
      roster: [
        { name: "Tina", aliases: ["Kenny Tan"] },
        { name: "Stephanie" },
      ] as SessionState["roster"],
    });
    const vocab = buildSessionVocab(state, [{ content: "Imperial College London" }]);
    // Session names (interviewer + roster + aliases) come FIRST; static domain vocab last,
    // so the cap can never evict a roster name in favor of a static term.
    expect(vocab).toEqual([
      { content: "Dr. Smith" },
      { content: "Tina" },
      { content: "Kenny Tan" },
      { content: "Stephanie" },
      { content: "Imperial College London" },
    ]);
  });

  it("keeps roster names at the cap even against a full static list (R6 review fix)", () => {
    const state = makeState({
      roster: [{ name: "Kenny Tan" }, { name: "Stephanie" }] as SessionState["roster"],
    });
    const staticVocab = Array.from(
      { length: SPEECHMATICS_ADDITIONAL_VOCAB_MAX + 50 },
      (_, i) => ({ content: `static-${i}` })
    );
    const vocab = buildSessionVocab(state, staticVocab);
    expect(vocab).toHaveLength(SPEECHMATICS_ADDITIONAL_VOCAB_MAX);
    const contents = vocab.map((v) => v.content);
    expect(contents).toContain("Kenny Tan");
    expect(contents).toContain("Stephanie");
    // The two roster names are at the front — static domain words filled the rest.
    expect(contents.slice(0, 2)).toEqual(["Kenny Tan", "Stephanie"]);
  });

  it("dedupes case-insensitively across static and session sources", () => {
    const state = makeState({
      roster: [{ name: "imperial college london" }] as SessionState["roster"],
    });
    const vocab = buildSessionVocab(state, [{ content: "Imperial College London" }]);
    expect(vocab).toHaveLength(1);
  });

  it("drops single-code-point contents (one CJK char / one letter is noise)", () => {
    const state = makeState({
      roster: [{ name: "王" }, { name: "李明" }] as SessionState["roster"],
    });
    const vocab = buildSessionVocab(state, [{ content: "a" }]);
    expect(vocab).toEqual([{ content: "李明" }]);
  });

  it("survives malformed state shapes without throwing (defensive coercion)", () => {
    const state = makeState({
      config: { interviewer_name: 42, teams_interviewer_name: null } as unknown as SessionState["config"],
      roster: [
        null,
        { name: 7 },
        { name: "OK Name", aliases: "not-an-array" },
        { name: "Alias Guy", aliases: [null, "  ", "Real Alias"] },
      ] as unknown as SessionState["roster"],
    });
    const vocab = buildSessionVocab(state, []);
    expect(vocab).toEqual([{ content: "OK Name" }, { content: "Alias Guy" }, { content: "Real Alias" }]);
  });

  it("preserves sounds_like from static entries and caps the total", () => {
    const staticVocab = [
      { content: "UCAS", sounds_like: ["you cass"] },
      ...Array.from({ length: SPEECHMATICS_ADDITIONAL_VOCAB_MAX + 10 }, (_, i) => ({ content: `word-${i}` })),
    ];
    const vocab = buildSessionVocab(makeState(), staticVocab);
    expect(vocab[0]).toEqual({ content: "UCAS", sounds_like: ["you cass"] });
    expect(vocab).toHaveLength(SPEECHMATICS_ADDITIONAL_VOCAB_MAX);
  });

  it("returns [] for an empty state with no static vocab (field then omitted upstream)", () => {
    expect(buildSessionVocab(makeState(), [])).toEqual([]);
  });
});
