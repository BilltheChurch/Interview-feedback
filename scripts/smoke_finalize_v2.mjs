#!/usr/bin/env node

import process from "node:process";

function parseArgs(argv) {
  const out = {
    baseUrl: "https://api.frontierace.ai",
    sessionId: `finalize-v2-smoke-${Date.now()}`,
    timeoutMs: 240000,
    pollMs: 2000
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
    } else if (arg === "--timeout-ms" && next) {
      out.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--poll-ms" && next) {
      out.pollMs = Number(next);
      i += 1;
    }
  }
  return out;
}

async function requestJson(url, init = {}) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: resp.ok, status: resp.status, data };
}

async function main() {
  const args = parseArgs(process.argv);
  const base = args.baseUrl.replace(/\/+$/, "");
  const sessionRoot = `${base}/v1/sessions/${encodeURIComponent(args.sessionId)}`;

  const memoResp = await requestJson(`${sessionRoot}/memos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "observation",
      tags: ["collaboration"],
      text: "Alice helped Bob clarify constraints.",
      anchors: { mode: "time", time_range_ms: [12000, 18000] }
    })
  });
  if (!memoResp.ok) {
    throw new Error(`memos POST failed: ${memoResp.status} ${JSON.stringify(memoResp.data)}`);
  }

  const finalizeResp = await requestJson(`${sessionRoot}/finalize?version=v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metadata: { smoke: true } })
  });
  if (!finalizeResp.ok) {
    throw new Error(`finalize v2 failed: ${finalizeResp.status} ${JSON.stringify(finalizeResp.data)}`);
  }

  const jobId = finalizeResp.data.job_id;
  if (!jobId) {
    throw new Error(`finalize v2 missing job_id: ${JSON.stringify(finalizeResp.data)}`);
  }

  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < args.timeoutMs) {
    const statusResp = await requestJson(`${sessionRoot}/finalize/status?job_id=${encodeURIComponent(jobId)}`);
    if (!statusResp.ok) {
      throw new Error(`status failed: ${statusResp.status} ${JSON.stringify(statusResp.data)}`);
    }
    lastStatus = statusResp.data;
    if (lastStatus.status === "succeeded") {
      break;
    }
    if (lastStatus.status === "failed") {
      throw new Error(`finalize v2 failed: ${JSON.stringify(lastStatus)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, args.pollMs));
  }

  if (!lastStatus || lastStatus.status !== "succeeded") {
    throw new Error(`finalize v2 timeout: ${JSON.stringify(lastStatus)}`);
  }

  const resultResp = await requestJson(`${sessionRoot}/result?version=v2`);
  if (!resultResp.ok) {
    throw new Error(`result v2 fetch failed: ${resultResp.status} ${JSON.stringify(resultResp.data)}`);
  }

  const requiredKeys = [
    "session",
    "transcript",
    "speaker_logs",
    "stats",
    "memos",
    "evidence",
    "overall",
    "per_person",
    "trace"
  ];
  for (const key of requiredKeys) {
    if (!(key in resultResp.data)) {
      throw new Error(`result v2 missing key: ${key}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        session_id: args.sessionId,
        job_id: jobId,
        status: lastStatus.status,
        transcript_count: Array.isArray(resultResp.data.transcript) ? resultResp.data.transcript.length : -1,
        evidence_count: Array.isArray(resultResp.data.evidence) ? resultResp.data.evidence.length : -1
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`[smoke_finalize_v2] ${error?.message || error}`);
  process.exitCode = 1;
});
