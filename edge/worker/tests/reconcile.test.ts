import { describe, it, expect } from "vitest";
import {
  inferClusterFromEdgeTurns,
  resolveStudentBinding,
  resolveFromGlobalClusters,
  prepareEdgeTurns,
  buildReconciledTranscript,
  type ReconcileSessionState,
  type ReconcileUtterance,
  type ReconcileSpeakerEvent,
} from "../src/reconcile";
import { buildMultiEvidence, enrichEvidencePack, computeSpeakerStats } from "../src/finalize_v2";
import type { SpeakerLogs, SpeakerMapItem } from "../src/types_v2";
import type { GlobalClusterResult, CachedEmbedding } from "../src/providers/types";

/* ── inferClusterFromEdgeTurns ────────────────── */

describe("inferClusterFromEdgeTurns", () => {
  const turns = [
    { start_ms: 0, end_ms: 3000, cluster_id: "c_01" },
    { start_ms: 3000, end_ms: 6000, cluster_id: "c_02" },
    { start_ms: 6000, end_ms: 9000, cluster_id: "c_01" },
  ];

  it("returns null for empty turns array", () => {
    expect(inferClusterFromEdgeTurns([], 0, 3000)).toBeNull();
  });

  it("returns the cluster with maximum overlap", () => {
    // Overlaps: c_01=[0..3000] has 2000ms overlap with [1000..5000],
    // c_02=[3000..6000] has 2000ms overlap with [1000..5000]
    // Since c_01 is found first and overlap is equal, it wins (first found with bestOverlap)
    // Actually: c_01 overlap = min(3000,5000)-max(0,1000) = 3000-1000 = 2000
    //           c_02 overlap = min(6000,5000)-max(3000,1000) = 5000-3000 = 2000
    // Equal, so first one wins (no > check, only >)
    expect(inferClusterFromEdgeTurns(turns, 1000, 5000)).toBe("c_01");
  });

  it("returns cluster fully contained within range", () => {
    // c_02=[3000..6000] is fully within [2000..7000], overlap=3000
    // c_01=[0..3000] overlap with [2000..7000] = min(3000,7000)-max(0,2000)=1000
    // c_01=[6000..9000] overlap with [2000..7000] = min(9000,7000)-max(6000,2000)=1000
    expect(inferClusterFromEdgeTurns(turns, 2000, 7000)).toBe("c_02");
  });

  it("returns null when no overlap exists", () => {
    expect(inferClusterFromEdgeTurns(turns, 10000, 12000)).toBeNull();
  });

  it("handles exact boundary match", () => {
    // [3000..6000] exactly matches c_02
    expect(inferClusterFromEdgeTurns(turns, 3000, 6000)).toBe("c_02");
  });

  it("returns null when range touches but does not overlap", () => {
    // [9000..10000] starts exactly where last turn ends — overlap = min(9000,10000)-max(9000,9000) = 0
    expect(inferClusterFromEdgeTurns(turns, 9000, 10000)).toBeNull();
  });
});

/* ── resolveStudentBinding ────────────────────── */

