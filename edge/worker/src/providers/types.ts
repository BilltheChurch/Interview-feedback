/**
 * Provider interface types for the pluggable diarization architecture.
 *
 * Four provider types abstract the AI pipeline:
 *   1. ASRProvider — speech-to-text (streaming + batch)
 *   2. DiarizationProvider — speaker segmentation (streaming + batch)
 *   3. SpeakerVerificationProvider — embedding extraction + similarity scoring
 *   4. LLMProvider — report synthesis
 *
 * Each interface supports the two-tier processing model:
 *   Tier 1: streaming data + fast global clustering → immediate feedback
 *   Tier 2: batch re-processing with full pipelines → refined report
 */

import type { StreamRole } from "../types_v2";

// ── Audio Types ──────────────────────────────────────────────────────────────

/** Raw audio input for batch processing. */
export interface AudioInput {
  /** PCM audio data (16kHz mono pcm_s16le). */
  data: ArrayBuffer;
  /** Sample rate in Hz. Always 16000 for this system. */
  sample_rate: number;
  /** Number of channels. Always 1 (mono). */
  channels: number;
  /** Duration in milliseconds. */
  duration_ms: number;
}

/** Audio chunk for embedding extraction or streaming. */
export interface AudioChunk {
  /** Unique identifier for this chunk. */
  id: string;
  /** PCM audio data. */
  data: ArrayBuffer;
  /** Start time in milliseconds relative to session start. */
  start_ms: number;
  /** End time in milliseconds relative to session start. */
  end_ms: number;
  /** Stream role (teacher mic or students system audio). */
  stream_role: StreamRole;
}

/** Audio window for per-window diarization processing. */
export interface AudioWindow {
  /** Window index (0-based). */
  window_index: number;
  /** PCM audio data for this window. */
  data: ArrayBuffer;
  /** Window start time in ms. */
  start_ms: number;
  /** Window end time in ms. */
  end_ms: number;
  /** Stream role. */
  stream_role: StreamRole;
}

// ── ASR Provider ─────────────────────────────────────────────────────────────

/** Configuration for starting a streaming ASR session. */
export interface ASRStreamConfig {
  /** Language hint (e.g. 'zh', 'en', 'auto'). */
  language: string;
  /** Sample rate in Hz. */
  sample_rate: number;
  /** Model name override (provider-specific). */
  model?: string;
}

/** A single word with timing information. */
export interface WordTimestamp {
  word: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
}

/** A transcribed utterance (sentence or segment). */
export interface Utterance {
  id: string;
  text: string;
  start_ms: number;
  end_ms: number;
  /** Word-level alignment (available in Tier 2 batch mode). */
  words?: WordTimestamp[];
  /** Detected language. */
  language?: string;
  /** ASR confidence score [0, 1]. */
  confidence?: number;
}

/** ASR provider interface — streaming and/or batch transcription. */
export interface ASRProvider {
  readonly name: string;
  readonly mode: "streaming" | "batch" | "both";

  /** Start a streaming transcription session. */
  startStreaming?(config: ASRStreamConfig): AsyncIterable<Utterance>;

  /** Batch-transcribe a complete audio file. */
  transcribeBatch?(audio: AudioInput): Promise<Utterance[]>;
}

// ── Diarization Provider ─────────────────────────────────────────────────────

/** A speaker segment from diarization. */
export interface SpeakerSegment {
  /** Unique segment identifier. */
  id: string;
  /** Speaker ID (local per-window or global depending on provider). */
  speaker_id: string;
  /** Segment start in ms. */
  start_ms: number;
  /** Segment end in ms. */
  end_ms: number;
  /** Diarization confidence [0, 1]. */
  confidence?: number;
}

/** Result from diarization (streaming window or batch). */
export interface DiarizeResult {
  segments: SpeakerSegment[];
  /** Optional speaker embeddings extracted during diarization. */
  embeddings?: Map<string, Float32Array>;
  /** Whether global clustering has been performed (true for batch, false for per-window). */
  global_clustering_done: boolean;
}

/** Options for batch diarization. */
export interface DiarizeOptions {
  /** Exact number of speakers (if known). */
  num_speakers?: number;
  /** Minimum expected speakers. */
  min_speakers?: number;
  /** Maximum expected speakers. */
  max_speakers?: number;
  /** Embedding model to use. */
  embedding_model?: "wespeaker" | "cam++" | "ecapa";
}

