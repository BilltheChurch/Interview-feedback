/**
 * Agglomerative clustering for speaker embeddings — pure TypeScript.
 *
 * Runs entirely in Cloudflare Worker (no native dependencies).
 * For a typical 10-min session with ~60 segments, the 60x60 distance
 * matrix computation and O(n^3) clustering completes in <100ms.
 *
 * Algorithm:
 *   1. Compute pairwise cosine distance matrix
 *   2. Bottom-up agglomerative merge (average/complete/single linkage)
 *   3. Map resulting clusters to roster names via enrollment embeddings
 */

import type {
  CachedEmbedding,
  ClusterOptions,
  GlobalClusterResult,
} from "./providers/types";

// ── Vector math ──────────────────────────────────────────────────────────────

/** Cosine similarity between two vectors. Returns value in [-1, 1]. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Compute a symmetric pairwise cosine distance matrix.
 * Distance = 1 - cosine_similarity, clamped to [0, 2].
 *
 * Returns a flat Float32Array of size n*n (row-major).
 */
export function computeDistanceMatrix(embeddings: Float32Array[]): Float32Array {
  const n = embeddings.length;
  const dist = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.max(0, 1 - cosineSimilarity(embeddings[i], embeddings[j]));
      dist[i * n + j] = d;
      dist[j * n + i] = d;
    }
    // dist[i * n + i] = 0 (already initialized)
  }
  return dist;
}

// ── Agglomerative clustering ─────────────────────────────────────────────────

/**
 * Agglomerative clustering with configurable linkage.
 *
 * Returns an array of cluster labels (0-indexed) for each input point.
 * Points in the same cluster share the same label.
 */
export function agglomerativeClustering(
  distMatrix: Float32Array,
  n: number,
  threshold: number,
  linkage: "average" | "complete" | "single" = "average"
): number[] {
  if (n === 0) return [];
  if (n === 1) return [0];

  // Each point starts in its own cluster
  const labels = Array.from({ length: n }, (_, i) => i);
  // Track which points belong to each cluster
  const clusterMembers: Map<number, number[]> = new Map();
  for (let i = 0; i < n; i++) {
    clusterMembers.set(i, [i]);
  }

  // Active cluster set (removed clusters are deleted from this set)
  const active = new Set<number>();
  for (let i = 0; i < n; i++) active.add(i);

  // Iteratively merge closest pair until threshold exceeded
  while (active.size > 1) {
    let bestDist = Infinity;
    let bestA = -1;
    let bestB = -1;

    const activeArr = [...active];
    for (let ai = 0; ai < activeArr.length; ai++) {
      for (let bi = ai + 1; bi < activeArr.length; bi++) {
        const ca = activeArr[ai];
        const cb = activeArr[bi];
        const d = clusterDistance(
          clusterMembers.get(ca)!,
          clusterMembers.get(cb)!,
          distMatrix,
          n,
          linkage
        );
        if (d < bestDist) {
          bestDist = d;
          bestA = ca;
          bestB = cb;
        }
      }
    }

    if (bestDist > threshold || bestA < 0) break;

    // Merge bestB into bestA
    const membersA = clusterMembers.get(bestA)!;
    const membersB = clusterMembers.get(bestB)!;
    for (const idx of membersB) {
      membersA.push(idx);
      labels[idx] = bestA;
    }
    clusterMembers.delete(bestB);
    active.delete(bestB);
  }

  // Normalize labels to 0..k-1
  const uniqueLabels = [...new Set(labels)].sort((a, b) => a - b);
  const labelMap = new Map(uniqueLabels.map((old, idx) => [old, idx]));
  return labels.map((l) => labelMap.get(l)!);
}

/** Compute distance between two clusters based on linkage criterion. */
function clusterDistance(
  membersA: number[],
  membersB: number[],
  distMatrix: Float32Array,
  n: number,
  linkage: "average" | "complete" | "single"
): number {
  let result: number;
  switch (linkage) {
    case "single":
      result = Infinity;
      for (const a of membersA) {
        for (const b of membersB) {
          const d = distMatrix[a * n + b];
          if (d < result) result = d;
        }
      }
      return result;

    case "complete":
      result = -Infinity;
      for (const a of membersA) {
        for (const b of membersB) {
          const d = distMatrix[a * n + b];
          if (d > result) result = d;
        }
      }
      return result;

    case "average":
    default: {
      let sum = 0;
      let count = 0;
      for (const a of membersA) {
        for (const b of membersB) {
          sum += distMatrix[a * n + b];
          count++;
        }
      }
      return count > 0 ? sum / count : Infinity;
    }
  }
}

// ── Global clustering entry point ────────────────────────────────────────────

const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  distance_threshold: 0.3,
  linkage: "average",
  min_cluster_size: 1,
};

/**
 * Run global clustering on cached embeddings.
 *
 * Steps:
 *   1. Build pairwise cosine distance matrix
 *   2. Run agglomerative clustering with configured threshold
 *   3. Group segments by cluster and compute centroids
 *   4. Optionally filter by min_cluster_size
 *
 * Returns cluster assignments and centroid embeddings for roster mapping.
 */