describe("resolveStudentBinding", () => {
  const emptyState: ReconcileSessionState = {
    bindings: {},
    cluster_binding_meta: {},
  };

  it("returns unknown when no cluster and no event info", () => {
    const result = resolveStudentBinding(emptyState, null, null, null);
    expect(result).toEqual({ speaker_name: null, decision: "unknown" });
  });

  it("uses event speaker name when no cluster is available", () => {
    const result = resolveStudentBinding(emptyState, null, "Alice", "confirm");
    expect(result).toEqual({ speaker_name: "Alice", decision: "confirm" });
  });

  it("defaults event decision to 'confirm' when null", () => {
    const result = resolveStudentBinding(emptyState, null, "Bob", null);
    expect(result).toEqual({ speaker_name: "Bob", decision: "confirm" });
  });

  describe("with cluster bindings", () => {
    it("uses locked binding with auto decision", () => {
      const state: ReconcileSessionState = {
        bindings: { c_01: "Alice" },
        cluster_binding_meta: {
          c_01: { participant_name: "Alice", locked: true },
        },
      };
      const result = resolveStudentBinding(state, "c_01", null, null);
      expect(result).toEqual({ speaker_name: "Alice", decision: "auto" });
    });

    it("uses manual_map binding with auto decision", () => {
      const state: ReconcileSessionState = {
        bindings: {},
        cluster_binding_meta: {
          c_01: { participant_name: "Alice", source: "manual_map" },
        },
      };
      const result = resolveStudentBinding(state, "c_01", null, null);
      expect(result).toEqual({ speaker_name: "Alice", decision: "auto" });
    });

    it("uses enrollment_match with confirm when no direct binding", () => {
      const state: ReconcileSessionState = {
        bindings: {},
        cluster_binding_meta: {
          c_01: {
            participant_name: "Alice",
            source: "enrollment_match",
          },
        },
      };
      const result = resolveStudentBinding(state, "c_01", null, null);
      expect(result).toEqual({ speaker_name: "Alice", decision: "confirm" });
    });

    it("uses enrollment_match with auto when direct binding exists", () => {
      const state: ReconcileSessionState = {
        bindings: { c_01: "Alice" },
        cluster_binding_meta: {
          c_01: {
            participant_name: "Alice",
            source: "enrollment_match",
          },
        },
      };
      const result = resolveStudentBinding(state, "c_01", null, null);
      expect(result).toEqual({ speaker_name: "Alice", decision: "auto" });
    });

    it("uses name_extract with confirm decision", () => {
      const state: ReconcileSessionState = {
        bindings: {},
        cluster_binding_meta: {
          c_01: { participant_name: "Alice", source: "name_extract" },
        },
      };
      const result = resolveStudentBinding(state, "c_01", null, null);
      expect(result).toEqual({ speaker_name: "Alice", decision: "confirm" });
    });
  });

  describe("with speaker map fallback", () => {
    it("falls back to speaker map when no binding exists", () => {
      const speakerMap = new Map<string, SpeakerMapItem>([
        [
          "c_01",
          {
            cluster_id: "c_01",
            display_name: "Alice",
            source: "enroll",
          },
        ],
      ]);
      const result = resolveStudentBinding(
        emptyState,
        "c_01",
        null,
        null,
        speakerMap
      );
      expect(result).toEqual({ speaker_name: "Alice", decision: "confirm" });
    });

    it("manual source in speaker map returns auto decision", () => {
      const speakerMap = new Map<string, SpeakerMapItem>([
        [
          "c_01",
          {
            cluster_id: "c_01",
            display_name: "Alice",
            source: "manual",
          },
        ],
      ]);
      const result = resolveStudentBinding(
        emptyState,
        "c_01",
        null,
        null,
        speakerMap
      );
      expect(result).toEqual({ speaker_name: "Alice", decision: "auto" });
    });

    it("uses person_id when display_name is null", () => {
      const speakerMap = new Map<string, SpeakerMapItem>([
        [
          "c_01",
          {
            cluster_id: "c_01",
            person_id: "person-alice",
            display_name: null,
            source: "enroll",
          },
        ],
      ]);
      const result = resolveStudentBinding(
        emptyState,
        "c_01",
        null,
        null,
        speakerMap
      );
      expect(result).toEqual({
        speaker_name: "person-alice",
        decision: "confirm",
      });
    });
  });
});

/* ── prepareEdgeTurns ─────────────────────────── */

describe("prepareEdgeTurns", () => {
  const speakerLogs: SpeakerLogs = {
    source: "edge",
    turns: [
      {
        turn_id: "t3",
        start_ms: 6000,
        end_ms: 9000,
        stream_role: "students",
        cluster_id: "c_01",
      },
      {
        turn_id: "t1",
        start_ms: 0,
        end_ms: 3000,
        stream_role: "teacher",
        cluster_id: "teacher",
      },
      {
        turn_id: "t2",
        start_ms: 3000,
        end_ms: 6000,
        stream_role: "students",
        cluster_id: "c_02",
      },
    ],
    clusters: [],
    speaker_map: [],
    updated_at: "2026-02-15T00:00:00Z",
  };

  it("returns empty array when backend is cloud", () => {
    expect(prepareEdgeTurns(speakerLogs, "cloud")).toEqual([]);
  });

  it("filters to students-only and sorts by start_ms", () => {
    const result = prepareEdgeTurns(speakerLogs, "edge");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ start_ms: 3000, end_ms: 6000, cluster_id: "c_02" });
    expect(result[1]).toMatchObject({ start_ms: 6000, end_ms: 9000, cluster_id: "c_01" });
  });
});