/** Diarization provider — per-window streaming or full-file batch. */
export interface DiarizationProvider {
  readonly name: string;
  readonly mode: "streaming" | "batch" | "both";

  /** Process a single audio window (streaming/per-window mode). */
  processWindow?(window: AudioWindow): Promise<DiarizeResult>;

  /** Full-file diarization with global clustering (batch mode). */
  diarizeBatch?(audio: AudioInput, opts?: DiarizeOptions): Promise<DiarizeResult>;
}

// ── Speaker Verification Provider ────────────────────────────────────────────

/** Speaker verification — embedding extraction and similarity scoring. */
export interface SpeakerVerificationProvider {
  readonly name: string;

  /** Extract a speaker embedding vector from an audio chunk. */
  extractEmbedding(audio: AudioChunk): Promise<Float32Array>;

  /** Score similarity between two embedding vectors. Returns cosine similarity [0, 1]. */
  scoreEmbeddings(a: Float32Array, b: Float32Array): number;

  /** Batch extract embeddings for multiple segments. */
  extractBatch?(segments: AudioChunk[]): Promise<Map<string, Float32Array>>;
}

// ── LLM Provider ─────────────────────────────────────────────────────────────

/** Context passed to LLM for report generation. */
export interface ReportContext {
  session_id: string;
  transcript: Array<{
    utterance_id: string;
    stream_role: string;
    speaker_name?: string | null;
    text: string;
    start_ms: number;
    end_ms: number;
  }>;
  memos: Array<{
    memo_id: string;
    text: string;
    type: string;
    tags: string[];
  }>;
  stats: Array<{
    speaker_key: string;
    speaker_name?: string | null;
    talk_time_ms: number;
    turns: number;
  }>;
  locale: string;
}

/** Generated feedback report. */
export interface Report {
  overall: unknown;
  per_person: Array<{
    person_key: string;
    display_name: string;
    dimensions: unknown[];
    summary: {
      strengths: string[];
      risks: string[];
      actions: string[];
    };
  }>;
  model_used: string;
  generation_ms: number;
}

/** Claim regeneration input. */
export interface Claim {
  claim_id: string;
  text: string;
  evidence_refs: string[];
  confidence: number;
}

/** LLM provider — report synthesis and claim regeneration. */
export interface LLMProvider {
  readonly name: string;

  /** Generate a full feedback report from session context. */
  synthesizeReport(context: ReportContext): Promise<Report>;

  /** Regenerate a specific claim with updated evidence. */
  regenerateClaim?(claim: Claim, context: ReportContext): Promise<Claim>;
}

// ── Embedding Cache Types ────────────────────────────────────────────────────

/** A cached speaker embedding from incremental extraction during recording. */
export interface CachedEmbedding {
  /** Unique segment identifier. */
  segment_id: string;
  /** 512-dimensional speaker embedding vector. */
  embedding: Float32Array;
  /** Segment start time in ms. */
  start_ms: number;
  /** Segment end time in ms. */
  end_ms: number;
  /** Per-window cluster ID (NOT globally consistent). */
  window_cluster_id: string;
  /** Which audio stream this came from. */
  stream_role: "students" | "teacher";
}

/** Serializable form of CachedEmbedding for Durable Object hibernation. */
export interface CachedEmbeddingSerialized {
  segment_id: string;
  /** Base64-encoded Float32Array bytes. */
  embedding_b64: string;
  start_ms: number;
  end_ms: number;
  window_cluster_id: string;
  stream_role: "students" | "teacher";
}

// ── Global Clustering Types ──────────────────────────────────────────────────

/** Options for the agglomerative clustering algorithm. */
export interface ClusterOptions {
  /** Cosine distance threshold for merging clusters. Default 0.3. */
  distance_threshold: number;
  /** Linkage criterion. Default 'average'. */
  linkage: "average" | "complete" | "single";
  /** Minimum segments per cluster. Default 1. */
  min_cluster_size: number;
  /** Maximum number of clusters (optional hint). */
  max_clusters?: number;
}

/** Result from global clustering of cached embeddings. */
export interface GlobalClusterResult {
  /** global_speaker_id -> [segment_ids] */
  clusters: Map<string, string[]>;
  /** global_speaker_id -> centroid embedding vector */
  centroids: Map<string, Float32Array>;
  /** Overall clustering confidence [0, 1]. */
  confidence: number;
}

