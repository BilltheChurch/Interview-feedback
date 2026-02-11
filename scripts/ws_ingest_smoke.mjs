#!/usr/bin/env node

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

const baseHttp = argValue("--base-http", "http://127.0.0.1:8787");
const baseWs = argValue("--base-ws", "ws://127.0.0.1:8787");
const sessionId = argValue("--session-id", `ws-smoke-${Date.now()}`);
const chunkCount = Number(argValue("--chunks", "3"));

if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
  throw new Error("--chunks must be a positive integer");
}

function int16ToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.from(bytes).toString("base64");
}

function buildChunk(seq) {
  const samples = new Int16Array(16000);
  const freq = 220 + seq * 10;
  const sampleRate = 16000;

  for (let i = 0; i < samples.length; i += 1) {
    const t = i / sampleRate;
    samples[i] = Math.floor(Math.sin(2 * Math.PI * freq * t) * 0x6fff);
  }

  return {
    type: "chunk",
    meeting_id: sessionId,
    seq,
    timestamp_ms: Date.now(),
    sample_rate: 16000,
    channels: 1,
    format: "pcm_s16le",
    content_b64: int16ToBase64(samples)
  };
}

function waitForEvent(target, name, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${name}`));
    }, timeoutMs);

    const cleanupErrorHandlers = () => {
      target.removeEventListener("error", onError);
      target.removeEventListener("close", onClose);
    };

    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(name, onEvent);
      cleanupErrorHandlers();
    };

    const onEvent = (event) => {
      cleanup();
      resolve(event);
    };

    const onError = () => {
      cleanup();
      reject(new Error(`received websocket error while waiting for ${name}`));
    };

    const onClose = (event) => {
      cleanup();
      reject(new Error(`websocket closed before ${name}: code=${event.code} reason=${event.reason || "none"}`));
    };

    target.addEventListener(name, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
    target.addEventListener("close", onClose, { once: true });
  });
}

async function main() {
  const wsUrl = `${baseWs.replace(/\/+$/, "")}/v1/audio/ws/${encodeURIComponent(sessionId)}`;
  const httpStateUrl = `${baseHttp.replace(/\/+$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}/state`;

  const ws = new WebSocket(wsUrl);
  await waitForEvent(ws, "open", 10000);
  console.log(`connected: ${wsUrl}`);

  let ackCount = 0;
  let missingCount = 0;

  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "ack") {
      ackCount += 1;
      missingCount = Number(payload.missing_count ?? missingCount);
      console.log(`ack seq=${payload.seq} status=${payload.status}`);
      return;
    }
    if (payload.type === "error") {
      throw new Error(`server error: ${payload.detail}`);
    }
    if (payload.type === "status") {
      console.log(`status last_seq=${payload.last_seq} received=${payload.received_chunks}`);
    }
  });

  ws.send(
    JSON.stringify({
      type: "hello",
      meeting_id: sessionId,
      sample_rate: 16000,
      channels: 1,
      format: "pcm_s16le"
    })
  );

  for (let seq = 1; seq <= chunkCount; seq += 1) {
    ws.send(JSON.stringify(buildChunk(seq)));
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
  ws.send(JSON.stringify({ type: "status" }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  ws.send(JSON.stringify({ type: "close", reason: "smoke-complete" }));
  await waitForEvent(ws, "close", 10000);

  if (ackCount !== chunkCount) {
    throw new Error(`expected ${chunkCount} ack, got ${ackCount}`);
  }
  if (missingCount !== 0) {
    throw new Error(`expected missing_count=0, got ${missingCount}`);
  }

  const stateResp = await fetch(httpStateUrl);
  if (!stateResp.ok) {
    throw new Error(`state endpoint failed: HTTP ${stateResp.status}`);
  }
  const state = await stateResp.json();
  const ingest = state.ingest;
  if (!ingest) {
    throw new Error("state.ingest is missing");
  }
  if (ingest.received_chunks !== chunkCount) {
    throw new Error(`expected received_chunks=${chunkCount}, got ${ingest.received_chunks}`);
  }
  if (ingest.missing_chunks !== 0) {
    throw new Error(`expected ingest.missing_chunks=0, got ${ingest.missing_chunks}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        session_id: sessionId,
        received_chunks: ingest.received_chunks,
        last_seq: ingest.last_seq,
        bytes_stored: ingest.bytes_stored
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`ws_ingest_smoke failed: ${error.message}`);
  process.exit(1);
});