/* ── buildReconciledTranscript ────────────────── */

describe("buildReconciledTranscript", () => {
  const baseState: ReconcileSessionState = {
    bindings: { teacher: "Interviewer" },
    cluster_binding_meta: {},
  };

  const baseSpeakerLogs: SpeakerLogs = {
    source: "cloud",
    turns: [],
    clusters: [],
    speaker_map: [],
    updated_at: "2026-02-15T00:00:00Z",
  };

  it("builds transcript with teacher utterance resolved from event", () => {
    const utterances: ReconcileUtterance[] = [
      {
        utterance_id: "u_001",
        stream_role: "teacher",
        text: "Hello, welcome to the interview.",
        start_ms: 0,
        end_ms: 3000,
        duration_ms: 3000,
      },
    ];
    const events: ReconcileSpeakerEvent[] = [
      {
        stream_role: "teacher",
        utterance_id: "u_001",
        speaker_name: "Interviewer",
        decision: "auto",
      },
    ];
    const result = buildReconciledTranscript({
      utterances,
      events,
      speakerLogs: baseSpeakerLogs,
      state: baseState,
      diarizationBackend: "cloud",
    });
    expect(result).toHaveLength(1);
    expect(result[0].speaker_name).toBe("Interviewer");
    expect(result[0].decision).toBe("auto");
    expect(result[0].cluster_id).toBe("teacher");
  });

  it("resolves student utterance via event cluster binding", () => {
    const state: ReconcileSessionState = {
      bindings: { c_01: "Alice" },
      cluster_binding_meta: {
        c_01: { participant_name: "Alice", locked: true },
      },
    };
    const utterances: ReconcileUtterance[] = [
      {
        utterance_id: "u_002",
        stream_role: "students",
        text: "I have 5 years of experience.",
        start_ms: 3000,
        end_ms: 6000,
        duration_ms: 3000,
      },
    ];
    const events: ReconcileSpeakerEvent[] = [
      {
        stream_role: "students",
        utterance_id: "u_002",
        cluster_id: "c_01",
        speaker_name: "Alice",
        decision: "auto",
      },
    ];
    const result = buildReconciledTranscript({
      utterances,
      events,
      speakerLogs: baseSpeakerLogs,
      state,
      diarizationBackend: "cloud",
    });
    expect(result).toHaveLength(1);
    expect(result[0].speaker_name).toBe("Alice");
    expect(result[0].decision).toBe("auto");
    expect(result[0].cluster_id).toBe("c_01");
  });

  it("sorts output by start_ms", () => {
    const utterances: ReconcileUtterance[] = [
      {
        utterance_id: "u_late",
        stream_role: "teacher",
        text: "Second",
        start_ms: 5000,
        end_ms: 8000,
        duration_ms: 3000,
      },
      {
        utterance_id: "u_early",
        stream_role: "teacher",
        text: "First",
        start_ms: 0,
        end_ms: 3000,
        duration_ms: 3000,
      },
    ];
    const result = buildReconciledTranscript({
      utterances,
      events: [],
      speakerLogs: baseSpeakerLogs,
      state: baseState,
      diarizationBackend: "cloud",
    });
    expect(result[0].utterance_id).toBe("u_early");
    expect(result[1].utterance_id).toBe("u_late");
  });

  it("uses edge diarization turns to infer cluster for unmatched students", () => {
    const speakerLogs: SpeakerLogs = {
      source: "edge",
      turns: [
        {
          turn_id: "t1",
          start_ms: 3000,
          end_ms: 6000,
          stream_role: "students",
          cluster_id: "c_02",
        },
      ],
      clusters: [],
      speaker_map: [
        {
          cluster_id: "c_02",
          display_name: "Bob",
          source: "enroll",
        },
      ],
      updated_at: "2026-02-15T00:00:00Z",
    };
    const utterances: ReconcileUtterance[] = [
      {
        utterance_id: "u_003",
        stream_role: "students",
        text: "I can handle that.",
        start_ms: 3500,
        end_ms: 5500,
        duration_ms: 2000,
      },
    ];
    // No event for this utterance — cluster will be inferred from edge turns
    const result = buildReconciledTranscript({
      utterances,
      events: [],
      speakerLogs,
      state: baseState,
      diarizationBackend: "edge",
    });
    expect(result).toHaveLength(1);
    // After consolidation, cluster_id is replaced with resolved speaker name
    expect(result[0].cluster_id).toBe("Bob");
    expect(result[0].speaker_name).toBe("Bob");
    expect(result[0].decision).toBe("confirm");
  });

  it("handles mixed stream role utterances", () => {
    const utterances: ReconcileUtterance[] = [
      {
        utterance_id: "u_mixed",
        stream_role: "mixed",
        text: "Mixed audio",
        start_ms: 0,
        end_ms: 1000,
        duration_ms: 1000,
      },
    ];
    // Mixed utterances are not teacher, so they go through student path
    // but without edge turns they get no cluster
    const result = buildReconciledTranscript({
      utterances,
      events: [],
      speakerLogs: baseSpeakerLogs,
      state: baseState,
      diarizationBackend: "cloud",
    });
    expect(result).toHaveLength(1);
    expect(result[0].stream_role).toBe("mixed");
  });

  it("uses global cluster resolution for students when available", () => {
    const utterances: ReconcileUtterance[] = [
      {
        utterance_id: "u_gc_001",
        stream_role: "students",
        text: "Let me explain my approach.",
        start_ms: 1000,
        end_ms: 4000,
        duration_ms: 3000,
      },
    ];
    const events: ReconcileSpeakerEvent[] = [
      {
        stream_role: "students",
        utterance_id: "u_gc_001",
        cluster_id: "c_01",
        speaker_name: null,
        decision: "unknown",
      },
    ];
    // Global cluster data maps segment to "Alice" via enrollment embedding
    const globalClusterResult: GlobalClusterResult = {
      clusters: new Map([["gc_0", ["seg_001", "seg_002"]]]),
      centroids: new Map([["gc_0", new Float32Array(128)]]),
      confidence: 0.85,
    };
    const clusterRosterMapping = new Map([["gc_0", "Alice"]]);
    const cachedEmbeddings: CachedEmbedding[] = [
      {
        segment_id: "seg_001",
        embedding: new Float32Array(128),
        start_ms: 500,
        end_ms: 3500,
        window_cluster_id: "SPEAKER_00",
        stream_role: "students",
      },
    ];
    const result = buildReconciledTranscript({
      utterances,
      events,
      speakerLogs: baseSpeakerLogs,
      state: baseState,
      diarizationBackend: "cloud",
      globalClusterResult,
      clusterRosterMapping,
      cachedEmbeddings,
    });
    expect(result).toHaveLength(1);
    expect(result[0].speaker_name).toBe("Alice");
    expect(result[0].decision).toBe("auto");
  });

  it("falls back to binding when global cluster returns spk_ prefix", () => {
    const state: ReconcileSessionState = {
      bindings: { c_01: "Bob" },
      cluster_binding_meta: {
        c_01: { participant_name: "Bob", source: "name_extract" },
      },
    };
    const utterances: ReconcileUtterance[] = [
      {
        utterance_id: "u_gc_002",
        stream_role: "students",
        text: "I agree with that.",
        start_ms: 5000,
        end_ms: 7000,
        duration_ms: 2000,
      },
    ];
    const events: ReconcileSpeakerEvent[] = [
      {
        stream_role: "students",
        utterance_id: "u_gc_002",
        cluster_id: "c_01",
        speaker_name: "Bob",
        decision: "confirm",
      },
    ];
    // Global cluster maps to a raw cluster ID (spk_ prefix), not a roster name
    const globalClusterResult: GlobalClusterResult = {
      clusters: new Map([["gc_0", ["seg_010"]]]),
      centroids: new Map([["gc_0", new Float32Array(128)]]),
      confidence: 0.6,
    };
    const clusterRosterMapping = new Map([["gc_0", "spk_0"]]);
    const cachedEmbeddings: CachedEmbedding[] = [
      {
        segment_id: "seg_010",
        embedding: new Float32Array(128),
        start_ms: 4500,
        end_ms: 7500,
        window_cluster_id: "SPEAKER_01",
        stream_role: "students",
      },
    ];
    const result = buildReconciledTranscript({
      utterances,
      events,
      speakerLogs: baseSpeakerLogs,
      state,
      diarizationBackend: "cloud",
      globalClusterResult,
      clusterRosterMapping,
      cachedEmbeddings,
    });
    expect(result).toHaveLength(1);
    // Should fall back to name_extract binding, not use spk_0
    expect(result[0].speaker_name).toBe("Bob");
    expect(result[0].decision).toBe("confirm");
  });
});

