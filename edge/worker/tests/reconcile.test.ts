import { describe, it, expect } from "vitest";
import {
  inferClusterFromEdgeTurns,
  resolveStudentBinding,
  prepareEdgeTurns,
  buildReconciledTranscript,
  type ReconcileSessionState,
  type ReconcileUtterance,
  type ReconcileSpeakerEvent,
} from "../src/reconcile";
import type { SpeakerLogs, SpeakerMapItem } from "../src/types_v2";

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
    expect(result[0].cluster_id).toBe("c_02");
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
});
