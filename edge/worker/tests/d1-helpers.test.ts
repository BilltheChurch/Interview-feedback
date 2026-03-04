import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  persistSessionToD1,
  listSessionsD1,
  getSessionScoresD1,
  updateSessionPhaseD1,
} from "../src/d1-helpers";
import type { ResultV2 } from "../src/types_v2";

// ── D1 mock factory ──────────────────────────────────────────────────────────

function makeD1Mock(overrides?: {
  batchResults?: unknown[];
  allResults?: unknown[];
  runResult?: unknown;
}) {
  const stmtMock = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue(overrides?.runResult ?? { success: true }),
    all: vi.fn().mockResolvedValue({ results: overrides?.allResults ?? [] }),
    first: vi.fn().mockResolvedValue(null),
  };
  // bind() returns itself for chaining
  stmtMock.bind.mockReturnValue(stmtMock);

  const db = {
    prepare: vi.fn().mockReturnValue(stmtMock),
    batch: vi.fn().mockResolvedValue(overrides?.batchResults ?? []),
    exec: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;

  return { db, stmtMock };
}

// ── Minimal ResultV2 fixture ─────────────────────────────────────────────────

function makeResult(overrides?: Partial<ResultV2>): ResultV2 {
  return {
    session: {
      session_id: "sess-abc",
      phase: "finalized",
      unresolved_cluster_count: 0,
      caption_source: "local-asr",
    },
    transcript: [
      { start_ms: 0, end_ms: 5000, speaker: "Alice", text: "Hello" },
      { start_ms: 5000, end_ms: 12000, speaker: "Bob", text: "World" },
    ],
    stats: [
      { person_key: "alice", display_name: "Alice", talk_ms: 5000, segment_count: 1 },
    ],
    per_person: [
      {
        person_key: "alice",
        display_name: "Alice",
        dimensions: [
          {
            dimension: "communication",
            label_zh: "沟通",
            score: 4,
            not_applicable: false,
            evidence_insufficient: false,
            strengths: [{ text: "Clear", evidence: [] }],
            risks: [],
          },
          {
            dimension: "leadership",
            label_zh: "领导力",
            score: 3,
            not_applicable: false,
            evidence_insufficient: false,
            strengths: [],
            risks: [{ text: "Needs work", evidence: [] }],
          },
        ],
      },
    ],
    quality: {
      report_source: "llm",
      evidence_coverage: 0.9,
    },
    ...overrides,
  } as unknown as ResultV2;
}

// ── persistSessionToD1 ───────────────────────────────────────────────────────

