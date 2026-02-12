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

async function main() {
  const baseUrl = arg("--base-url", "https://api.frontierace.ai").replace(/\/+$/, "");
  const sessionId = arg("--session-id", `cluster-map-validation-${Date.now()}`);
  const root = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`;

  const configResp = await requestJson(`${root}/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teams_participants: [{ name: "Alice" }, { name: "Bob" }] })
  });
  if (!configResp.ok) {
    throw new Error(`config failed: ${configResp.status} ${JSON.stringify(configResp.data)}`);
  }

  const badMapResp = await requestJson(`${root}/cluster-map`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream_role: "students",
      cluster_id: "c-does-not-exist",
      participant_name: "Alice",
      lock: true,
      mode: "bind"
    })
  });

  if (badMapResp.status !== 400) {
    throw new Error(`expected 400 for invalid cluster_id, got ${badMapResp.status}: ${JSON.stringify(badMapResp.data)}`);
  }
  if (!Array.isArray(badMapResp.data.available_cluster_ids)) {
    throw new Error(`expected available_cluster_ids array in response: ${JSON.stringify(badMapResp.data)}`);
  }

  const prebindResp = await requestJson(`${root}/cluster-map`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream_role: "students",
      cluster_id: "c-prebind",
      participant_name: "Bob",
      mode: "prebind"
    })
  });
  if (!prebindResp.ok) {
    throw new Error(`prebind failed: ${prebindResp.status} ${JSON.stringify(prebindResp.data)}`);
  }
  if (prebindResp.data.mode !== "prebind") {
    throw new Error(`expected prebind mode response: ${JSON.stringify(prebindResp.data)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        session_id: sessionId,
        invalid_bind_status: badMapResp.status,
        prebind_mode: prebindResp.data.mode
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`[smoke_cluster_map_validation] ${error?.message || error}`);
  process.exitCode = 1;
});
