import { describe, it, expect, vi } from "vitest";
import { isInferenceEnabled, resolveInferencePrimaryBaseUrl, type Env } from "../src/config";
import { invokeInferenceAnalysisEvents, type InferenceCallContext } from "../src/inference-helpers";
import type { InferenceFailoverClient } from "../src/inference_client";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { INFERENCE_BASE_URL: "", ...overrides } as Env;
}

describe("isInferenceEnabled", () => {
  it("explicit false/0/no/off disables even when a base URL is set", () => {
    for (const v of ["false", "0", "no", "off", "FALSE", " Off "]) {
      expect(
        isInferenceEnabled(makeEnv({ INFERENCE_ENABLED: v, INFERENCE_BASE_URL: "https://x" }))
      ).toBe(false);
    }
  });

  it("explicit true/1 enables even without a base URL", () => {
    expect(isInferenceEnabled(makeEnv({ INFERENCE_ENABLED: "true", INFERENCE_BASE_URL: "" }))).toBe(true);
    expect(isInferenceEnabled(makeEnv({ INFERENCE_ENABLED: "1", INFERENCE_BASE_URL: "" }))).toBe(true);
  });

  it("when unset, enabled only if a base URL is configured", () => {
    expect(isInferenceEnabled(makeEnv({ INFERENCE_BASE_URL: "https://x" }))).toBe(true);
    expect(isInferenceEnabled(makeEnv({ INFERENCE_BASE_URL: "" }))).toBe(false);
    expect(
      isInferenceEnabled(makeEnv({ INFERENCE_BASE_URL: "", INFERENCE_BASE_URL_PRIMARY: "https://p" }))
    ).toBe(true);
  });
});

describe("resolveInferencePrimaryBaseUrl", () => {
  // Case (a): inference disabled + empty URL → no throw, returns placeholder
  it("returns placeholder when inference is disabled and URL is empty (all-cloud mode)", () => {
    const result = resolveInferencePrimaryBaseUrl(
      makeEnv({ INFERENCE_ENABLED: "false", INFERENCE_BASE_URL: "", INFERENCE_BASE_URL_PRIMARY: "" })
    );
    expect(result).toBe("https://inference.disabled.invalid");
  });

  it("returns placeholder for all disabled flag values, even when URL is present", () => {
    for (const v of ["false", "0", "no", "off"]) {
      const result = resolveInferencePrimaryBaseUrl(
        makeEnv({ INFERENCE_ENABLED: v, INFERENCE_BASE_URL: "https://real.example" })
      );
      expect(result).toBe("https://inference.disabled.invalid");
    }
  });

  // Case (b): inference enabled + empty URL → must throw
  it("throws when inference is enabled and no URL is configured", () => {
    expect(() =>
      resolveInferencePrimaryBaseUrl(
        makeEnv({ INFERENCE_ENABLED: "true", INFERENCE_BASE_URL: "", INFERENCE_BASE_URL_PRIMARY: "" })
      )
    ).toThrow("INFERENCE_BASE_URL or INFERENCE_BASE_URL_PRIMARY must be configured");
  });

  // When no flag is set and no URL is present, isInferenceEnabled returns false
  // (URL-implicit mode: no URL → inference considered disabled).
  // resolveInferencePrimaryBaseUrl therefore returns the placeholder rather than throwing.
  it("returns placeholder when no flag is set and no URL is present (implicit disabled)", () => {
    const result = resolveInferencePrimaryBaseUrl(
      makeEnv({ INFERENCE_BASE_URL: "", INFERENCE_BASE_URL_PRIMARY: "" })
    );
    expect(result).toBe("https://inference.disabled.invalid");
  });

  // Case (c): inference enabled + URL present → returns the URL
  it("returns the primary URL when inference is enabled and URL is configured", () => {
    expect(
      resolveInferencePrimaryBaseUrl(
        makeEnv({ INFERENCE_ENABLED: "true", INFERENCE_BASE_URL_PRIMARY: "https://primary.example" })
      )
    ).toBe("https://primary.example");
  });

  it("falls back to INFERENCE_BASE_URL when PRIMARY is absent", () => {
    expect(
      resolveInferencePrimaryBaseUrl(
        makeEnv({ INFERENCE_BASE_URL: "https://base.example" })
      )
    ).toBe("https://base.example");
  });

  it("strips trailing slash from URL", () => {
    expect(
      resolveInferencePrimaryBaseUrl(
        makeEnv({ INFERENCE_BASE_URL_PRIMARY: "https://primary.example/" })
      )
    ).toBe("https://primary.example");
  });
});

describe("invokeInferenceAnalysisEvents — inference disabled", () => {
  it("short-circuits to the local analyzer without calling the inference client", async () => {
    const callJson = vi.fn(() => {
      throw new Error("inference client must NOT be called when inference is disabled");
    });
    const ctx: InferenceCallContext = {
      env: makeEnv({ INFERENCE_ENABLED: "false", INFERENCE_BASE_URL: "https://dead.example" }),
      inferenceClient: { callJson, snapshot: () => ({}) } as unknown as InferenceFailoverClient,
      storeDependencyHealth: async () => {},
    };

    const result = await invokeInferenceAnalysisEvents(ctx, {
      session_id: "s1",
      transcript: [],
      memos: [],
      stats: [],
    });

    expect(callJson).not.toHaveBeenCalled();
    expect(result.backend_used).toBe("local");
    expect(result.fallback_reason).toBe("inference_disabled");
    expect(result.warnings.join(" ")).toMatch(/inference disabled/i);
  });
});