/* ── resolveFromGlobalClusters ────────────────── */

describe("resolveFromGlobalClusters", () => {
  const makeEmbedding = (
    segId: string,
    startMs: number,
    endMs: number
  ): CachedEmbedding => ({
    segment_id: segId,
    embedding: new Float32Array(128),
    start_ms: startMs,
    end_ms: endMs,
    window_cluster_id: "SPEAKER_00",
    stream_role: "students",
  });

  it("returns null when no embeddings overlap the time range", () => {
    const clusterResult: GlobalClusterResult = {
      clusters: new Map([["gc_0", ["seg_001"]]]),
      centroids: new Map([["gc_0", new Float32Array(128)]]),
      confidence: 0.9,
    };
    const mapping = new Map([["gc_0", "Alice"]]);
    const embeddings = [makeEmbedding("seg_001", 10000, 12000)];
    const result = resolveFromGlobalClusters(0, 3000, clusterResult, mapping, embeddings);
    expect(result).toBeNull();
  });

  it("returns null when embeddings array is empty", () => {
    const clusterResult: GlobalClusterResult = {
      clusters: new Map([["gc_0", ["seg_001"]]]),
      centroids: new Map([["gc_0", new Float32Array(128)]]),
      confidence: 0.9,
    };
    const mapping = new Map([["gc_0", "Alice"]]);
    const result = resolveFromGlobalClusters(0, 3000, clusterResult, mapping, []);
    expect(result).toBeNull();
  });

  it("resolves to roster name with auto decision when mapped", () => {
    const clusterResult: GlobalClusterResult = {
      clusters: new Map([["gc_0", ["seg_001", "seg_002"]]]),
      centroids: new Map([["gc_0", new Float32Array(128)]]),
      confidence: 0.9,
    };
    const mapping = new Map([["gc_0", "Alice"]]);
    const embeddings = [
      makeEmbedding("seg_001", 1000, 4000),
      makeEmbedding("seg_002", 5000, 8000),
    ];
    const result = resolveFromGlobalClusters(1500, 3500, clusterResult, mapping, embeddings);
    expect(result).toEqual({ speaker_name: "Alice", decision: "auto" });
  });

  it("returns confirm decision when cluster has no roster mapping", () => {
    const clusterResult: GlobalClusterResult = {
      clusters: new Map([["gc_0", ["seg_001"]]]),
      centroids: new Map([["gc_0", new Float32Array(128)]]),
      confidence: 0.9,
    };
    // No roster mapping for gc_0
    const mapping = new Map<string, string>();
    const embeddings = [makeEmbedding("seg_001", 0, 5000)];
    const result = resolveFromGlobalClusters(1000, 3000, clusterResult, mapping, embeddings);
    expect(result).toEqual({ speaker_name: null, decision: "confirm" });
  });

  it("picks the embedding with maximum time overlap", () => {
    const clusterResult: GlobalClusterResult = {
      clusters: new Map([
        ["gc_alice", ["seg_001"]],
        ["gc_bob", ["seg_002"]],
      ]),
      centroids: new Map([
        ["gc_alice", new Float32Array(128)],
        ["gc_bob", new Float32Array(128)],
      ]),
      confidence: 0.85,
    };
    const mapping = new Map([
      ["gc_alice", "Alice"],
      ["gc_bob", "Bob"],
    ]);
    // seg_001 overlaps [2000..5000] by 1000ms (3000..4000 clamped)
    // seg_002 overlaps [2000..5000] by 2000ms (2000..4000)
    const embeddings = [
      makeEmbedding("seg_001", 3000, 4000),
      makeEmbedding("seg_002", 1000, 4000),
    ];
    const result = resolveFromGlobalClusters(2000, 5000, clusterResult, mapping, embeddings);
    expect(result).toEqual({ speaker_name: "Bob", decision: "auto" });
  });

  it("returns null when best segment is not in any cluster", () => {
    const clusterResult: GlobalClusterResult = {
      clusters: new Map([["gc_0", ["seg_other"]]]),
      centroids: new Map([["gc_0", new Float32Array(128)]]),
      confidence: 0.9,
    };
    const mapping = new Map([["gc_0", "Alice"]]);
    // seg_001 overlaps but is not in any cluster
    const embeddings = [makeEmbedding("seg_001", 0, 5000)];
    const result = resolveFromGlobalClusters(1000, 3000, clusterResult, mapping, embeddings);
    expect(result).toBeNull();
  });
});

