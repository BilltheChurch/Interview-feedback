/**
 * dashscope-asr.ts — DashScope FunASR windowed transcription.
 *
 * Extracted from MeetingSessionDO to reduce index.ts size.
 * Standalone function with explicit parameters instead of `this`.
 */

import type { Env } from "./config";
import {
  parseTimeoutMs,
  parsePositiveInt,
  sleep,
  extractFirstString,
  DASHSCOPE_DEFAULT_WS_URL,
  DASHSCOPE_TIMEOUT_CAP_MS,
  toWebSocketHandshakeUrl,
} from "./config";
import { TARGET_SAMPLE_RATE } from "./audio-utils";

/**
 * Run a single windowed ASR transcription via DashScope FunASR WebSocket.
 * Opens a new WebSocket connection, sends audio, waits for the result, and closes.
 */
export async function runFunAsrDashScope(
  env: Env,
  wavBytes: Uint8Array,
  model: string
): Promise<{ text: string; latencyMs: number }> {
  const apiKey = (env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("ALIYUN_DASHSCOPE_API_KEY is missing");
  }

  const wsUrl = env.ASR_WS_URL ?? DASHSCOPE_DEFAULT_WS_URL;
  const handshakeUrl = toWebSocketHandshakeUrl(wsUrl);
  const timeoutMs = parseTimeoutMs(env.ASR_TIMEOUT_MS ?? "45000");
  const taskId = `asr-${crypto.randomUUID()}`;
  const startedAt = Date.now();

  const response = await fetch(handshakeUrl, {
    method: "GET",
    headers: {
      Authorization: `bearer ${apiKey}`,
      Upgrade: "websocket"
    }
  });

  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`dashscope websocket handshake failed: HTTP ${response.status}`);
  }

  const ws = response.webSocket;
  ws.accept();

  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let finishedResolve: (() => void) | null = null;
  let finishedReject: ((error: Error) => void) | null = null;
  let readyDone = false;
  let finishedDone = false;
  let latestText = "";

  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finishedPromise = new Promise<void>((resolve, reject) => {
    finishedResolve = resolve;
    finishedReject = reject;
  });

  const rejectAll = (error: Error): void => {
    if (!readyDone) {
      readyDone = true;
      readyReject?.(error);
    }
    if (!finishedDone) {
      finishedDone = true;
      finishedReject?.(error);
    }
  };

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    const messageObject = payload as Record<string, unknown>;
    const headerObject = (messageObject.header ?? null) as Record<string, unknown> | null;
    const payloadObject = messageObject.payload ?? null;
    const eventName = String(headerObject?.event ?? "");
    if (eventName === "task-started") {
      if (!readyDone) {
        readyDone = true;
        readyResolve?.();
      }
      return;
    }

    if (eventName === "result-generated") {
      const text = extractFirstString(payloadObject);
      if (text) {
        latestText = text;
      }
      return;
    }

    if (eventName === "task-finished") {
      const text = extractFirstString(payloadObject);
      if (text) {
        latestText = text;
      }
      if (!finishedDone) {
        finishedDone = true;
        finishedResolve?.();
      }
      return;
    }

    if (eventName === "task-failed") {
      rejectAll(new Error(`dashscope task failed: ${JSON.stringify(payload)}`));
    }
  });

  ws.addEventListener("error", () => {
    rejectAll(new Error("dashscope websocket error"));
  });

  ws.addEventListener("close", (event) => {
    if (!finishedDone) {
      rejectAll(new Error(`dashscope websocket closed early: code=${event.code} reason=${event.reason || "none"}`));
    }
  });

  ws.send(
    JSON.stringify({
      header: {
        action: "run-task",
        task_id: taskId,
        streaming: "duplex"
      },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model,
        input: {},
        parameters: {
          format: "wav",
          sample_rate: TARGET_SAMPLE_RATE
        }
      }
    })
  );

  const readyTimer = setTimeout(() => {
    rejectAll(new Error("dashscope task-started timeout"));
  }, Math.min(timeoutMs, DASHSCOPE_TIMEOUT_CAP_MS));
  await readyPromise;
  clearTimeout(readyTimer);

  const streamChunkBytes = parsePositiveInt(env.ASR_STREAM_CHUNK_BYTES, 12800);
  const pacingMs = Number.isFinite(Number(env.ASR_SEND_PACING_MS))
    ? Math.max(0, Number(env.ASR_SEND_PACING_MS))
    : 0;
  for (let offset = 0; offset < wavBytes.byteLength; offset += streamChunkBytes) {
    const end = Math.min(offset + streamChunkBytes, wavBytes.byteLength);
    ws.send(wavBytes.slice(offset, end));
    if (pacingMs > 0) {
      await sleep(pacingMs);
    }
  }

  ws.send(
    JSON.stringify({
      header: {
        action: "finish-task",
        task_id: taskId,
        streaming: "duplex"
      },
      payload: {
        input: {}
      }
    })
  );

  const finishedTimer = setTimeout(() => {
    rejectAll(new Error("dashscope task-finished timeout"));
  }, timeoutMs);
  await finishedPromise;
  clearTimeout(finishedTimer);

  try {
    ws.close(1000, "done");
  } catch {
    // ignore
  }

  return {
    text: latestText.trim(),
    latencyMs: Date.now() - startedAt
  };
}
