/**
 * Incremental embedding cache for speaker diarization.
 *
 * During recording, each diarization segment produces a speaker embedding.
 * These are cached in Durable Object memory and used at finalization for
 * global clustering to produce consistent speaker IDs across the session.
 *
 * Memory footprint: ~512 floats x 4 bytes x N segments
 *   - 60 segments (10 min audio) ≈ 120 KB
 *   - Hard limit: configurable, default 2 MB (~1000 segments)
 */

import type {
  CachedEmbedding,
  CachedEmbeddingSerialized,
} from "./providers/types";

/** Bytes per embedding: 512 dimensions x 4 bytes per float32. */
const BYTES_PER_EMBEDDING = 512 * 4;

/** Overhead per entry (segment_id, timestamps, cluster_id, stream_role strings). */
const OVERHEAD_PER_ENTRY = 200;

/** Default memory limit in bytes (2 MB). */
const DEFAULT_MEMORY_LIMIT = 2 * 1024 * 1024;

/**
 * In-memory cache for speaker embeddings, stored within a Durable Object.
 *
 * Supports:
 * - Add/get/clear operations
 * - Memory usage tracking and enforcement
 * - Serialization/deserialization for DO hibernation
 * - Filtering by stream role
 */
export class EmbeddingCache {
  private readonly entries: Map<string, CachedEmbedding> = new Map();
  private readonly memoryLimitBytes: number;

  constructor(memoryLimitBytes: number = DEFAULT_MEMORY_LIMIT) {
    this.memoryLimitBytes = memoryLimitBytes;
  }

  /** Store an embedding for a diarization segment. Rejects if memory limit reached. */
  addEmbedding(entry: CachedEmbedding): boolean {
    const newUsage = this.getMemoryUsageBytes() + BYTES_PER_EMBEDDING + OVERHEAD_PER_ENTRY;
    if (newUsage > this.memoryLimitBytes && !this.entries.has(entry.segment_id)) {
      return false;
    }
    this.entries.set(entry.segment_id, entry);
    return true;
  }

  /** Get a specific embedding by segment ID. */
  getEmbedding(segmentId: string): CachedEmbedding | undefined {
    return this.entries.get(segmentId);
  }

  /** Get all cached embeddings, ordered by start_ms. */
  getAllEmbeddings(): CachedEmbedding[] {
    return [...this.entries.values()].sort((a, b) => a.start_ms - b.start_ms);
  }

  /** Get embeddings filtered by stream role. */
  getByStreamRole(role: "students" | "teacher"): CachedEmbedding[] {
    return this.getAllEmbeddings().filter((e) => e.stream_role === role);
  }

  /** Number of cached entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Estimated memory usage in bytes. */
  getMemoryUsageBytes(): number {
    return this.entries.size * (BYTES_PER_EMBEDDING + OVERHEAD_PER_ENTRY);
  }

  /** Clear all cached embeddings. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Serialize cache for Durable Object hibernation.
   * Float32Array → base64 string for JSON compatibility.
   */
  serialize(): CachedEmbeddingSerialized[] {
    return this.getAllEmbeddings().map((entry) => ({
      segment_id: entry.segment_id,
      embedding_b64: float32ToBase64(entry.embedding),
      start_ms: entry.start_ms,
      end_ms: entry.end_ms,
      window_cluster_id: entry.window_cluster_id,
      stream_role: entry.stream_role,
    }));
  }

  /**
   * Restore cache from serialized data (after DO hibernation wake).
   * Clears existing entries before restoring.
   */
  deserialize(data: CachedEmbeddingSerialized[]): void {
    this.entries.clear();
    for (const item of data) {
      this.entries.set(item.segment_id, {
        segment_id: item.segment_id,
        embedding: base64ToFloat32(item.embedding_b64),
        start_ms: item.start_ms,
        end_ms: item.end_ms,
        window_cluster_id: item.window_cluster_id,
        stream_role: item.stream_role,
      });
    }
  }
}

// ── Base64 helpers for Float32Array serialization ────────────────────────────

/** Encode a Float32Array to a base64 string. */
export function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a base64 string back to a Float32Array. */
export function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}
