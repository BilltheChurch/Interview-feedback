import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  DEFAULT_PROVIDER_CONFIG,
  type ASRProvider,
  type DiarizationProvider,
  type SpeakerVerificationProvider,
  type LLMProvider,
  type ProviderConfig,
  type CachedEmbedding,
  type CachedEmbeddingSerialized,
  type ClusterOptions,
  type GlobalClusterResult,
  type Utterance,
  type SpeakerSegment,
  type DiarizeResult,
  type CaptionEvent,
} from "../src/providers/types";

/* ── DEFAULT_PROVIDER_CONFIG ────────────────── */

describe("DEFAULT_PROVIDER_CONFIG", () => {
  it("has correct default ASR settings", () => {
    expect(DEFAULT_PROVIDER_CONFIG.asr.streaming).toBe("funASR");
    expect(DEFAULT_PROVIDER_CONFIG.asr.batch).toBe("local-whisper");
    expect(DEFAULT_PROVIDER_CONFIG.asr.model).toBe("large-v3");
    expect(DEFAULT_PROVIDER_CONFIG.asr.language).toBe("auto");
  });

  it("has correct default diarization settings", () => {
    expect(DEFAULT_PROVIDER_CONFIG.diarization.streaming).toBe("pyannote-rs");
    expect(DEFAULT_PROVIDER_CONFIG.diarization.batch).toBe("pyannote-full");
    expect(DEFAULT_PROVIDER_CONFIG.diarization.max_speakers).toBe(6);
  });

  it("has Tier 2 disabled by default", () => {
    expect(DEFAULT_PROVIDER_CONFIG.tier2.enabled).toBe(false);
    expect(DEFAULT_PROVIDER_CONFIG.tier2.auto_trigger).toBe(false);
    expect(DEFAULT_PROVIDER_CONFIG.tier2.processor).toBe("local");
  });
});

/* ── ProviderRegistry ───────────────────────── */

describe("ProviderRegistry", () => {
  const config: ProviderConfig = { ...DEFAULT_PROVIDER_CONFIG };

  function makeRegistry(): ProviderRegistry {
    return new ProviderRegistry(config);
  }

  it("returns the config it was created with", () => {
    const registry = makeRegistry();
    expect(registry.getConfig()).toEqual(config);
  });

  it("throws when getting unregistered ASR provider", () => {
    const registry = makeRegistry();
    expect(() => registry.getASR()).toThrow("ASR provider");
  });

  it("throws when getting unregistered diarization provider", () => {
    const registry = makeRegistry();
    expect(() => registry.getDiarization()).toThrow("Diarization provider");
  });

  it("throws when getting unregistered speaker verification provider", () => {
    const registry = makeRegistry();
    expect(() => registry.getSpeakerVerification()).toThrow("Speaker verification provider");
  });

  it("throws when getting unregistered LLM provider", () => {
    const registry = makeRegistry();
    expect(() => registry.getLLM()).toThrow("LLM provider");
  });

  it("reports hasProvider=false for unregistered providers", () => {
    const registry = makeRegistry();
    expect(registry.hasProvider("asr")).toBe(false);
    expect(registry.hasProvider("diarization")).toBe(false);
    expect(registry.hasProvider("speaker_verification")).toBe(false);
    expect(registry.hasProvider("llm")).toBe(false);
  });

  it("registers and retrieves an ASR provider", () => {
    const registry = makeRegistry();
    const mockASR: ASRProvider = { name: "test-asr", mode: "streaming" };
    registry.registerASR(mockASR);
    expect(registry.getASR()).toBe(mockASR);
    expect(registry.hasProvider("asr")).toBe(true);
  });

  it("registers and retrieves a diarization provider", () => {
    const registry = makeRegistry();
    const mockDiarize: DiarizationProvider = { name: "test-diarize", mode: "batch" };
    registry.registerDiarization(mockDiarize);
    expect(registry.getDiarization()).toBe(mockDiarize);
    expect(registry.hasProvider("diarization")).toBe(true);
  });

  it("registers and retrieves a speaker verification provider", () => {
    const registry = makeRegistry();
    const mockSV: SpeakerVerificationProvider = {
      name: "test-sv",
      extractEmbedding: async () => new Float32Array(512),
      scoreEmbeddings: () => 0.95,
    };
    registry.registerSpeakerVerification(mockSV);
    expect(registry.getSpeakerVerification()).toBe(mockSV);
    expect(registry.hasProvider("speaker_verification")).toBe(true);
  });

  it("registers and retrieves an LLM provider", () => {
    const registry = makeRegistry();
    const mockLLM: LLMProvider = {
      name: "test-llm",
      synthesizeReport: async () => ({
        overall: {},
        per_person: [],
        model_used: "test",
        generation_ms: 100,
      }),
    };
    registry.registerLLM(mockLLM);
    expect(registry.getLLM()).toBe(mockLLM);
    expect(registry.hasProvider("llm")).toBe(true);
  });

  it("allows replacing a registered provider", () => {
    const registry = makeRegistry();
    const first: ASRProvider = { name: "first", mode: "streaming" };
    const second: ASRProvider = { name: "second", mode: "batch" };
    registry.registerASR(first);
    expect(registry.getASR().name).toBe("first");
    registry.registerASR(second);
    expect(registry.getASR().name).toBe("second");
  });
});

