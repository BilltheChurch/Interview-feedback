import { describe, it, expect } from "vitest";
import { resolveTeacherIdentity } from "../src/speaker-helpers";
import { normalizeSessionState } from "../src/config";
import type { SessionState } from "../src/config";

/**
 * R1 regression: the teacher stream (interviewer microphone) must never be
 * resolved to a student roster member. The roster comes from
 * `teams_participants` and lists the candidates only — the interviewer is
 * tracked separately via `interviewer_name` / `teams_interviewer_name`.
 */

function stateWith(partial: Partial<SessionState>): SessionState {
  return normalizeSessionState({ ...partial });
}

describe("resolveTeacherIdentity", () => {
  it("does NOT resolve teacher to the sole student when no interviewer is configured (R1)", () => {
    const state = stateWith({
      roster: [{ name: "122" }],
      config: {},
    });
    const identity = resolveTeacherIdentity(state, "");
    expect(identity.speakerName).toBe("teacher");
    expect(identity.speakerName).not.toBe("122");
  });

  it("uses teams_interviewer_name when it matches a roster entry (no regression)", () => {
    const state = stateWith({
      roster: [{ name: "Alice" }, { name: "122" }],
      config: { teams_interviewer_name: "Alice" },
    });
    const identity = resolveTeacherIdentity(state, "");
    expect(identity.speakerName).toBe("Alice");
    expect(identity.identitySource).toBe("teams_participants");
  });

  it("uses interviewer_name when it matches a roster entry (no regression)", () => {
    const state = stateWith({
      roster: [{ name: "Alice" }, { name: "122" }],
      config: { interviewer_name: "Alice" },
    });
    const identity = resolveTeacherIdentity(state, "");
    expect(identity.speakerName).toBe("Alice");
    expect(identity.identitySource).toBe("teams_participants");
  });

  it("uses interviewer_name even when it is NOT in the roster (preconfig)", () => {
    const state = stateWith({
      roster: [{ name: "122" }],
      config: { interviewer_name: "Alice" },
    });
    const identity = resolveTeacherIdentity(state, "");
    expect(identity.speakerName).toBe("Alice");
    expect(identity.identitySource).toBe("preconfig");
  });

  it("falls back to teacher for a multi-person roster with no interviewer config", () => {
    const state = stateWith({
      roster: [{ name: "122" }, { name: "133" }],
      config: {},
    });
    const identity = resolveTeacherIdentity(state, "");
    expect(identity.speakerName).toBe("teacher");
  });
});
