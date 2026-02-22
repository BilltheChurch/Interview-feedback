import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  computeDistanceMatrix,
  agglomerativeClustering,
  globalCluster,
  mapClustersToRoster,
  type RosterParticipant,
} from "../src/global-cluster";
import type { CachedEmbedding } from "../src/providers/types";

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Create a unit-normalized embedding with a dominant direction.
 * Uses a simple seeded PRNG to produce vectors that are near-orthogonal
 * for different seeds, mimicking real speaker embeddings.
 */
function makeSpeakerEmbedding(speakerSeed: number, dim = 512, noise = 0.05): Float32Array {
  const vec = new Float32Array(dim);
  // Simple seeded PRNG (xorshift32) — deterministic per seed
  let state = (speakerSeed * 2654435761 + 1) >>> 0; // Knuth's multiplicative hash
  function nextRand(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return (state / 4294967296) * 2 - 1; // [-1, 1]
  }
  // Base direction from PRNG
  for (let i = 0; i < dim; i++) {
    vec[i] = nextRand();
  }
  // Add noise (using a separate noise seed)
  let noiseState = (speakerSeed * 1103515245 + 12345) >>> 0;
  function nextNoise(): number {
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    noiseState = noiseState >>> 0;
    return (noiseState / 4294967296) * 2 - 1;
  }
  for (let i = 0; i < dim; i++) {
    vec[i] += noise * nextNoise();
  }
  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

/** Incrementing counter used to give each entry a unique noise perturbation. */
let entryCounter = 0;

/** Simple xorshift32 PRNG from a seed. */
function xorshift32(seed: number): () => number {
  let state = ((seed * 2654435761) + 1) >>> 0;
  if (state === 0) state = 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return (state / 4294967296) * 2 - 1; // [-1, 1]
  };
}

/** Create a CachedEmbedding for testing. */
function makeEntry(
  segmentId: string,
  speakerSeed: number,
  startMs: number,
  opts?: { noise?: number; stream_role?: "students" | "teacher" }
): CachedEmbedding {
  // Use a unique perturbation seed per entry so same-speaker entries are
  // similar but not identical (mimicking real-world embedding variation).
  const perturbSeed = ++entryCounter;
  const base = makeSpeakerEmbedding(speakerSeed, 512, 0);
  const noise = opts?.noise ?? 0.05;
  const rng = xorshift32(perturbSeed * 7919 + speakerSeed);
  const vec = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    vec[i] = base[i] + noise * rng();
  }
  // Re-normalize
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;

  return {
    segment_id: segmentId,
    embedding: vec,
    start_ms: startMs,
    end_ms: startMs + 1000,
    window_cluster_id: `SPEAKER_${speakerSeed % 2 === 0 ? "00" : "01"}`,
    stream_role: opts?.stream_role ?? "students",
  };
}

// ── cosineSimilarity ─────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3, 4, 5]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    const z = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity(z, z)).toBe(0);
  });

  it("is symmetric", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 5);
  });

  it("handles high-dimensional vectors", () => {
    const a = makeSpeakerEmbedding(1);
    const b = makeSpeakerEmbedding(1);
    // Same seed → same vector → similarity ≈ 1.0
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 3);
  });

  it("shows low similarity for different speakers", () => {
    const a = makeSpeakerEmbedding(1);
    const b = makeSpeakerEmbedding(100);
    // Different seeds → different vectors → low similarity
    expect(cosineSimilarity(a, b)).toBeLessThan(0.5);
  });
});

// ── computeDistanceMatrix ────────────────────────────────────────────────────

describe("computeDistanceMatrix", () => {
  it("returns empty for no embeddings", () => {
    const dist = computeDistanceMatrix([]);
    expect(dist.length).toBe(0);
  });

  it("returns 1x1 matrix with 0 distance for single embedding", () => {
    const dist = computeDistanceMatrix([new Float32Array([1, 0])]);
    expect(dist.length).toBe(1);
    expect(dist[0]).toBe(0);
  });

  it("has zero diagonal", () => {
    const vecs = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
    ];
    const dist = computeDistanceMatrix(vecs);
    expect(dist[0]).toBe(0); // [0,0]
    expect(dist[4]).toBe(0); // [1,1]
    expect(dist[8]).toBe(0); // [2,2]
  });

  it("is symmetric", () => {
    const vecs = [
      new Float32Array([1, 2, 3]),
      new Float32Array([4, 5, 6]),
      new Float32Array([7, 8, 9]),
    ];
    const dist = computeDistanceMatrix(vecs);
    const n = 3;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        expect(dist[i * n + j]).toBeCloseTo(dist[j * n + i], 5);
      }
    }
  });
});