export function globalCluster(
  embeddings: CachedEmbedding[],
  options?: Partial<ClusterOptions>
): GlobalClusterResult {
  const opts = { ...DEFAULT_CLUSTER_OPTIONS, ...options };

  if (embeddings.length === 0) {
    return { clusters: new Map(), centroids: new Map(), confidence: 0 };
  }

  if (embeddings.length === 1) {
    const spkId = "spk_0";
    return {
      clusters: new Map([[spkId, [embeddings[0].segment_id]]]),
      centroids: new Map([[spkId, new Float32Array(embeddings[0].embedding)]]),
      confidence: 1.0,
    };
  }

  // Step 1: Distance matrix
  const embeddingVectors = embeddings.map((e) => e.embedding);
  const distMatrix = computeDistanceMatrix(embeddingVectors);

  // Step 2: Cluster
  const labels = agglomerativeClustering(
    distMatrix,
    embeddings.length,
    opts.distance_threshold,
    opts.linkage
  );

  // Step 3: Group by label and compute centroids
  const clusterMap = new Map<number, number[]>(); // label -> indices
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!clusterMap.has(label)) clusterMap.set(label, []);
    clusterMap.get(label)!.push(i);
  }

  const clusters = new Map<string, string[]>();
  const centroids = new Map<string, Float32Array>();

  // Sort clusters by earliest segment for stable ordering
  const sortedLabels = [...clusterMap.entries()]
    .sort((a, b) => {
      const aMin = Math.min(...a[1].map((i) => embeddings[i].start_ms));
      const bMin = Math.min(...b[1].map((i) => embeddings[i].start_ms));
      return aMin - bMin;
    });

  let spkIdx = 0;
  for (const [, indices] of sortedLabels) {
    if (indices.length < opts.min_cluster_size) continue;

    const spkId = `spk_${spkIdx}`;
    clusters.set(spkId, indices.map((i) => embeddings[i].segment_id));

    // Compute centroid as element-wise average
    const dim = embeddingVectors[0].length;
    const centroid = new Float32Array(dim);
    for (const idx of indices) {
      const vec = embeddingVectors[idx];
      for (let d = 0; d < dim; d++) {
        centroid[d] += vec[d];
      }
    }
    for (let d = 0; d < dim; d++) {
      centroid[d] /= indices.length;
    }
    centroids.set(spkId, centroid);

    spkIdx++;
  }

  // Confidence: average intra-cluster similarity (higher = better separation)
  const confidence = computeClusteringConfidence(clusters, embeddings);

  return { clusters, centroids, confidence };
}

/** Compute an overall clustering confidence score based on intra-cluster cohesion. */
function computeClusteringConfidence(
  clusters: Map<string, string[]>,
  embeddings: CachedEmbedding[]
): number {
  const idxMap = new Map(embeddings.map((e, i) => [e.segment_id, i]));
  let totalSim = 0;
  let totalPairs = 0;

  for (const [, segmentIds] of clusters) {
    if (segmentIds.length < 2) continue;
    for (let i = 0; i < segmentIds.length; i++) {
      for (let j = i + 1; j < segmentIds.length; j++) {
        const ai = idxMap.get(segmentIds[i]);
        const bi = idxMap.get(segmentIds[j]);
        if (ai === undefined || bi === undefined) continue;
        totalSim += cosineSimilarity(embeddings[ai].embedding, embeddings[bi].embedding);
        totalPairs++;
      }
    }
  }

  if (totalPairs === 0) return 1.0; // Single-member clusters are perfectly cohesive
  return Math.max(0, Math.min(1, totalSim / totalPairs));
}

// ── Roster mapping ───────────────────────────────────────────────────────────

/** Participant from session config with optional enrollment embedding. */
export interface RosterParticipant {
  name: string;
  enrollment_embedding?: Float32Array;
}

/**
 * Map global cluster IDs to roster participant names.
 *
 * Strategy:
 *   1. For each cluster centroid, score against all enrollment embeddings
 *   2. Assign best match above threshold (greedy, highest score first)
 *   3. Unmatched clusters keep their spk_N ID
 *
 * Returns: global_speaker_id -> participant name (or original spk_N).
 */
export function mapClustersToRoster(
  result: GlobalClusterResult,
  roster: RosterParticipant[],
  similarityThreshold: number = 0.65
): Map<string, string> {
  const mapping = new Map<string, string>();

  // Build candidate scores: [spk_id, participant_name, similarity]
  const candidates: Array<[string, string, number]> = [];
  for (const [spkId, centroid] of result.centroids) {
    for (const participant of roster) {
      if (!participant.enrollment_embedding) continue;
      const sim = cosineSimilarity(centroid, participant.enrollment_embedding);
      candidates.push([spkId, participant.name, sim]);
    }
  }

  // Sort by similarity descending (greedy best-first assignment)
  candidates.sort((a, b) => b[2] - a[2]);

  const assignedSpeakers = new Set<string>();
  const assignedNames = new Set<string>();

  for (const [spkId, name, sim] of candidates) {
    if (sim < similarityThreshold) continue;
    if (assignedSpeakers.has(spkId) || assignedNames.has(name)) continue;
    mapping.set(spkId, name);
    assignedSpeakers.add(spkId);
    assignedNames.add(name);
  }

  // Fill unmapped clusters with their original IDs
  for (const spkId of result.clusters.keys()) {
    if (!mapping.has(spkId)) {
      mapping.set(spkId, spkId);
    }
  }

  return mapping;
}
