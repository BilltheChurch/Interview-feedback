#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPyannoteWindowBuilder } = require('../desktop/lib/pyannoteWindowBuilder.js');

function parseArgs(argv) {
  const out = {
    baseHttp: 'https://api.frontierace.ai',
    baseWs: 'wss://api.frontierace.ai',
    sessionId: `edge-e2e-${Date.now()}`,
    sidecarUrl: 'http://127.0.0.1:9705',
    alicePath: path.resolve('samples/alice_enroll.wav'),
    bobPath: path.resolve('samples/bob_enroll.wav'),
    segmentSeconds: 6,
    pollMs: 2000,
    timeoutMs: 240000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--base-http' && next) {
      out.baseHttp = next;
      i += 1;
    } else if (arg === '--base-ws' && next) {
      out.baseWs = next;
      i += 1;
    } else if (arg === '--session-id' && next) {
      out.sessionId = next;
      i += 1;
    } else if (arg === '--sidecar-url' && next) {
      out.sidecarUrl = next;
      i += 1;
    } else if (arg === '--alice' && next) {
      out.alicePath = path.resolve(next);
      i += 1;
    } else if (arg === '--bob' && next) {
      out.bobPath = path.resolve(next);
      i += 1;
    } else if (arg === '--segment-seconds' && next) {
      out.segmentSeconds = Number(next);
      i += 1;
    }
  }
  return out;
}

function decodePcm16FromWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`unsupported wav header: ${filePath}`);
  }

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + size;
    if (chunkEnd > buf.length) break;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(chunkStart),
        channels: buf.readUInt16LE(chunkStart + 2),
        sampleRate: buf.readUInt32LE(chunkStart + 4),
        bitsPerSample: buf.readUInt16LE(chunkStart + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (size % 2);
  }

  if (!fmt || !data) {
    throw new Error(`wav missing fmt/data chunk: ${filePath}`);
  }
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`wav must be PCM16LE: ${filePath}`);
  }
  if (fmt.sampleRate !== 16000) {
    throw new Error(`wav must be 16kHz for this test: ${filePath} (got ${fmt.sampleRate})`);
  }

  const totalSamples = Math.floor(data.length / 2 / fmt.channels);
  const mono = new Int16Array(totalSamples);

  if (fmt.channels === 1) {
    for (let i = 0; i < totalSamples; i += 1) {
      mono[i] = data.readInt16LE(i * 2);
    }
  } else if (fmt.channels === 2) {
    for (let i = 0; i < totalSamples; i += 1) {
      const left = data.readInt16LE(i * 4);
      const right = data.readInt16LE(i * 4 + 2);
      mono[i] = Math.round((left + right) / 2);
    }
  } else {
    throw new Error(`unsupported channel count ${fmt.channels}: ${filePath}`);
  }

  return {
    sampleRate: fmt.sampleRate,
    samples: mono,
  };
}

function concatInt16(chunks) {
  const len = chunks.reduce((n, arr) => n + arr.length, 0);
  const out = new Int16Array(len);
  let offset = 0;
  for (const arr of chunks) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function takeSeconds(samples, sampleRate, seconds) {
  const count = Math.max(0, Math.min(samples.length, Math.floor(sampleRate * seconds)));
  return samples.subarray(0, count);
}

function splitToOneSecondChunks(samples, sampleRate) {
  const chunkSamples = sampleRate;
  const out = [];
  for (let i = 0; i < samples.length; i += chunkSamples) {
    const slice = samples.subarray(i, Math.min(i + chunkSamples, samples.length));
    if (slice.length < chunkSamples) {
      const padded = new Int16Array(chunkSamples);
      padded.set(slice, 0);
      out.push(padded);
    } else {
      out.push(slice);
    }
  }
  return out;
}

function int16ToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.from(bytes).toString('base64');
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

async function waitForEvent(target, eventName, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${eventName}`)), timeoutMs);

    const onEvent = (event) => {
      cleanup();
      resolve(event);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`websocket error while waiting for ${eventName}`));
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`websocket closed before ${eventName}: code=${event.code} reason=${event.reason || 'none'}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener('error', onError);
      target.removeEventListener('close', onClose);
    };

    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
    target.addEventListener('close', onClose, { once: true });
  });
}

async function waitAck(ws, seq, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout seq=${seq}`)), timeoutMs);

    const onMessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.type === 'ack' && Number(payload.seq) === seq) {
          cleanup();
          resolve(payload);
        }
      } catch {
        // ignore parse errors for non-json frames
      }
    };

    const onError = () => {
      cleanup();
      reject(new Error(`websocket error waiting ack seq=${seq}`));
    };

    const onClose = () => {
      cleanup();
      reject(new Error(`websocket closed waiting ack seq=${seq}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
  });
}

