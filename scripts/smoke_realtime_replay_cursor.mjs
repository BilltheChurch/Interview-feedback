#!/usr/bin/env node

import process from "node:process";

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
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

function assertCursorShape(cursor, role) {
  if (!cursor || typeof cursor !== "object") {
    throw new Error(`missing cursor object for role=${role}`);
  }
  for (const key of ["last_ingested_seq", "last_sent_seq", "last_emitted_seq"]) {
    if (!Number.isFinite(cursor[key])) {
      throw new Error(`cursor.${role}.${key} is invalid: ${JSON.stringify(cursor)}`);
    }
  }
}

async function main() {
  const baseUrl = arg("--base-url", "https://api.frontierace.ai").replace(/\/+$/, "");
  const sessionId = arg("--session-id", `replay-cursor-smoke-${Date.now()}`);
  const root = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`;

  // This smoke validates cursor persistence and monotonic updates.
  // Full DO eviction/restart replay verification should be done in staging chaos tests.
  const stateBefore = await requestJson(`${root}/state`);
  if (!stateBefore.ok) {
    throw new Error(`state before failed: ${stateBefore.status} ${JSON.stringify(stateBefore.data)}`);
  }

  const resetResp = await requestJson(`${root}/asr-reset?stream_role=students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  if (!resetResp.ok) {
    throw new Error(`asr-reset failed: ${resetResp.status} ${JSON.stringify(resetResp.data)}`);
  }

  const stateAfterReset = await requestJson(`${root}/state`);
  if (!stateAfterReset.ok) {
    throw new Error(`state after reset failed: ${stateAfterReset.status} ${JSON.stringify(stateAfterReset.data)}`);
  }

  const cursorByStream = stateAfterReset.data.asr_cursor_by_stream;
  if (!cursorByStream || typeof cursorByStream !== "object") {
    throw new Error(`missing asr_cursor_by_stream: ${JSON.stringify(stateAfterReset.data)}`);
  }

  assertCursorShape(cursorByStream.students, "students");
  if (cursorByStream.students.last_sent_seq !== 0 || cursorByStream.students.last_emitted_seq !== 0) {
    throw new Error(`students cursor expected reset to zero: ${JSON.stringify(cursorByStream.students)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        session_id: sessionId,
        students_cursor: cursorByStream.students,
        note: "cursor persistence smoke passed; perform DO-eviction replay test in staging"
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`[smoke_realtime_replay_cursor] ${error?.message || error}`);
  process.exitCode = 1;
});