// ── agglomerativeClustering ──────────────────────────────────────────────────

describe("agglomerativeClustering", () => {
  it("returns empty for n=0", () => {
    expect(agglomerativeClustering(new Float32Array(0), 0, 0.3)).toEqual([]);
  });

  it("returns [0] for n=1", () => {
    expect(agglomerativeClustering(new Float32Array([0]), 1, 0.3)).toEqual([0]);
  });

  it("merges identical points into one cluster", () => {
    // 3 points with zero distance between them
    const dist = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const labels = agglomerativeClustering(dist, 3, 0.3);
    expect(new Set(labels).size).toBe(1);
  });

  it("keeps distant points in separate clusters", () => {
    // 2 points very far apart
    const dist = new Float32Array([0, 1.5, 1.5, 0]);
    const labels = agglomerativeClustering(dist, 2, 0.3);
    expect(new Set(labels).size).toBe(2);
  });

  it("merges when distance is below threshold", () => {
    const dist = new Float32Array([0, 0.25, 0.25, 0]);
    const labels = agglomerativeClustering(dist, 2, 0.3);
    expect(new Set(labels).size).toBe(1);
  });

  it("does not merge at distance above threshold", () => {
    const dist = new Float32Array([0, 0.35, 0.35, 0]);
    const labels = agglomerativeClustering(dist, 2, 0.3);
    expect(new Set(labels).size).toBe(2);
  });
});

// ── globalCluster ────────────────────────────────────────────────────────────