async function postSpeakerLogs(baseHttp, sessionId, windowPayload, tracks) {
  const seqRange = Array.isArray(windowPayload.seq_range) ? windowPayload.seq_range : [0, 0];
  const turns = tracks.map((track, index) => ({
    turn_id: `${sessionId}-edge-${seqRange[0]}-${seqRange[1]}-${Math.round(Number(track.start_ms || 0))}-${index + 1}`,
    start_ms: Number(track.start_ms || 0),
    end_ms: Number(track.end_ms || 0),
    stream_role: 'students',
    cluster_id: String(track.speaker_id || `edge_${index + 1}`),
  }));

  const clusterMap = new Map();
  for (const turn of turns) {
    const prev = clusterMap.get(turn.cluster_id) || [];
    prev.push(turn.turn_id);
    clusterMap.set(turn.cluster_id, prev);
  }

  const clusters = Array.from(clusterMap.entries()).map(([clusterId, turnIds]) => ({
    cluster_id: clusterId,
    turn_ids: turnIds,
    confidence: null,
  }));

  const resp = await requestJson(`${baseHttp}/v1/sessions/${encodeURIComponent(sessionId)}/speaker-logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'edge',
      window: windowPayload.window || '10000ms/2000ms',
      start_end_ms: windowPayload.start_end_ms || null,
      turns,
      clusters,
      speaker_map: [],
    }),
  });
  if (!resp.ok) {
    throw new Error(`speaker-logs upload failed: ${resp.status} ${JSON.stringify(resp.data).slice(0, 240)}`);
  }
}

async function backfillStudents(baseHttp, sessionId) {
  for (let i = 0; i < 20; i += 1) {
    const stateResp = await requestJson(`${baseHttp}/v1/sessions/${encodeURIComponent(sessionId)}/state`);
    if (!stateResp.ok) {
      throw new Error(`state read failed: ${stateResp.status}`);
    }
    const ingest = stateResp.data?.ingest_by_stream?.students || {};
    const asr = stateResp.data?.asr_by_stream?.students || {};
    const lastSeq = Number(ingest.last_seq || 0);
    const lastEnd = Number(asr.last_window_end_seq || 0);

    if (lastSeq <= 0) {
      throw new Error('students ingest is empty after upload');
    }
    if (lastEnd >= lastSeq) {
      return { rounds: i + 1, lastSeq, lastEnd };
    }

    const runResp = await requestJson(
      `${baseHttp}/v1/sessions/${encodeURIComponent(sessionId)}/asr-run?stream_role=students&max_windows=8`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
    if (!runResp.ok) {
      throw new Error(`asr-run failed: ${runResp.status} ${JSON.stringify(runResp.data).slice(0, 240)}`);
    }
    const generated = Number(runResp.data?.generated || 0);
    if (generated <= 0 && lastEnd < lastSeq) {
      throw new Error(`asr-run generated=0 before catch-up: ${JSON.stringify(runResp.data)}`);
    }
  }
  throw new Error('students backfill did not catch up within 20 rounds');
}

async function finalizeAndFetch(baseHttp, sessionId, pollMs, timeoutMs) {
  const finResp = await requestJson(`${baseHttp}/v1/sessions/${encodeURIComponent(sessionId)}/finalize?version=v2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: { edge_e2e: true } }),
  });
  if (!finResp.ok) {
    throw new Error(`finalize v2 failed: ${finResp.status} ${JSON.stringify(finResp.data).slice(0, 240)}`);
  }
  const jobId = String(finResp.data?.job_id || '').trim();
  if (!jobId) throw new Error('finalize response missing job_id');

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const statusResp = await requestJson(
      `${baseHttp}/v1/sessions/${encodeURIComponent(sessionId)}/finalize/status?job_id=${encodeURIComponent(jobId)}`
    );
    if (!statusResp.ok) {
      throw new Error(`finalize status failed: ${statusResp.status}`);
    }
    const status = statusResp.data;
    if (status.status === 'succeeded') {
      const resultResp = await requestJson(
        `${baseHttp}/v1/sessions/${encodeURIComponent(sessionId)}/result?version=v2`
      );
      if (!resultResp.ok) {
        throw new Error(`result v2 fetch failed: ${resultResp.status}`);
      }
      return { jobId, status, result: resultResp.data };
    }
    if (status.status === 'failed') {
      throw new Error(`finalize failed: ${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('finalize polling timeout');
}

async function main() {
  const args = parseArgs(process.argv);
  const baseHttp = args.baseHttp.replace(/\/+$/, '');
  const baseWs = args.baseWs.replace(/\/+$/, '');

  const healthResp = await requestJson(`${args.sidecarUrl.replace(/\/+$/, '')}/health`);
  if (!healthResp.ok) {
    throw new Error(`sidecar health check failed: ${healthResp.status} ${JSON.stringify(healthResp.data)}`);
  }

  const alice = decodePcm16FromWav(args.alicePath);
  const bob = decodePcm16FromWav(args.bobPath);
  if (alice.sampleRate !== bob.sampleRate) {
    throw new Error('alice/bob sample rate mismatch');
  }

  const combined = concatInt16([
    takeSeconds(alice.samples, alice.sampleRate, args.segmentSeconds),
    takeSeconds(bob.samples, bob.sampleRate, args.segmentSeconds),
  ]);
  const chunks = splitToOneSecondChunks(combined, alice.sampleRate);

  const configResp = await requestJson(`${baseHttp}/v1/sessions/${encodeURIComponent(args.sessionId)}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ diarization_backend: 'edge' }),
  });
  if (!configResp.ok) {
    throw new Error(`set config failed: ${configResp.status} ${JSON.stringify(configResp.data).slice(0, 240)}`);
  }

  const ws = new WebSocket(`${baseWs}/v1/audio/ws/${encodeURIComponent(args.sessionId)}/students`);
  await waitForEvent(ws, 'open', 10000);

  ws.send(
    JSON.stringify({
      type: 'hello',
      stream_role: 'students',
      meeting_id: args.sessionId,
      sample_rate: 16000,
      channels: 1,
      format: 'pcm_s16le',
    })
  );

  const builder = createPyannoteWindowBuilder({ sampleRate: 16000, windowMs: 10000, hopMs: 2000 });
  let startMs = Date.now();
  let speakerLogUploads = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const seq = i + 1;
    const chunk = chunks[i];
    const timestampMs = startMs + i * 1000;
    const content_b64 = int16ToBase64(chunk);

    ws.send(
      JSON.stringify({
        type: 'chunk',
        stream_role: 'students',
        meeting_id: args.sessionId,
        seq,
        timestamp_ms: timestampMs,
        sample_rate: 16000,
        channels: 1,
        format: 'pcm_s16le',
        content_b64,
      })
    );

    const ack = await waitAck(ws, seq, 10000);
    if (ack.status !== 'stored') {
      throw new Error(`chunk ack not stored: seq=${seq} status=${ack.status}`);
    }

    const windowPayload = builder.pushSamples({ seq, timestampMs, samples: chunk });
    if (windowPayload) {
      const diarizeResp = await requestJson(`${args.sidecarUrl.replace(/\/+$/, '')}/diarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...windowPayload,
          session_id: args.sessionId,
        }),
      });
      if (!diarizeResp.ok) {
        throw new Error(`sidecar diarize failed: ${diarizeResp.status} ${JSON.stringify(diarizeResp.data).slice(0, 240)}`);
      }
      const tracks = Array.isArray(diarizeResp.data?.tracks) ? diarizeResp.data.tracks : [];
      if (tracks.length > 0) {
        await postSpeakerLogs(baseHttp, args.sessionId, windowPayload, tracks);
        speakerLogUploads += 1;
      }
    }
  }

  ws.send(JSON.stringify({ type: 'close', reason: 'edge-e2e-complete' }));
  await waitForEvent(ws, 'close', 10000);

  const backfill = await backfillStudents(baseHttp, args.sessionId);
  const finalized = await finalizeAndFetch(baseHttp, args.sessionId, args.pollMs, args.timeoutMs);

  const result = finalized.result || {};
  const diarizationBackend = result?.session?.diarization_backend;
  const speakerSource = result?.speaker_logs?.source;
  const speakerTurns = Array.isArray(result?.speaker_logs?.turns) ? result.speaker_logs.turns.length : 0;

  if (diarizationBackend !== 'edge') {
    throw new Error(`expected diarization_backend=edge, got ${String(diarizationBackend)}`);
  }
  if (speakerSource !== 'edge') {
    throw new Error(`expected speaker_logs.source=edge, got ${String(speakerSource)}`);
  }
  if (speakerTurns <= 0) {
    throw new Error('expected speaker_logs.turns > 0');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        session_id: args.sessionId,
        chunks_sent: chunks.length,
        speaker_log_uploads: speakerLogUploads,
        backfill,
        finalize_job_id: finalized.jobId,
        unresolved_cluster_count: result?.session?.unresolved_cluster_count ?? null,
        tentative: result?.session?.tentative ?? null,
        diarization_backend: diarizationBackend,
        speaker_logs_source: speakerSource,
        speaker_turns: speakerTurns,
        transcript_count: Array.isArray(result?.transcript) ? result.transcript.length : null,
        per_person_count: Array.isArray(result?.per_person) ? result.per_person.length : null,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`[edge_e2e_diarization] ${error?.message || error}`);
  process.exitCode = 1;
});
