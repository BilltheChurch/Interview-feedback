#!/usr/bin/env node

import process from "node:process";

function parseArgs(argv) {
  const out = {
    baseUrl: "https://api.frontierace.ai",
    sessionPrefix: `finalize-resilience-${Date.now()}`,
    runs: 6,
    timeoutMs: 240000,
    pollMs: 2000,
    minSuccessRatio: 0.995,
    requireTrace: true
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--base-url" && next) {
      out.baseUrl = next;
      i += 1;
    } else if (arg === "--session-prefix" && next) {
      out.sessionPrefix = next;
      i += 1;
    } else if (arg === "--runs" && next) {
      out.runs = Number(next);
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      out.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--poll-ms" && next) {
      out.pollMs = Number(next);
      i += 1;
    } else if (arg === "--min-success-ratio" && next) {
      out.minSuccessRatio = Number(next);
      i += 1;
    } else if (arg === "--no-require-trace") {
      out.requireTrace = false;
    }
  }
  return out;
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

function validateFinalizeStatusShape(statusData) {
  if (!Array.isArray(statusData?.warnings)) {
    return "finalize status missing warnings[]";
  }
  if (typeof statusData?.degraded !== "boolean") {
    return "finalize status missing degraded:boolean";
  }
  if (typeof statusData?.backend_used !== "string" || !statusData.backend_used) {
    return "finalize status missing backend_used";
  }
  return "";
}

function validateResultTraceShape(resultData) {
  const trace = resultData?.trace || {};
  const hasTimeline = Array.isArray(trace.backend_timeline);
  const hasQualitySnapshot = trace.quality_gate_snapshot && typeof trace.quality_gate_snapshot === "object";
  return {
    hasTimeline,
    hasQualitySnapshot
  };
}

async function runOne(baseUrl, sessionId, timeoutMs, pollMs, requireTrace) {
  const root = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`;
  const memoResp = await requestJson(`${root}/memos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "observation",
      tags: ["regression"],
      text: "Finalize resilience regression marker.",
      anchors: { mode: "time", time_range_ms: [1000, 2000] }
    })
  });
  if (!memoResp.ok) {
    return {
      sessionId,
      ok: false,
      reason: `memos failed status=${memoResp.status}`
    };
  }

  const finalizeResp = await requestJson(`${root}/finalize?version=v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metadata: { script: "finalize_resilience_regression" } })
  });
  if (!finalizeResp.ok || !finalizeResp.data?.job_id) {
    return {
      sessionId,
      ok: false,
      reason: `finalize enqueue failed status=${finalizeResp.status}`
    };
  }

  const jobId = String(finalizeResp.data.job_id);
  const startedAt = Date.now();
  let statusData = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const statusResp = await requestJson(`${root}/finalize/status?job_id=${encodeURIComponent(jobId)}`);
    if (!statusResp.ok) {
      return {
        sessionId,
        ok: false,
        jobId,
        reason: `status failed status=${statusResp.status}`
      };
    }
    statusData = statusResp.data;
    if (statusData?.status === "succeeded") {
      break;
    }
    if (statusData?.status === "failed") {
      return {
        sessionId,
        ok: false,
        jobId,
        status: statusData,
        reason: `finalize failed ${JSON.stringify(statusData?.errors || [])}`
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!statusData || statusData.status !== "succeeded") {
    return {
      sessionId,
      ok: false,
      jobId,
      reason: "finalize polling timeout"
    };
  }

  const shapeError = validateFinalizeStatusShape(statusData);
  if (shapeError) {
    return {
      sessionId,
      ok: false,
      jobId,
      reason: shapeError
    };
  }

  const resultResp = await requestJson(`${root}/result?version=v2`);
  if (!resultResp.ok) {
    return {
      sessionId,
      ok: false,
      jobId,
      reason: `result failed status=${resultResp.status}`
    };
  }
  const traceShape = validateResultTraceShape(resultResp.data);
  if (requireTrace && (!traceShape.hasTimeline || !traceShape.hasQualitySnapshot)) {
    return {
      sessionId,
      ok: false,
      jobId,
      reason: `result trace missing fields: timeline=${traceShape.hasTimeline} quality_snapshot=${traceShape.hasQualitySnapshot}`
    };
  }

  return {
    sessionId,
    ok: true,
    jobId,
    degraded: Boolean(statusData.degraded),
    warnings: statusData.warnings || [],
    backend_used: statusData.backend_used,
    trace_timeline_count: Array.isArray(resultResp?.data?.trace?.backend_timeline)
      ? resultResp.data.trace.backend_timeline.length
      : 0
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = String(args.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("base-url is required");
  }
  if (!Number.isFinite(args.runs) || args.runs <= 0) {
    throw new Error("runs must be > 0");
  }
  if (!Number.isFinite(args.minSuccessRatio) || args.minSuccessRatio <= 0 || args.minSuccessRatio > 1) {
    throw new Error("min-success-ratio must be in (0,1]");
  }

  const records = [];
  for (let i = 0; i < args.runs; i += 1) {
    const sessionId = `${args.sessionPrefix}-${i + 1}`;
    const result = await runOne(baseUrl, sessionId, args.timeoutMs, args.pollMs, args.requireTrace);
    records.push(result);
    const status = result.ok ? "ok" : "failed";
    console.log(`[run ${i + 1}/${args.runs}] ${sessionId} => ${status}`);
    if (!result.ok) {
      console.log(`  reason: ${result.reason}`);
    }
  }

  const success = records.filter((item) => item.ok).length;
  const failure = records.length - success;
  const successRatio = records.length > 0 ? success / records.length : 0;
  const degradedCount = records.filter((item) => item.ok && item.degraded).length;

  const summary = {
    ok: successRatio >= args.minSuccessRatio,
    runs: records.length,
    success,
    failure,
    success_ratio: Number(successRatio.toFixed(4)),
    min_success_ratio: args.minSuccessRatio,
    degraded_count: degradedCount,
    records
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    throw new Error(`success_ratio ${summary.success_ratio} below gate ${args.minSuccessRatio}`);
  }
}

main().catch((error) => {
  console.error(`[finalize_resilience_regression] ${error?.message || error}`);
  process.exitCode = 1;
});