describe("globalCluster", () => {
  it("returns empty result for empty input", () => {
    const result = globalCluster([]);
    expect(result.clusters.size).toBe(0);
    expect(result.centroids.size).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("handles single segment", () => {
    const entries = [makeEntry("seg_001", 1, 0)];
    const result = globalCluster(entries);
    expect(result.clusters.size).toBe(1);
    expect(result.clusters.get("spk_0")).toEqual(["seg_001"]);
    expect(result.confidence).toBe(1.0);
  });

  it("clusters 4 distinct speakers correctly", () => {
    // Create 3 segments per speaker, 4 speakers = 12 total
    const entries: CachedEmbedding[] = [];
    const speakerSeeds = [1, 50, 100, 150]; // Distinct enough seeds
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 3; i++) {
        entries.push(makeEntry(
          `seg_s${s}_${i}`,
          speakerSeeds[s],
          s * 10000 + i * 1000,
          { noise: 0.02 }
        ));
      }
    }

    const result = globalCluster(entries, { distance_threshold: 0.3 });
    expect(result.clusters.size).toBe(4);

    // Each cluster should have exactly 3 segments from the same speaker
    for (const [, segIds] of result.clusters) {
      expect(segIds.length).toBe(3);
      // All segment IDs in a cluster should share the same speaker prefix
      const prefixes = segIds.map((id) => id.split("_").slice(0, 2).join("_"));
      expect(new Set(prefixes).size).toBe(1);
    }
  });

  it("merges segments from same speaker even with noise", () => {
    // 5 segments all from the same speaker with varying noise
    const entries = [
      makeEntry("seg_001", 1, 0, { noise: 0.01 }),
      makeEntry("seg_002", 1, 1000, { noise: 0.03 }),
      makeEntry("seg_003", 1, 2000, { noise: 0.02 }),
      makeEntry("seg_004", 1, 3000, { noise: 0.04 }),
      makeEntry("seg_005", 1, 4000, { noise: 0.01 }),
    ];
    const result = globalCluster(entries, { distance_threshold: 0.3 });
    expect(result.clusters.size).toBe(1);
    expect(result.clusters.get("spk_0")?.length).toBe(5);
  });

  it("respects min_cluster_size", () => {
    // 2 speakers: one with 4 segments (low noise for tight clustering), one with 1 segment
    const entries = [
      makeEntry("seg_a1", 1, 0, { noise: 0.01 }),
      makeEntry("seg_a2", 1, 1000, { noise: 0.01 }),
      makeEntry("seg_a3", 1, 2000, { noise: 0.01 }),
      makeEntry("seg_a4", 1, 3000, { noise: 0.01 }),
      makeEntry("seg_b1", 100, 4000, { noise: 0.01 }), // Isolated speaker
    ];
    // Use a generous threshold to ensure same-speaker segments merge
    const result = globalCluster(entries, { distance_threshold: 0.5, min_cluster_size: 2 });
    // The speaker-1 cluster (4 members) should survive
    // Speaker-100's cluster (1 member) should be filtered out
    expect(result.clusters.size).toBe(1);
    expect([...result.clusters.values()][0].length).toBe(4);
  });

  it("centroids are unit-averaged", () => {
    const entries = [
      makeEntry("seg_001", 1, 0),
      makeEntry("seg_002", 1, 1000),
    ];
    const result = globalCluster(entries, { distance_threshold: 0.5 });
    const centroid = result.centroids.get("spk_0");
    expect(centroid).toBeDefined();
    expect(centroid!.length).toBe(512);
    // Centroid should be close to both embeddings
    const sim1 = cosSimHelper(centroid!, entries[0].embedding);
    const sim2 = cosSimHelper(centroid!, entries[1].embedding);
    expect(sim1).toBeGreaterThan(0.9);
    expect(sim2).toBeGreaterThan(0.9);
  });

  it("confidence is high for well-separated clusters", () => {
    const entries: CachedEmbedding[] = [];
    const seeds = [1, 100];
    for (const seed of seeds) {
      for (let i = 0; i < 4; i++) {
        entries.push(makeEntry(`seg_${seed}_${i}`, seed, i * 1000, { noise: 0.01 }));
      }
    }
    const result = globalCluster(entries, { distance_threshold: 0.3 });
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("supports all linkage types", () => {
    const entries = [
      makeEntry("seg_001", 1, 0),
      makeEntry("seg_002", 1, 1000),
      makeEntry("seg_003", 100, 2000),
    ];
    for (const linkage of ["average", "complete", "single"] as const) {
      const result = globalCluster(entries, { distance_threshold: 0.3, linkage });
      expect(result.clusters.size).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── mapClustersToRoster ──────────────────────────────────────────────────────

describe("mapClustersToRoster", () => {
  it("maps clusters to roster names by embedding similarity", () => {
    const entries = [
      makeEntry("seg_a1", 1, 0),
      makeEntry("seg_a2", 1, 1000),
      makeEntry("seg_b1", 100, 2000),
      makeEntry("seg_b2", 100, 3000),
    ];
    const clusterResult = globalCluster(entries, { distance_threshold: 0.3 });

    const roster: RosterParticipant[] = [
      { name: "Alice", enrollment_embedding: makeSpeakerEmbedding(1) },
      { name: "Bob", enrollment_embedding: makeSpeakerEmbedding(100) },
    ];

    const mapping = mapClustersToRoster(clusterResult, roster, 0.5);
    const names = new Set(mapping.values());
    expect(names.has("Alice")).toBe(true);
    expect(names.has("Bob")).toBe(true);
  });

  it("keeps original spk_N for unmatched clusters", () => {
    const entries = [
      makeEntry("seg_001", 1, 0),
      makeEntry("seg_002", 1, 1000),
    ];
    const clusterResult = globalCluster(entries, { distance_threshold: 0.3 });
    // Empty roster → no matches
    const mapping = mapClustersToRoster(clusterResult, []);
    expect(mapping.get("spk_0")).toBe("spk_0");
  });

  it("skips roster participants without enrollment embedding", () => {
    const entries = [makeEntry("seg_001", 1, 0)];
    const clusterResult = globalCluster(entries, { distance_threshold: 0.3 });
    const roster: RosterParticipant[] = [{ name: "NoEmbed" }];
    const mapping = mapClustersToRoster(clusterResult, roster);
    expect(mapping.get("spk_0")).toBe("spk_0");
  });

  it("does not assign same participant to multiple clusters", () => {
    const entries = [
      makeEntry("seg_a1", 1, 0),
      makeEntry("seg_b1", 100, 1000),
    ];
    const clusterResult = globalCluster(entries, { distance_threshold: 0.3 });
    // Only one roster participant → at most one cluster gets the name
    const roster: RosterParticipant[] = [
      { name: "Alice", enrollment_embedding: makeSpeakerEmbedding(1) },
    ];
    const mapping = mapClustersToRoster(clusterResult, roster, 0.5);
    const aliceCount = [...mapping.values()].filter((v) => v === "Alice").length;
    expect(aliceCount).toBeLessThanOrEqual(1);
  });

  it("respects similarity threshold", () => {
    const entries = [makeEntry("seg_001", 1, 0)];
    const clusterResult = globalCluster(entries, { distance_threshold: 0.3 });
    // Create a very different enrollment embedding
    const roster: RosterParticipant[] = [
      { name: "Stranger", enrollment_embedding: makeSpeakerEmbedding(200) },
    ];
    const mapping = mapClustersToRoster(clusterResult, roster, 0.99);
    // High threshold → no match
    expect(mapping.get("spk_0")).toBe("spk_0");
  });
});

// ── Helper ───────────────────────────────────────────────────────────────────

function cosSimHelper(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