/* ── Type structure smoke tests ─────────────── */

describe("type structure smoke tests", () => {
  it("CachedEmbedding has expected shape", () => {
    const entry: CachedEmbedding = {
      segment_id: "seg_001",
      embedding: new Float32Array(512),
      start_ms: 0,
      end_ms: 1000,
      window_cluster_id: "SPEAKER_00",
      stream_role: "students",
    };
    expect(entry.segment_id).toBe("seg_001");
    expect(entry.embedding.length).toBe(512);
    expect(entry.stream_role).toBe("students");
  });

  it("CachedEmbeddingSerialized has base64 field", () => {
    const serialized: CachedEmbeddingSerialized = {
      segment_id: "seg_001",
      embedding_b64: "AAAA",
      start_ms: 0,
      end_ms: 1000,
      window_cluster_id: "SPEAKER_00",
      stream_role: "teacher",
    };
    expect(serialized.embedding_b64).toBe("AAAA");
  });

  it("ClusterOptions has correct defaults conceptually", () => {
    const opts: ClusterOptions = {
      distance_threshold: 0.3,
      linkage: "average",
      min_cluster_size: 1,
    };
    expect(opts.distance_threshold).toBe(0.3);
    expect(opts.linkage).toBe("average");
    expect(opts.max_clusters).toBeUndefined();
  });

  it("GlobalClusterResult uses Maps", () => {
    const result: GlobalClusterResult = {
      clusters: new Map([["spk_0", ["seg_001", "seg_002"]]]),
      centroids: new Map([["spk_0", new Float32Array(512)]]),
      confidence: 0.85,
    };
    expect(result.clusters.get("spk_0")?.length).toBe(2);
    expect(result.centroids.get("spk_0")?.length).toBe(512);
  });

  it("Utterance supports optional word-level timestamps", () => {
    const utt: Utterance = {
      id: "u_001",
      text: "Hello world",
      start_ms: 0,
      end_ms: 2000,
      words: [
        { word: "Hello", start_ms: 0, end_ms: 800 },
        { word: "world", start_ms: 900, end_ms: 2000, confidence: 0.99 },
      ],
      language: "en",
      confidence: 0.95,
    };
    expect(utt.words?.length).toBe(2);
  });

  it("DiarizeResult indicates global clustering status", () => {
    const batchResult: DiarizeResult = {
      segments: [{ id: "s1", speaker_id: "spk_0", start_ms: 0, end_ms: 5000 }],
      global_clustering_done: true,
    };
    expect(batchResult.global_clustering_done).toBe(true);

    const streamResult: DiarizeResult = {
      segments: [{ id: "s2", speaker_id: "SPEAKER_00", start_ms: 0, end_ms: 5000 }],
      global_clustering_done: false,
    };
    expect(streamResult.global_clustering_done).toBe(false);
  });
});

/* ── CaptionEvent type ────────────────────────── */

describe("CaptionEvent type", () => {
  it("should be assignable with required fields", () => {
    const event: CaptionEvent = {
      speaker: "Tim Yang",
      text: "请介绍一下你自己",
      language: "zh-cn",
      timestamp_ms: 5000,
    };
    expect(event.speaker).toBe("Tim Yang");
    expect(event.text).toBe("请介绍一下你自己");
  });

  it("should accept optional teamsUserId", () => {
    const event: CaptionEvent = {
      speaker: "Tim Yang",
      text: "Hello",
      language: "en-us",
      timestamp_ms: 1000,
      teamsUserId: "abc-123",
    };
    expect(event.teamsUserId).toBe("abc-123");
  });
});