// ── Provider Configuration ───────────────────────────────────────────────────

/** Session-level provider configuration. */
export interface ProviderConfig {
  asr: {
    streaming: "funASR" | "groq" | "openai" | "local-whisper" | "streaming-whisper";
    batch: "local-whisper" | "groq" | "openai" | "funASR";
    model?: string;
    language?: string;
  };
  diarization: {
    streaming: "pyannote-rs" | "diart" | "none";
    batch: "pyannote-full" | "none";
    max_speakers?: number;
  };
  speaker_verification: "cam-pp-inference" | "cam-pp-local" | "wespeaker-local";
  llm: "dashscope" | "openai" | "ollama";
  tier2: {
    enabled: boolean;
    auto_trigger: boolean;
    processor: "local" | "remote";
    endpoint?: string;
  };
}

/** Default provider config for the mock interview trainer persona. */
export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  asr: {
    streaming: "funASR",
    batch: "local-whisper",
    model: "large-v3",
    language: "auto",
  },
  diarization: {
    streaming: "pyannote-rs",
    batch: "pyannote-full",
    max_speakers: 6,
  },
  speaker_verification: "cam-pp-inference",
  llm: "dashscope",
  tier2: {
    enabled: false,
    auto_trigger: false,
    processor: "local",
  },
};

// ── Provider Registry ────────────────────────────────────────────────────────

/**
 * Registry that manages provider instances by configuration.
 * Lazily instantiates providers on first access.
 */
export class ProviderRegistry {
  private readonly config: ProviderConfig;
  private asrProvider: ASRProvider | null = null;
  private diarizationProvider: DiarizationProvider | null = null;
  private svProvider: SpeakerVerificationProvider | null = null;
  private llmProvider: LLMProvider | null = null;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  getConfig(): ProviderConfig {
    return this.config;
  }

  /** Register a pre-built ASR provider instance. */
  registerASR(provider: ASRProvider): void {
    this.asrProvider = provider;
  }

  /** Register a pre-built diarization provider instance. */
  registerDiarization(provider: DiarizationProvider): void {
    this.diarizationProvider = provider;
  }

  /** Register a pre-built speaker verification provider instance. */
  registerSpeakerVerification(provider: SpeakerVerificationProvider): void {
    this.svProvider = provider;
  }

  /** Register a pre-built LLM provider instance. */
  registerLLM(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  /** Get the configured ASR provider. Throws if not registered. */
  getASR(): ASRProvider {
    if (!this.asrProvider) {
      throw new Error(`ASR provider '${this.config.asr.streaming}' not registered`);
    }
    return this.asrProvider;
  }

  /** Get the configured diarization provider. Throws if not registered. */
  getDiarization(): DiarizationProvider {
    if (!this.diarizationProvider) {
      throw new Error(`Diarization provider '${this.config.diarization.streaming}' not registered`);
    }
    return this.diarizationProvider;
  }

  /** Get the configured speaker verification provider. Throws if not registered. */
  getSpeakerVerification(): SpeakerVerificationProvider {
    if (!this.svProvider) {
      throw new Error(`Speaker verification provider '${this.config.speaker_verification}' not registered`);
    }
    return this.svProvider;
  }

  /** Get the configured LLM provider. Throws if not registered. */
  getLLM(): LLMProvider {
    if (!this.llmProvider) {
      throw new Error(`LLM provider '${this.config.llm}' not registered`);
    }
    return this.llmProvider;
  }

  /** Check if a specific provider type has been registered. */
  hasProvider(type: "asr" | "diarization" | "speaker_verification" | "llm"): boolean {
    switch (type) {
      case "asr": return this.asrProvider !== null;
      case "diarization": return this.diarizationProvider !== null;
      case "speaker_verification": return this.svProvider !== null;
      case "llm": return this.llmProvider !== null;
    }
  }
}

// ── Caption Types (ACS Teams Interop) ────────────────────────────────────────

/** A single caption event received from ACS TeamsCaptions. */
export interface CaptionEvent {
  /** Speaker display name from Teams meeting roster. */
  speaker: string;
  /** Transcribed text (final). */
  text: string;
  /** Spoken language (BCP 47, e.g. 'zh-cn', 'en-us'). */
  language: string;
  /** Timestamp in ms relative to session start. */
  timestamp_ms: number;
  /** Microsoft Teams user ID for stable identity across sessions. */
  teamsUserId?: string;
}