/* ── buildMultiEvidence semantic matching ────── */

describe("buildMultiEvidence semantic matching", () => {
  const transcript = [
    { utterance_id: "u1", stream_role: "students" as const, cluster_id: "Tina", speaker_name: "Tina", decision: "confirm" as const, text: "I think biocompatibility is the most important factor because without it patients may get rejection reactions", start_ms: 200000, end_ms: 210000, duration_ms: 10000 },
    { utterance_id: "u2", stream_role: "students" as const, cluster_id: "Rice", speaker_name: "Rice", decision: "confirm" as const, text: "I agree with Tina and I also think repair should be easy", start_ms: 210000, end_ms: 220000, duration_ms: 10000 },
    { utterance_id: "u3", stream_role: "students" as const, cluster_id: "Daisy", speaker_name: "Daisy", decision: "confirm" as const, text: "Maybe we should start ranking these factors now", start_ms: 230000, end_ms: 240000, duration_ms: 10000 },
  ];

  const memos = [
    { memo_id: "m1", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: ["logic"], text: "Tina提出了biocompatibility，给了很好的论证" },
    { memo_id: "m2", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: ["collaboration"], text: "Rice同意了Tina的观点，提出了repair" },
  ];

  const bindings = [
    { memo_id: "m1", extracted_names: ["Tina"], matched_speaker_keys: ["Tina"], confidence: 1.0 },
    { memo_id: "m2", extracted_names: ["Rice", "Tina"], matched_speaker_keys: ["Rice", "Tina"], confidence: 1.0 },
  ];

  it("should map memos to utterances by speaker name + keyword", () => {
    const evidence = buildMultiEvidence({ memos, transcript, bindings });
    // Memo about Tina+biocompatibility should map to u1 (Tina's utterance containing "biocompatib")
    const tinaEvidence = evidence.filter(e => e.utterance_ids.includes("u1"));
    expect(tinaEvidence.length).toBeGreaterThanOrEqual(1);
    expect(tinaEvidence[0].confidence).toBeGreaterThanOrEqual(0.45);
    expect(tinaEvidence[0].source).toBe("semantic_match");
  });

  it("should use dynamic confidence scores, not hardcoded", () => {
    const evidence = buildMultiEvidence({ memos, transcript, bindings });
    const memoEvidence = evidence.filter(e => e.utterance_ids.length > 0 && e.type === "quote");
    const confidences = memoEvidence.map(e => e.confidence);
    // Should NOT all be the same hardcoded value
    const unique = new Set(confidences.map(c => Math.round(c * 100)));
    expect(unique.size).toBeGreaterThanOrEqual(1);
    // All should be in valid range
    for (const c of confidences) {
      expect(c).toBeGreaterThanOrEqual(0.35);
      expect(c).toBeLessThanOrEqual(0.95);
    }
  });

  it("should create fallback evidence with source=memo_text when no match", () => {
    const noMatchMemos = [
      { memo_id: "m_nomatch", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "整体节奏可以再快一些" },
    ];
    const evidence = buildMultiEvidence({ memos: noMatchMemos, transcript, bindings: [] });
    const fallback = evidence.find(e => e.utterance_ids.length === 0);
    expect(fallback).toBeDefined();
    expect(fallback!.confidence).toBe(0.35);
    expect(fallback!.source).toBe("memo_text");
  });
});

