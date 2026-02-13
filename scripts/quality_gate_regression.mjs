#!/usr/bin/env node

import process from "node:process";

function parseArgs(argv) {
  const out = {
    baseUrl: "https://api.frontierace.ai",
    sessionId: "",
    unknownRatioMax: 0.1,
    echoLeakRateMax: 0.2,
    suppressionFalsePositiveRateMax: 0.15,
    requireFinalizeTrace: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--base-url" && next) {
      out.baseUrl = next;
      i += 1;
    } else if (arg === "--session-id" && next) {
      out.sessionId = next;
      i += 1;
    } else if (arg === "--unknown-ratio-max" && next) {
      out.unknownRatioMax = Number(next);
      i += 1;
    } else if (arg === "--echo-leak-rate-max" && next) {
      out.echoLeakRateMax = Number(next);
      i += 1;
    } else if (arg === "--suppression-fp-max" && next) {
      out.suppressionFalsePositiveRateMax = Number(next);
      i += 1;
    } else if (arg === "--require-finalize-trace") {
      out.requireFinalizeTrace = true;
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

function assertFiniteInRange(value, min, max, fieldName) {
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} is not finite`);
  }
  if (value < min || value > max) {
    throw new Error(`${fieldName} out of range [${min}, ${max}] => ${value}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = String(args.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("base-url is required");
  }
  if (!args.sessionId) {
    throw new Error("session-id is required");
  }
  const sessionRoot = `${baseUrl}/v1/sessions/${encodeURIComponent(args.sessionId)}`;
  const stateResp = await requestJson(`${sessionRoot}/state`);
  if (!stateResp.ok) {
    throw new Error(`state failed status=${stateResp.status}`);
  }
  const quality = stateResp?.data?.quality_metrics || {};
  if (!quality || typeof quality !== "object" || Object.keys(quality).length === 0) {
    throw new Error("state payload missing quality_metrics (worker version may be outdated)");
  }
  const unknownRatio = Number(quality.unknown_ratio);
  const echoLeakRate = Number(quality.echo_leak_rate);
  const suppressionFpRate = Number(quality.suppression_false_positive_rate);
  assertFiniteInRange(unknownRatio, 0, 1, "unknown_ratio");
  assertFiniteInRange(echoLeakRate, 0, 1, "echo_leak_rate");
  assertFiniteInRange(suppressionFpRate, 0, 1, "suppression_false_positive_rate");

  const violations = [];
  if (unknownRatio > args.unknownRatioMax) {
    violations.push(`unknown_ratio=${unknownRatio.toFixed(4)} > ${args.unknownRatioMax}`);
  }
  if (echoLeakRate > args.echoLeakRateMax) {
    violations.push(`echo_leak_rate=${echoLeakRate.toFixed(4)} > ${args.echoLeakRateMax}`);
  }
  if (suppressionFpRate > args.suppressionFalsePositiveRateMax) {
    violations.push(`suppression_false_positive_rate=${suppressionFpRate.toFixed(4)} > ${args.suppressionFalsePositiveRateMax}`);
  }

  let traceSnapshot = null;
  if (args.requireFinalizeTrace) {
    const resultResp = await requestJson(`${sessionRoot}/result?version=v2`);
    if (!resultResp.ok) {
      throw new Error(`result v2 failed status=${resultResp.status}`);
    }
    traceSnapshot = resultResp?.data?.trace?.quality_gate_snapshot || null;
    if (!traceSnapshot || typeof traceSnapshot !== "object") {
      violations.push("result trace missing quality_gate_snapshot");
    }
  }

  const report = {
    ok: violations.length === 0,
    session_id: args.sessionId,
    quality_metrics: {
      unknown_ratio: unknownRatio,
      echo_leak_rate: echoLeakRate,
      suppression_false_positive_rate: suppressionFpRate,
      students_utterance_count: Number(quality.students_utterance_count || 0),
      students_unknown_count: Number(quality.students_unknown_count || 0),
      echo_suppressed_chunks: Number(quality.echo_suppressed_chunks || 0),
      echo_suppression_recent_rate: Number(quality.echo_suppression_recent_rate || 0)
    },
    thresholds: {
      unknown_ratio_max: args.unknownRatioMax,
      echo_leak_rate_max: args.echoLeakRateMax,
      suppression_false_positive_rate_max: args.suppressionFalsePositiveRateMax
    },
    speech_backend_mode: stateResp?.data?.speech_backend_mode || "unknown",
    dependency_health: stateResp?.data?.dependency_health || null,
    quality_gate_snapshot: traceSnapshot,
    violations
  };

  console.log(JSON.stringify(report, null, 2));
  if (violations.length > 0) {
    throw new Error(`quality gate failed: ${violations.join("; ")}`);
  }
}

main().catch((error) => {
  console.error(`[quality_gate_regression] ${error?.message || error}`);
  process.exitCode = 1;
});