describe("persistSessionToD1", () => {
  it("returns sessionWritten=true on success", async () => {
    const { db } = makeD1Mock({ batchResults: [{}, {}] });
    const result = makeResult();
    const out = await persistSessionToD1(db, "sess-abc", result, "r2/result.json");
    expect(out.sessionWritten).toBe(true);
  });

  it("counts dimension scores written (skips not_applicable)", async () => {
    const { db } = makeD1Mock({ batchResults: [] });
    const result = makeResult({
      per_person: [
        {
          person_key: "alice",
          display_name: "Alice",
          dimensions: [
            {
              dimension: "communication",
              label_zh: "沟通",
              score: 4,
              not_applicable: false,
              evidence_insufficient: false,
              strengths: [],
              risks: [],
            },
            {
              dimension: "leadership",
              label_zh: "领导力",
              score: 0,
              not_applicable: true,  // should be skipped
              evidence_insufficient: false,
              strengths: [],
              risks: [],
            },
          ],
        },
      ],
    } as unknown as Partial<ResultV2>);
    const out = await persistSessionToD1(db, "sess-abc", result, "r2/result.json");
    expect(out.scoresWritten).toBe(1);
  });

  it("calls db.batch() exactly once", async () => {
    const { db } = makeD1Mock();
    const result = makeResult();
    await persistSessionToD1(db, "sess-abc", result, "r2/key");
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it("passes orgId and createdBy to bind when opts provided", async () => {
    const { db, stmtMock } = makeD1Mock();
    const result = makeResult();
    await persistSessionToD1(db, "sess-abc", result, "r2/key", {
      orgId: "org-1",
      createdBy: "user-1",
      title: "Test Session",
    });
    // First prepare call is the upsert — bind should have been called
    expect(stmtMock.bind).toHaveBeenCalled();
    const firstCall = stmtMock.bind.mock.calls[0] as unknown[];
    expect(firstCall).toContain("org-1");
    expect(firstCall).toContain("user-1");
    expect(firstCall).toContain("Test Session");
  });

  it("computes scoreAvg as rounded average across applicable dimensions", async () => {
    const { db, stmtMock } = makeD1Mock();
    // scores: 4 + 2 = 6, avg = 3
    const result = makeResult({
      per_person: [
        {
          person_key: "alice",
          display_name: "Alice",
          dimensions: [
            { dimension: "d1", score: 4, not_applicable: false, evidence_insufficient: false, strengths: [], risks: [] },
            { dimension: "d2", score: 2, not_applicable: false, evidence_insufficient: false, strengths: [], risks: [] },
          ],
        },
      ],
    } as unknown as Partial<ResultV2>);
    await persistSessionToD1(db, "sess-1", result, "r2/key");
    // The first bind call is the upsert, score_avg is the 10th positional arg (?10)
    const bindArgs = stmtMock.bind.mock.calls[0] as unknown[];
    const scoreAvg = bindArgs[9]; // ?10 = index 9 (0-based)
    expect(scoreAvg).toBe(3);
  });

  it("sets scoreAvg to null when no applicable dimensions", async () => {
    const { db, stmtMock } = makeD1Mock();
    const result = makeResult({
      per_person: [
        {
          person_key: "alice",
          display_name: "Alice",
          dimensions: [
            { dimension: "d1", score: 0, not_applicable: true, evidence_insufficient: false, strengths: [], risks: [] },
          ],
        },
      ],
    } as unknown as Partial<ResultV2>);
    await persistSessionToD1(db, "sess-1", result, "r2/key");
    const bindArgs = stmtMock.bind.mock.calls[0] as unknown[];
    const scoreAvg = bindArgs[9];
    expect(scoreAvg).toBeNull();
  });

  it("sets locale to en-US for acs-teams caption source", async () => {
    const { db, stmtMock } = makeD1Mock();
    const result = makeResult({
      session: {
        session_id: "sess-acs",
        phase: "finalized",
        unresolved_cluster_count: 0,
        caption_source: "acs-teams",
      },
    } as unknown as Partial<ResultV2>);
    await persistSessionToD1(db, "sess-acs", result, "r2/key");
    const bindArgs = stmtMock.bind.mock.calls[0] as unknown[];
    expect(bindArgs[6]).toBe("en-US");
  });

  it("sets locale to zh-CN for local-asr caption source", async () => {
    const { db, stmtMock } = makeD1Mock();
    const result = makeResult();
    await persistSessionToD1(db, "sess-local", result, "r2/key");
    const bindArgs = stmtMock.bind.mock.calls[0] as unknown[];
    expect(bindArgs[6]).toBe("zh-CN");
  });

  it("computes durationMs from transcript endpoints", async () => {
    const { db, stmtMock } = makeD1Mock();
    const result = makeResult({
      transcript: [
        { start_ms: 1000, end_ms: 3000, speaker: "A", text: "hi" },
        { start_ms: 3000, end_ms: 8000, speaker: "B", text: "bye" },
      ],
    } as unknown as Partial<ResultV2>);
    await persistSessionToD1(db, "sess-dur", result, "r2/key");
    // durationMs = last.end_ms - first.start_ms = 8000 - 1000 = 7000, positional arg ?5
    const bindArgs = stmtMock.bind.mock.calls[0] as unknown[];
    expect(bindArgs[4]).toBe(7000);
  });

  it("sets durationMs to null for empty transcript", async () => {
    const { db, stmtMock } = makeD1Mock();
    const result = makeResult({ transcript: [] } as unknown as Partial<ResultV2>);
    await persistSessionToD1(db, "sess-dur", result, "r2/key");
    const bindArgs = stmtMock.bind.mock.calls[0] as unknown[];
    expect(bindArgs[4]).toBeNull();
  });
});

// ── listSessionsD1 ───────────────────────────────────────────────────────────

describe("listSessionsD1", () => {
  const fakeSession = {
    id: "sess-1",
    title: "Interview 1",
    duration_ms: 3600000,
    speaker_count: 3,
    phase: "finalized",
    score_avg: 3.5,
    report_source: "llm",
    created_at: "2025-01-01T00:00:00Z",
    finalized_at: "2025-01-01T01:00:00Z",
  };

  function makeListD1Mock(sessions: unknown[] = [fakeSession], total = 1) {
    const countStmt = {
      bind: vi.fn(),
      all: vi.fn(),
      run: vi.fn(),
      first: vi.fn(),
    };
    countStmt.bind.mockReturnValue(countStmt);

    const listStmt = {
      bind: vi.fn(),
      all: vi.fn(),
      run: vi.fn(),
      first: vi.fn(),
    };
    listStmt.bind.mockReturnValue(listStmt);

    let callCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation(() => {
        return callCount++ === 0 ? countStmt : listStmt;
      }),
      batch: vi.fn().mockResolvedValue([
        { results: [{ total }] },
        { results: sessions },
      ]),
      exec: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;

    return { db, countStmt, listStmt };
  }

  it("returns sessions and total", async () => {
    const { db } = makeListD1Mock([fakeSession], 1);
    const result = await listSessionsD1(db, {});
    expect(result.sessions).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.sessions[0].id).toBe("sess-1");
  });

  it("applies default limit=20 and offset=0", async () => {
    const { db, listStmt } = makeListD1Mock();
    await listSessionsD1(db, {});
    // bind args for listStmt should include 20 and 0
    const bindArgs = listStmt.bind.mock.calls[0] as unknown[];
    expect(bindArgs).toContain(20);
    expect(bindArgs).toContain(0);
  });

  it("filters by org_id when provided", async () => {
    const { db, listStmt } = makeListD1Mock();
    await listSessionsD1(db, { orgId: "org-xyz" });
    const bindArgs = listStmt.bind.mock.calls[0] as unknown[];
    expect(bindArgs).toContain("org-xyz");
  });

  it("filters by phase when provided", async () => {
    const { db, listStmt } = makeListD1Mock();
    await listSessionsD1(db, { phase: "finalized" });
    const bindArgs = listStmt.bind.mock.calls[0] as unknown[];
    expect(bindArgs).toContain("finalized");
  });

  it("applies both org_id and phase filters together", async () => {
    const { db, listStmt } = makeListD1Mock();
    await listSessionsD1(db, { orgId: "org-1", phase: "finalized" });
    const bindArgs = listStmt.bind.mock.calls[0] as unknown[];
    expect(bindArgs).toContain("org-1");
    expect(bindArgs).toContain("finalized");
  });

  it("respects custom limit and offset", async () => {
    const { db, listStmt } = makeListD1Mock();
    await listSessionsD1(db, { limit: 10, offset: 30 });
    const bindArgs = listStmt.bind.mock.calls[0] as unknown[];
    expect(bindArgs).toContain(10);
    expect(bindArgs).toContain(30);
  });

  it("calls db.batch() once", async () => {
    const { db } = makeListD1Mock();
    await listSessionsD1(db, {});
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it("returns empty sessions array with total=0 when no results", async () => {
    const { db } = makeListD1Mock([], 0);
    const result = await listSessionsD1(db, {});
    expect(result.sessions).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ── getSessionScoresD1 ───────────────────────────────────────────────────────

describe("getSessionScoresD1", () => {
  const fakeScore = {
    id: "sess-1-alice-communication",
    session_id: "sess-1",
    person_key: "alice",
    person_name: "Alice",
    dimension: "communication",
    label_zh: "沟通",
    score: 4,
    evidence_count: 2,
  };

  it("returns dimension scores for a session", async () => {
    const stmtMock = {
      bind: vi.fn(),
      all: vi.fn().mockResolvedValue({ results: [fakeScore] }),
      run: vi.fn(),
      first: vi.fn(),
    };
    stmtMock.bind.mockReturnValue(stmtMock);

    const db = {
      prepare: vi.fn().mockReturnValue(stmtMock),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;

    const scores = await getSessionScoresD1(db, "sess-1");
    expect(scores).toHaveLength(1);
    expect(scores[0].dimension).toBe("communication");
    expect(scores[0].score).toBe(4);
  });

  it("passes session_id to bind", async () => {
    const stmtMock = {
      bind: vi.fn(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn(),
      first: vi.fn(),
    };
    stmtMock.bind.mockReturnValue(stmtMock);

    const db = {
      prepare: vi.fn().mockReturnValue(stmtMock),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;

    await getSessionScoresD1(db, "sess-xyz");
    expect(stmtMock.bind).toHaveBeenCalledWith("sess-xyz");
  });

  it("returns empty array when no scores exist", async () => {
    const stmtMock = {
      bind: vi.fn(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn(),
      first: vi.fn(),
    };
    stmtMock.bind.mockReturnValue(stmtMock);

    const db = {
      prepare: vi.fn().mockReturnValue(stmtMock),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;

    const scores = await getSessionScoresD1(db, "sess-none");
    expect(scores).toEqual([]);
  });

  it("calls .all() (not .run()) for read queries", async () => {
    const stmtMock = {
      bind: vi.fn(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn(),
      first: vi.fn(),
    };
    stmtMock.bind.mockReturnValue(stmtMock);

    const db = {
      prepare: vi.fn().mockReturnValue(stmtMock),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;

    await getSessionScoresD1(db, "sess-1");
    expect(stmtMock.all).toHaveBeenCalledOnce();
    expect(stmtMock.run).not.toHaveBeenCalled();
  });
});

// ── updateSessionPhaseD1 ─────────────────────────────────────────────────────

describe("updateSessionPhaseD1", () => {
  function makeRunMock() {
    const stmtMock = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn(),
      first: vi.fn(),
    };
    stmtMock.bind.mockReturnValue(stmtMock);
    const db = {
      prepare: vi.fn().mockReturnValue(stmtMock),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;
    return { db, stmtMock };
  }

  it("calls db.prepare and .run() for phase update", async () => {
    const { db, stmtMock } = makeRunMock();
    await updateSessionPhaseD1(db, "sess-1", "archived");
    expect(db.prepare).toHaveBeenCalledOnce();
    expect(stmtMock.run).toHaveBeenCalledOnce();
  });

  it("uses archived_at column when phase is 'archived'", async () => {
    const { db } = makeRunMock();
    await updateSessionPhaseD1(db, "sess-1", "archived");
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("archived_at");
    expect(sql).not.toContain("finalized_at");
  });

  it("uses finalized_at column for non-archived phases", async () => {
    const { db } = makeRunMock();
    await updateSessionPhaseD1(db, "sess-1", "finalized");
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("finalized_at");
    expect(sql).not.toContain("archived_at");
  });

  it("binds phase and sessionId to the statement", async () => {
    const { db, stmtMock } = makeRunMock();
    await updateSessionPhaseD1(db, "sess-xyz", "archived");
    expect(stmtMock.bind).toHaveBeenCalledWith("archived", "sess-xyz");
  });
});

// ── listSessionsD1 — order validation ────────────────────────────────────────

describe("listSessionsD1 order validation", () => {
  function makeOrderMock() {
    const countStmt = { bind: vi.fn(), all: vi.fn(), run: vi.fn(), first: vi.fn() };
    countStmt.bind.mockReturnValue(countStmt);
    const listStmt = { bind: vi.fn(), all: vi.fn(), run: vi.fn(), first: vi.fn() };
    listStmt.bind.mockReturnValue(listStmt);
    let call = 0;
    const db = {
      prepare: vi.fn().mockImplementation(() => call++ === 0 ? countStmt : listStmt),
      batch: vi.fn().mockResolvedValue([{ results: [{ total: 0 }] }, { results: [] }]),
      exec: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;
    return { db };
  }

  it("uses created_at as default orderBy", async () => {
    const { db } = makeOrderMock();
    await listSessionsD1(db, {});
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(sql).toContain("ORDER BY created_at");
  });

  it("falls back to created_at for invalid orderBy (SQL injection guard)", async () => {
    const { db } = makeOrderMock();
    await listSessionsD1(db, { orderBy: "malicious; DROP TABLE sessions" as never });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(sql).toContain("ORDER BY created_at");
    expect(sql).not.toContain("malicious");
  });

  it("allows finalized_at as valid orderBy", async () => {
    const { db } = makeOrderMock();
    await listSessionsD1(db, { orderBy: "finalized_at" });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(sql).toContain("ORDER BY finalized_at");
  });

  it("allows score_avg as valid orderBy", async () => {
    const { db } = makeOrderMock();
    await listSessionsD1(db, { orderBy: "score_avg" });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(sql).toContain("ORDER BY score_avg");
  });

  it("defaults orderDir to DESC and accepts ASC", async () => {
    const { db } = makeOrderMock();
    await listSessionsD1(db, { orderDir: "ASC" });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(sql).toContain("ASC");
  });

  it("falls back to DESC for invalid orderDir", async () => {
    const { db } = makeOrderMock();
    await listSessionsD1(db, { orderDir: "INVALID" as never });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(sql).toContain("DESC");
    expect(sql).not.toContain("INVALID");
  });
});
