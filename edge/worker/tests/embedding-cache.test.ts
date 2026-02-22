import { describe, it, expect } from "vitest";
import {
  EmbeddingCache,
  float32ToBase64,
  base64ToFloat32,
} from "../src/embedding-cache";
import type { CachedEmbedding } from "../src/providers/types";

function makeEmbedding(segmentId: string, overrides?: Partial<CachedEmbedding>): CachedEmbedding {
  const embedding = new Float32Array(512);
  // Fill with deterministic values based on segment ID
  for (let i = 0; i < 512; i++) {
    embedding[i] = Math.sin(i + segmentId.charCodeAt(segmentId.length - 1));
  }
  return {
    segment_id: segmentId,
    embedding,
    start_ms: 0,
    end_ms: 1000,
    window_cluster_id: "SPEAKER_00",
    stream_role: "students",
    ...overrides,
  };
}

/* ── Base64 round-trip ──────────────────────── */

describe("float32ToBase64 / base64ToFloat32", () => {
  it("round-trips a Float32Array correctly", () => {
    const original = new Float32Array([1.0, -2.5, 3.14159, 0, -0.001]);
    const b64 = float32ToBase64(original);
    const restored = base64ToFloat32(b64);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("handles a 512-dim embedding", () => {
    const original = new Float32Array(512);
    for (let i = 0; i < 512; i++) original[i] = Math.random() * 2 - 1;
    const b64 = float32ToBase64(original);
    const restored = base64ToFloat32(b64);
    expect(restored.length).toBe(512);
    for (let i = 0; i < 512; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("handles empty Float32Array", () => {
    const original = new Float32Array(0);
    const b64 = float32ToBase64(original);
    const restored = base64ToFloat32(b64);
    expect(restored.length).toBe(0);
  });
});

/* ── EmbeddingCache basic operations ────────── */

describe("EmbeddingCache", () => {
  it("starts empty", () => {
    const cache = new EmbeddingCache();
    expect(cache.size).toBe(0);
    expect(cache.getAllEmbeddings()).toEqual([]);
    expect(cache.getMemoryUsageBytes()).toBe(0);
  });

  it("adds and retrieves a single embedding", () => {
    const cache = new EmbeddingCache();
    const entry = makeEmbedding("seg_001");
    expect(cache.addEmbedding(entry)).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.getEmbedding("seg_001")).toBe(entry);
  });

  it("returns undefined for non-existent segment", () => {
    const cache = new EmbeddingCache();
    expect(cache.getEmbedding("nonexistent")).toBeUndefined();
  });

  it("getAllEmbeddings returns entries sorted by start_ms", () => {
    const cache = new EmbeddingCache();
    cache.addEmbedding(makeEmbedding("seg_c", { start_ms: 3000, end_ms: 4000 }));
    cache.addEmbedding(makeEmbedding("seg_a", { start_ms: 1000, end_ms: 2000 }));
    cache.addEmbedding(makeEmbedding("seg_b", { start_ms: 2000, end_ms: 3000 }));
    const all = cache.getAllEmbeddings();
    expect(all.map((e) => e.segment_id)).toEqual(["seg_a", "seg_b", "seg_c"]);
  });

  it("overwrites existing entry with same segment_id", () => {
    const cache = new EmbeddingCache();
    const first = makeEmbedding("seg_001", { start_ms: 0 });
    const second = makeEmbedding("seg_001", { start_ms: 5000 });
    cache.addEmbedding(first);
    cache.addEmbedding(second);
    expect(cache.size).toBe(1);
    expect(cache.getEmbedding("seg_001")?.start_ms).toBe(5000);
  });

  it("clears all entries", () => {
    const cache = new EmbeddingCache();
    cache.addEmbedding(makeEmbedding("seg_001"));
    cache.addEmbedding(makeEmbedding("seg_002"));
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.getAllEmbeddings()).toEqual([]);
  });
});

/* ── Filtering by stream role ───────────────── */

describe("EmbeddingCache.getByStreamRole", () => {
  it("filters by students role", () => {
    const cache = new EmbeddingCache();
    cache.addEmbedding(makeEmbedding("seg_s1", { stream_role: "students" }));
    cache.addEmbedding(makeEmbedding("seg_t1", { stream_role: "teacher" }));
    cache.addEmbedding(makeEmbedding("seg_s2", { stream_role: "students" }));
    const students = cache.getByStreamRole("students");
    expect(students.length).toBe(2);
    expect(students.every((e) => e.stream_role === "students")).toBe(true);
  });

  it("filters by teacher role", () => {
    const cache = new EmbeddingCache();
    cache.addEmbedding(makeEmbedding("seg_s1", { stream_role: "students" }));
    cache.addEmbedding(makeEmbedding("seg_t1", { stream_role: "teacher" }));
    const teachers = cache.getByStreamRole("teacher");
    expect(teachers.length).toBe(1);
    expect(teachers[0].segment_id).toBe("seg_t1");
  });

  it("returns empty when no match", () => {
    const cache = new EmbeddingCache();
    cache.addEmbedding(makeEmbedding("seg_s1", { stream_role: "students" }));
    expect(cache.getByStreamRole("teacher")).toEqual([]);
  });
});

/* ── Memory limits ──────────────────────────── */

describe("EmbeddingCache memory limits", () => {
  it("tracks memory usage", () => {
    const cache = new EmbeddingCache();
    expect(cache.getMemoryUsageBytes()).toBe(0);
    cache.addEmbedding(makeEmbedding("seg_001"));
    // 512 * 4 + 200 = 2248 bytes per entry
    expect(cache.getMemoryUsageBytes()).toBe(2248);
    cache.addEmbedding(makeEmbedding("seg_002"));
    expect(cache.getMemoryUsageBytes()).toBe(2 * 2248);
  });

  it("rejects new entries when memory limit exceeded", () => {
    // Set a tiny limit that allows only 1 entry
    const cache = new EmbeddingCache(3000); // < 2 * 2248
    expect(cache.addEmbedding(makeEmbedding("seg_001"))).toBe(true);
    expect(cache.addEmbedding(makeEmbedding("seg_002"))).toBe(false);
    expect(cache.size).toBe(1);
  });

  it("allows overwrite of existing entry even at limit", () => {
    const cache = new EmbeddingCache(3000);
    cache.addEmbedding(makeEmbedding("seg_001", { start_ms: 0 }));
    // Overwriting same ID should succeed since it doesn't increase count
    expect(cache.addEmbedding(makeEmbedding("seg_001", { start_ms: 5000 }))).toBe(true);
    expect(cache.getEmbedding("seg_001")?.start_ms).toBe(5000);
  });
});

/* ── Serialization / Deserialization ────────── */

describe("EmbeddingCache serialization", () => {
  it("round-trips through serialize/deserialize", () => {
    const cache = new EmbeddingCache();
    const e1 = makeEmbedding("seg_001", { start_ms: 0, end_ms: 1000, stream_role: "students" });
    const e2 = makeEmbedding("seg_002", { start_ms: 1000, end_ms: 2000, stream_role: "teacher" });
    cache.addEmbedding(e1);
    cache.addEmbedding(e2);

    const serialized = cache.serialize();
    expect(serialized.length).toBe(2);
    expect(typeof serialized[0].embedding_b64).toBe("string");

    const restored = new EmbeddingCache();
    restored.deserialize(serialized);
    expect(restored.size).toBe(2);

    const r1 = restored.getEmbedding("seg_001");
    expect(r1).toBeDefined();
    expect(r1!.start_ms).toBe(0);
    expect(r1!.stream_role).toBe("students");
    expect(r1!.embedding.length).toBe(512);
    // Check embedding values match
    for (let i = 0; i < 512; i++) {
      expect(r1!.embedding[i]).toBeCloseTo(e1.embedding[i], 5);
    }
  });

  it("deserialize clears existing entries first", () => {
    const cache = new EmbeddingCache();
    cache.addEmbedding(makeEmbedding("old_entry"));
    expect(cache.size).toBe(1);

    cache.deserialize([{
      segment_id: "new_entry",
      embedding_b64: float32ToBase64(new Float32Array(512)),
      start_ms: 0,
      end_ms: 1000,
      window_cluster_id: "SPEAKER_00",
      stream_role: "students",
    }]);
    expect(cache.size).toBe(1);
    expect(cache.getEmbedding("old_entry")).toBeUndefined();
    expect(cache.getEmbedding("new_entry")).toBeDefined();
  });

  it("handles empty serialization", () => {
    const cache = new EmbeddingCache();
    const serialized = cache.serialize();
    expect(serialized).toEqual([]);

    cache.addEmbedding(makeEmbedding("seg_001"));
    cache.deserialize([]);
    expect(cache.size).toBe(0);
  });
});
