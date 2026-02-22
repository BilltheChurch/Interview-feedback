import { describe, it, expect } from "vitest";

describe("scheduling webhook placeholder", () => {
  it("returns 501 response shape", () => {
    const body = { detail: "not implemented", phase: 2 };
    expect(body.detail).toBe("not implemented");
    expect(body.phase).toBe(2);
  });
});