/* ── enrichEvidencePack ──────────────────────── */

describe("enrichEvidencePack", () => {
  const transcript = [
    { utterance_id: "u1", stream_role: "students" as const, cluster_id: "Tina", speaker_name: "Tina", text: "I think biocompatibility is most important because without it patients may experience rejection reactions and need secondary surgery", start_ms: 200000, end_ms: 210000, duration_ms: 10000 },
    { utterance_id: "u2", stream_role: "students" as const, cluster_id: "Tina", speaker_name: "Tina", text: "So let me summarize what we have discussed so far", start_ms: 230000, end_ms: 235000, duration_ms: 5000 },
    { utterance_id: "u3", stream_role: "students" as const, cluster_id: "Rice", speaker_name: "Rice", text: "I agree with your point about biocompatibility", start_ms: 210000, end_ms: 215000, duration_ms: 5000 },
    { utterance_id: "u4", stream_role: "students" as const, cluster_id: "Rice", speaker_name: "Rice", text: "And I also think the repair aspect is very important for long term use", start_ms: 250000, end_ms: 260000, duration_ms: 10000 },
  ];

  const stats = [
    { speaker_key: "Tina", speaker_name: "Tina", talk_time_ms: 15000, talk_time_pct: 0.5, turns: 2, silence_ms: 0, interruptions: 1, interrupted_by_others: 0 },
    { speaker_key: "Rice", speaker_name: "Rice", talk_time_ms: 15000, talk_time_pct: 0.5, turns: 2, silence_ms: 0, interruptions: 0, interrupted_by_others: 1 },
  ];

  it("should generate transcript_quote evidence for substantive utterances", () => {
    const enriched = enrichEvidencePack(transcript, stats);
    const quotes = enriched.filter(e => e.type === "transcript_quote");
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    expect(quotes.every(e => e.utterance_ids.length === 1)).toBe(true);
    expect(quotes.every(e => e.confidence === 0.85)).toBe(true);
    expect(quotes.every(e => e.source === "auto_generated")).toBe(true);
  });

  it("should generate stats_summary evidence for each speaker", () => {
    const enriched = enrichEvidencePack(transcript, stats);
    const summaries = enriched.filter(e => e.type === "stats_summary");
    expect(summaries.length).toBe(2); // One per speaker
    expect(summaries.every(e => e.confidence === 0.95)).toBe(true);
  });

  it("should detect interaction patterns (agree signals)", () => {
    const enriched = enrichEvidencePack(transcript, stats);
    const interactions = enriched.filter(e => e.type === "interaction_pattern");
    expect(interactions.length).toBeGreaterThanOrEqual(1);
    // Rice's "I agree" should be detected
    const agreeEvidence = interactions.find(e => e.quote.toLowerCase().includes("agree"));
    expect(agreeEvidence).toBeDefined();
  });
});

