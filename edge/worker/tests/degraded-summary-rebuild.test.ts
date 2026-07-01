/**
 * degraded-summary-rebuild.test.ts
 *
 * 降级报告（degraded_no_participants）的 summary 重建。
 *
 * 真人测试暴露的两个问题（1v1、只有面试官/teacher 流说话）：
 *   (1) OVERVIEW 的 Summary 极空洞 —— 只有那句通用占位
 *       "本场记录已生成，建议结合个人维度反馈查看。"，面试官说了很多话、
 *       又写了 session notes，但 summary 什么都没总结。
 *   (2) Summary 盲挂了一条无关 evidence（面试官 00:00 的开场白），因为
 *       memo-first 按 evidence 数组顺序取头 4 个 —— 与 summary 内容毫无语义关系。
 *
 * 修复：降级 fork 用确定性拼接（无 LLM）重建 summary_sections，反映本场
 * 实际内容（面试官发言要点 + session notes 摘要），且 evidence_ids 一律置空
 * （不盲挂无关头部 evidence）。
 *
 * 本文件覆盖：
 *   - 纯函数 buildDegradedSummarySections 的单元测试；
 *   - 通过真实 orchestrator（report-only 入口）的集成验证，确保降级路径
 *     产出的 summary_sections 不是通用占位、包含面试官发言/notes 片段、
 *     且 evidence_ids 不再等于 globalEvidenceRefs.slice(0,4)。
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildDegradedSummarySections,
  NO_STUDENT_SPEECH_NOTICE,
} from "../src/feedback-helpers";
import { runFinalizeV2Job, type FinalizeJobContext } from "../src/finalize-orchestrator";
import type { SpeakerStatItem, ResultV2 } from "../src/types_v2";
import type { TranscriptItem } from "../src/finalize_v2";

// ── Pure helper ──────────────────────────────────────────────────────────────

function tItem(
  id: string,
  role: TranscriptItem["stream_role"],
  text: string,
  startMs: number,
  endMs: number
): TranscriptItem {
  return {
    utterance_id: id,
    stream_role: role,
    speaker_name: role === "teacher" ? "Mr. Lee" : "Alice",
    cluster_id: null,
    decision: "auto",
    text,
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: endMs - startMs,
  };
}

describe("buildDegradedSummarySections (确定性拼接)", () => {
  it("首段复用 no-student-speech notice 语义（本场未检测到候选人发言）", () => {
    const sections = buildDegradedSummarySections({
      transcript: [tItem("u1", "teacher", "我们今天聊聊这个岗位的职责。", 0, 5000)],
      freeFormNotes: null,
      notice: NO_STUDENT_SPEECH_NOTICE,
    });
    expect(sections.length).toBeGreaterThan(0);
    const joined = sections.flatMap((s) => s.bullets).join(" ");
    // 明确告知无法生成个人维度评估
    expect(joined).toMatch(/未检测到|候选人|个人维度/);
  });

  it("补充面试官/teacher 流发言要点（较长/有信息量的发言）", () => {
    const transcript = [
      tItem("u1", "teacher", "早上好。", 0, 1000), // 太短，应被过滤
      tItem("u1b", "teacher", "我们今天主要围绕你过往在分布式系统上的项目经验展开，先请你介绍一下自己。", 1000, 9000),
      tItem("u2", "teacher", "接下来我想了解一下你在团队协作中扮演的角色，以及遇到冲突时如何处理。", 9000, 18000),
    ];
    const sections = buildDegradedSummarySections({
      transcript,
      freeFormNotes: null,
      notice: NO_STUDENT_SPEECH_NOTICE,
    });
    const joined = sections.flatMap((s) => s.bullets).join(" ");
    expect(joined).toContain("分布式系统");
    expect(joined).toContain("团队协作");
    // "早上好。" 这种过短开场白不应作为要点
    expect(joined).not.toContain("早上好");
  });

  it("补充 session notes 摘要", () => {
    const sections = buildDegradedSummarySections({
      transcript: [tItem("u1", "teacher", "请介绍一下你自己。", 0, 4000)],
      freeFormNotes: "候选人背景不错，重点考察系统设计和沟通表达能力。",
      notice: NO_STUDENT_SPEECH_NOTICE,
    });
    const joined = sections.flatMap((s) => s.bullets).join(" ");
    expect(joined).toContain("系统设计");
  });

  it("所有段落的 evidence_ids 一律为空（不盲挂无关 evidence）", () => {
    const sections = buildDegradedSummarySections({
      transcript: [
        tItem("u1", "teacher", "我们今天围绕你在后端工程上的经验展开面试。", 0, 8000),
      ],
      freeFormNotes: "重点看候选人的工程深度。",
      notice: NO_STUDENT_SPEECH_NOTICE,
    });
    for (const s of sections) {
      expect(s.evidence_ids).toEqual([]);
    }
  });

  it("不产出那句通用占位文案", () => {
    const sections = buildDegradedSummarySections({
      transcript: [tItem("u1", "teacher", "我们来聊聊你的项目经历吧。", 0, 6000)],
      freeFormNotes: null,
      notice: NO_STUDENT_SPEECH_NOTICE,
    });
    const joined = sections.flatMap((s) => s.bullets).join(" ");
    expect(joined).not.toContain("本场记录已生成，建议结合个人维度反馈查看。");
  });
});

// ── REAL orchestrator integration (report-only entry) ────────────────────────

function stat(partial: Partial<SpeakerStatItem>): SpeakerStatItem {
  return {
    speaker_key: partial.speaker_key ?? "S1",
    speaker_name: partial.speaker_name ?? "Alice",
    talk_time_ms: partial.talk_time_ms ?? 0,
    talk_time_pct: partial.talk_time_pct ?? 0,
    turns: partial.turns ?? 0,
    silence_ms: partial.silence_ms ?? 0,
    interruptions: partial.interruptions ?? 0,
    interrupted_by_others: partial.interrupted_by_others ?? 0,
    binding_status: partial.binding_status,
  };
}

function makeUtterance(
  id: string,
  role: "teacher" | "students",
  speakerName: string | null,
  clusterId: string | null,
  text: string,
  startMs: number,
  endMs: number
): TranscriptItem {
  return {
    utterance_id: id,
    stream_role: role,
    speaker_name: speakerName,
    cluster_id: clusterId,
    decision: "auto",
    text,
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: endMs - startMs,
  };
}

type CapturedCache = {
  ready?: boolean;
  quality_gate_passed?: boolean;
  blocking_reason?: string | null;
  report_source?: string;
  report?: ResultV2 | null;
};

function makeHarness(opts: {
  existingResult: ResultV2;
  synthPerPerson: unknown[];
  interviewerName?: string;
  freeFormNotes?: string;
}) {
  const captured: { cache: CapturedCache | null } = { cache: null };
  let storedResultV2: ResultV2 | null = null;

  const sessionState = {
    config: {
      mode: "1v1",
      interviewer_name: opts.interviewerName ?? "Mr. Lee",
      free_form_notes: opts.freeFormNotes,
    },
  };

  const feedbackCache: CapturedCache & Record<string, unknown> = {
    session_id: "sess-sum",
    updated_at: "",
    ready: false,
    person_summary_cache: [],
    overall_summary_cache: {},
    evidence_index_cache: {},
    report: null,
    quality: {},
    timings: {},
    report_source: "memo_first",
    blocking_reason: null,
    quality_gate_passed: false,
  };

  const RESULT_BUCKET = {
    get: vi.fn(async () => ({ text: async () => JSON.stringify(opts.existingResult) })),
    put: vi.fn(async (_key: string, body: string) => {
      storedResultV2 = JSON.parse(body) as ResultV2;
    }),
  };

  const ctx = {
    doCtx: {
      storage: {
        get: vi.fn(async (key: string) => (key === "state" ? sessionState : undefined)),
        put: vi.fn(async () => {}),
      },
    },
    env: { RESULT_BUCKET, QUALITY_GATE_UNKNOWN_RATIO: undefined },
    currentIsoTs: () => "2026-07-01T00:00:00.000Z",
    finalizeTimeoutMs: () => 600_000,
    getCaptionSource: () => "none" as const,
    setCaptionSource: () => {},
    getCaptionBuffer: () => [],
    setCaptionBuffer: () => {},
    updateFinalizeV2Status: vi.fn(async () => null),
    setFinalizeLock: vi.fn(async () => {}),
    ensureFinalizeJobActive: vi.fn(async () => {}),
    loadIngestByStream: vi.fn(async () => ({
      mixed: { last_seq: 0 },
      teacher: { last_seq: 0 },
      students: { last_seq: 0 },
    })),
    loadFinalizeV2Status: vi.fn(async () => ({
      job_id: "job-sum",
      status: "running" as const,
      stage: "reconcile" as const,
      progress: 42,
      errors: [],
      warnings: [],
      degraded: false,
      backend_used: "primary" as const,
      version: "v2" as const,
      started_at: "2026-07-01T00:00:00.000Z",
    })),
    isFinalizeTerminal: () => false,
    setSessionPhase: vi.fn(async () => "finalized" as const),
    clearFinalizeStageCheckpoint: vi.fn(async () => {}),
    saveFinalizeStageCheckpoint: vi.fn(async () => {}),
    tier2Enabled: () => false,
    tier2AutoTrigger: () => false,
    loadMemos: vi.fn(async () => []),
    storeMemos: vi.fn(async () => {}),
    invokeInferenceAnalysisEvents: vi.fn(async () => ({
      events: [],
      backend_used: "primary",
      degraded: false,
      warnings: [],
      timeline: [],
      fallback_reason: null,
    })),
    invokeInferenceSynthesizeReport: vi.fn(async () => ({
      data: { per_person: opts.synthPerPerson, overall: { narrative: "Session overview." } },
      backend_used: "primary",
      degraded: false,
      warnings: [],
      timeline: [],
    })),
    loadCheckpoints: vi.fn(async () => []),
    sanitizeClaimEvidenceRefs: (perPerson: unknown[]) => ({ sanitized: perPerson, strippedCount: 0 }),
    validateClaimEvidenceRefs: (report: ResultV2) => {
      let claimCount = 0;
      let needs = 0;
      for (const p of report.per_person ?? []) {
        for (const d of p.dimensions ?? []) {
          for (const c of [...(d.strengths ?? []), ...(d.risks ?? []), ...(d.actions ?? [])]) {
            claimCount += 1;
            if (!Array.isArray(c.evidence_refs) || c.evidence_refs.filter(Boolean).length === 0) needs += 1;
          }
        }
      }
      return { valid: needs === 0 && claimCount > 0, claimCount, invalidCount: needs, needsEvidenceCount: needs, failures: [] };
    },
    buildQualityMetrics: () => ({
      unknown_ratio: 0,
      students_utterance_count: 0,
      students_unknown_count: 0,
      echo_suppressed_chunks: 0,
      echo_suppression_recent_rate: 0,
      echo_leak_rate: 0,
      suppression_false_positive_rate: undefined,
    }),
    buildEvidenceIndex: () => ({}),
    evaluateFeedbackQualityGates: () => ({ passed: true, failures: [] }),
    loadFeedbackCache: vi.fn(async () => feedbackCache),
    storeFeedbackCache: vi.fn(async (c: CapturedCache) => {
      captured.cache = { ...c };
    }),
    triggerImprovementGeneration: vi.fn(async () => {}),
  } as unknown as FinalizeJobContext;

  return { ctx, captured, getStoredResultV2: () => storedResultV2 };
}

function makeExistingResult(stats: SpeakerStatItem[], transcript: ResultV2["transcript"]): ResultV2 {
  return {
    session: {
      session_id: "sess-sum",
      finalized_at: "2026-06-30T00:00:00.000Z",
      tentative: false,
      confidence_level: "high",
      unresolved_cluster_count: 0,
      diarization_backend: "cloud",
    },
    transcript,
    speaker_logs: { teacher: [], students: [] } as unknown as ResultV2["speaker_logs"],
    stats,
    memos: [],
    evidence: [
      // 头部恰好是面试官开场白 quote —— 旧代码会盲挂它作为 summary evidence。
      { evidence_id: "ev_open", type: "quote", text: "我们今天围绕你的项目经验展开。", utterance_ids: ["u0"], start_ms: 0, end_ms: 4000 },
      { evidence_id: "ev_b", type: "quote", text: "another", utterance_ids: ["u0b"], start_ms: 0, end_ms: 1000 },
    ] as unknown as ResultV2["evidence"],
    overall: {} as ResultV2["overall"],
    per_person: [],
    quality: {} as ResultV2["quality"],
    trace: {
      finalize_job_id: "job-old",
      model_versions: {},
      thresholds: {},
      unknown_ratio: 0,
      generated_at: "2026-06-30T00:00:00.000Z",
    },
  };
}

describe("degraded summary rebuild — orchestrator report-only integration", () => {
  it("降级路径：summary 反映本场实际内容（面试官发言 + notes），evidence 不盲挂头部", async () => {
    const transcript = [
      makeUtterance("u0", "teacher", "Mr. Lee", null, "我们今天围绕你在后端分布式系统上的项目经验展开面试，先请你做个自我介绍。", 0, 9000),
      makeUtterance("u1", "teacher", "Mr. Lee", null, "接下来聊聊你在团队协作里怎么推动一个大项目落地。", 9000, 18000),
    ];
    const existing = makeExistingResult(
      [stat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 6, talk_time_ms: 40000 })],
      transcript
    );
    const { ctx, captured, getStoredResultV2 } = makeHarness({
      existingResult: existing,
      synthPerPerson: [],
      freeFormNotes: "候选人来自 985 高校，重点考察系统设计能力与沟通表达。",
    });

    await runFinalizeV2Job("sess-sum", "job-sum", {}, ctx, "report-only");

    expect(captured.cache?.report_source).toBe("degraded_no_participants");
    const result = getStoredResultV2();
    expect(result).not.toBeNull();

    const overall = result!.overall as {
      notice?: string;
      summary_sections?: Array<{ topic: string; bullets: string[]; evidence_ids: string[] }>;
    };
    const sections = overall.summary_sections ?? [];
    expect(sections.length).toBeGreaterThan(0);
    const joined = sections.flatMap((s) => s.bullets).join(" ");

    // (1) 不是通用占位
    expect(joined).not.toContain("本场记录已生成，建议结合个人维度反馈查看。");
    // 包含面试官发言要点
    expect(joined).toContain("分布式系统");
    expect(joined).toContain("团队协作");
    // 包含 session notes 摘要片段
    expect(joined).toContain("系统设计");

    // (2) evidence_ids 不再盲挂头部 evidence（不等于 slice(0,4)）
    const allEvidenceIds = sections.flatMap((s) => s.evidence_ids);
    expect(allEvidenceIds).not.toContain("ev_open");
    for (const s of sections) {
      expect(s.evidence_ids).toEqual([]);
    }
  });

  it("正常路径（有候选人）：summary/evidence 行为不受影响", async () => {
    const transcript = [
      makeUtterance("u0", "teacher", "Mr. Lee", null, "Q1", 0, 3000),
      makeUtterance("u1", "students", "Alice", "S1", "I'm Alice, from MIT.", 3000, 9000),
    ];
    const existing = makeExistingResult(
      [
        stat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 3, talk_time_ms: 12000 }),
        stat({ speaker_key: "S1", speaker_name: "Alice", turns: 3, talk_time_ms: 8000 }),
      ],
      transcript
    );
    const perPerson = [
      {
        person_key: "S1",
        display_name: "Alice",
        dimensions: [
          {
            dimension: "collaboration",
            score: 7,
            strengths: [{ claim_id: "S1_c1", text: "Clear self-intro.", evidence_refs: ["ev_intro"], confidence: 0.8 }],
            risks: [],
            actions: [],
          },
        ],
        summary: { strengths: [], risks: [], actions: [] },
      },
    ];
    const { ctx, captured, getStoredResultV2 } = makeHarness({ existingResult: existing, synthPerPerson: perPerson });

    await runFinalizeV2Job("sess-sum", "job-sum", {}, ctx, "report-only");

    expect(captured.cache?.report_source).toBe("llm_synthesized");
    expect(captured.cache?.report_source).not.toBe("degraded_no_participants");
    // 正常路径 overall 由 synthesis 提供，不带 notice
    expect((getStoredResultV2()!.overall as { notice?: string }).notice).toBeUndefined();
    expect(getStoredResultV2()!.per_person.length).toBe(1);
  });
});