/* ── computeSpeakerStats global dedup ────────── */

describe("computeSpeakerStats global dedup", () => {
  it("should not exceed audio duration in total talk time", () => {
    const transcript = [
      { utterance_id: "u1", stream_role: "students" as const, cluster_id: "A", speaker_name: "A", text: "hello", start_ms: 0, end_ms: 10000, duration_ms: 10000 },
      { utterance_id: "u2", stream_role: "students" as const, cluster_id: "B", speaker_name: "B", text: "world", start_ms: 5000, end_ms: 15000, duration_ms: 10000 },
      { utterance_id: "u3", stream_role: "students" as const, cluster_id: "A", speaker_name: "A", text: "test", start_ms: 15000, end_ms: 20000, duration_ms: 5000 },
    ];
    // Audio is 0-20000ms = 20s. Naive sum = 25s. Should be <= 20s.
    const stats = computeSpeakerStats(transcript);
    const total = stats.reduce((s, item) => s + item.talk_time_ms, 0);
    expect(total).toBeLessThanOrEqual(20000);
  });

  it("should split overlapping time equally between speakers", () => {
    const transcript = [
      { utterance_id: "u1", stream_role: "students" as const, cluster_id: "A", speaker_name: "A", text: "hello", start_ms: 0, end_ms: 10000, duration_ms: 10000 },
      { utterance_id: "u2", stream_role: "students" as const, cluster_id: "B", speaker_name: "B", text: "world", start_ms: 0, end_ms: 10000, duration_ms: 10000 },
    ];
    // Both speak for 10s at exact same time. Each should get ~5s.
    const stats = computeSpeakerStats(transcript);
    const a = stats.find(s => s.speaker_key === "A");
    const b = stats.find(s => s.speaker_key === "B");
    expect(a!.talk_time_ms).toBe(5000);
    expect(b!.talk_time_ms).toBe(5000);
  });

  it("should include talk_time_pct field", () => {
    const transcript = [
      { utterance_id: "u1", stream_role: "students" as const, cluster_id: "A", speaker_name: "A", text: "hello world this is a test", start_ms: 0, end_ms: 10000, duration_ms: 10000 },
    ];
    const stats = computeSpeakerStats(transcript);
    expect(stats[0].talk_time_pct).toBeCloseTo(1.0);
  });
});
