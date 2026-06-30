#!/usr/bin/env node
/**
 * Dual-Stream E2E Harness (teacher + students concurrent)
 *
 * Opens TWO WebSocket ingest connections simultaneously — one for the teacher
 * (interviewer mic, diarization off) and one for students (system-audio loopback,
 * diarization on → S-labels) — mimicking what the real Electron app does via
 * WebSocketService.connect(), which calls openSocket() for both roles concurrently
 * using Promise.all (WebSocketService.ts line 284).
 *
 * Auth handshake style (explicit choice):
 *   First frame after open: { type: "auth", key }
 *   Wait for { type: "auth_ok" } from server
 *   Then send: { type: "hello", stream_role, ... }
 *
 * This matches the reference harness (e2e_group_interview_test.mjs). The production
 * WebSocketService fires auth + hello back-to-back without waiting for auth_ok
 * (WebSocketService.ts onOpen handler ~lines 107-124) — BOTH styles work because the
 * server processes messages in order: after auth it returns auth_ok, then handles
 * the hello frame (it enforces a 10s auth timeout and closes with code 4401 on auth
 * failure — websocket-handler.ts:293). We use the wait-for-auth_ok style here for
 * clarity and to mirror the reference harness pattern exactly.
 *
 * Usage:
 *   node e2e_dual_stream_test.mjs \
 *     [--base-http http://127.0.0.1:8787] \
 *     [--base-ws   ws://127.0.0.1:8787] \
 *     [--chunk-delay 1000] \
 *     --audio-teacher /path/to/teacher.pcm \
 *     --audio-students /path/to/students.pcm
 *
 * Both PCM files must be 16kHz mono PCM16-LE (raw, no header).
 *
 * Requires the `ws` npm package (transitive dep in desktop/node_modules).
 * Run from the desktop/ directory where node_modules is present, or
 * run `npm install ws` first if ws is absent.
 */

import { readFileSync, writeFileSync } from 'fs';
import { WebSocket } from 'ws';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argVal(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const BASE_HTTP    = argVal('--base-http')       || 'http://127.0.0.1:8787';
const BASE_WS      = argVal('--base-ws')         || 'ws://127.0.0.1:8787';
const CHUNK_DELAY  = parseInt(argVal('--chunk-delay') || '1000', 10); // ms between 1-second chunks
const TEACHER_PCM  = argVal('--audio-teacher');
const STUDENTS_PCM = argVal('--audio-students');

// API key — matches the dev key in the reference harness
const API_KEY = 'c078a26cb3fa1edd4b6988687eae61aef6ded209e2f2092f0fcef9fb18ea8471';

// ── Validate required args ────────────────────────────────────────────────────

if (!TEACHER_PCM || !STUDENTS_PCM) {
  console.error('ERROR: --audio-teacher and --audio-students are required.');
  console.error('');
  console.error('Usage:');
  console.error('  node e2e_dual_stream_test.mjs \\');
  console.error('    --audio-teacher /path/to/teacher_16k.pcm \\');
  console.error('    --audio-students /path/to/students_16k.pcm \\');
  console.error('    [--base-http http://127.0.0.1:8787] \\');
  console.error('    [--base-ws ws://127.0.0.1:8787] \\');
  console.error('    [--chunk-delay 1000]');
  console.error('');
  console.error('Both PCM files must be 16 kHz / mono / PCM16-LE (raw, no WAV header).');
  process.exit(1);
}

// ── Session config ────────────────────────────────────────────────────────────

const SESSION_ID = `e2e_dual_${Date.now()}`;

// Dual-stream interview: one interviewer (teacher stream) + candidates (students stream)
const INTERVIEWER_NAME = 'Interviewer';
const PARTICIPANTS = ['Alice', 'Bob', 'Carol'];
const STAGES = ['Introduction', 'Group Discussion'];
const FREE_FORM_NOTES = `Dual-stream E2E validation session.
Teacher stream: interviewer audio captured via mic (no diarization).
Students stream: candidate audio via system-audio loopback (diarization enabled, S-labels).
Expected: per-person feedback only for students; interviewer appears as context only.`;

// ── Audio constants ───────────────────────────────────────────────────────────

const CHUNK_SAMPLES = 16000; // 1 second @ 16 kHz mono
const CHUNK_BYTES   = CHUNK_SAMPLES * 2; // PCM16-LE = 2 bytes per sample

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function httpJson(path, opts = {}) {
  const url = `${BASE_HTTP}${path}`;
  const res = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      ...opts.headers,
    },
    ...opts,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ── Step 1: Configure session ─────────────────────────────────────────────────

async function configureSession() {
  console.log(`\n=== Step 1: Configure session ${SESSION_ID} ===`);
  const res = await httpJson(`/v1/sessions/${SESSION_ID}/config`, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'group',
      interviewer_name: INTERVIEWER_NAME,
      participants: PARTICIPANTS,
      stages: STAGES,
      free_form_notes: FREE_FORM_NOTES,
    }),
  });
  console.log(`  Status: ${res.status}`);
  console.log(`  Response: ${JSON.stringify(res.data).slice(0, 300)}`);
  if (res.status >= 400) throw new Error(`Configure session failed: ${res.status}`);
}

// ── Step 2: Stream BOTH audio streams concurrently ────────────────────────────

/**
 * Opens a single ingest WebSocket for the given stream role and streams PCM data.
 *
 * Auth handshake (wait-for-auth_ok style):
 *   1. onOpen → send { type: "auth", key }
 *   2. Wait for { type: "auth_ok" } from server
 *   3. Send { type: "hello", stream_role, ... }
 *   4. Wait for { type: "ready" } then begin streaming PCM chunks
 *
 * Endpoint path: /v1/audio/ws/${sessionId}/${role}
 * (matches WebSocketService.ts buildWsUrl() — role is a PATH SEGMENT, not query param)
 */
async function streamRole(role, pcmData) {
  const tag = `[${role}]`;
  const totalChunks = Math.floor(pcmData.length / CHUNK_BYTES);
  const mbStr = (pcmData.length / 1024 / 1024).toFixed(1);

  console.log(`${tag} PCM: ${mbStr} MB → ${totalChunks} chunks (${totalChunks}s)`);

  // Path segment includes role; hello frame also includes stream_role (both required
  // by the server — path for routing, hello field for stream configuration).
  const wsUrl = `${BASE_WS}/v1/audio/ws/${SESSION_ID}/${role}`;
  console.log(`${tag} Connecting to ${wsUrl}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'x-api-key': API_KEY } });
    let seq = 0;
    let readyReceived = false;

    ws.on('open', () => {
      // Step 1 of handshake: send auth frame as the very first frame.
      // We do NOT send hello yet — we wait for auth_ok (see message handler below).
      // This matches the reference harness style (e2e_group_interview_test.mjs) for clarity.
      console.log(`${tag} Connected — sending auth frame`);
      ws.send(JSON.stringify({ type: 'auth', key: API_KEY }));
    });

    ws.on('message', async (rawMsg) => {
      let msg;
      try { msg = JSON.parse(rawMsg.toString()); } catch { return; }

      if (msg.type === 'auth_ok') {
        // Step 2 of handshake: server validated the key. Now send hello.
        // hello frame matches the production WebSocketService hello shape
        // (WebSocketService.ts ~line 110-124), including capture_mode: 'dual_stream'.
        console.log(`${tag} auth_ok received — sending hello (stream_role: ${role})`);
        ws.send(JSON.stringify({
          type: 'hello',
          stream_role: role,
          meeting_id: SESSION_ID,
          sample_rate: 16000,
          channels: 1,
          format: 'pcm_s16le',
          capture_mode: 'dual_stream',
          interviewer_name: INTERVIEWER_NAME,
          teams_interviewer_name: INTERVIEWER_NAME,
          teams_participants: PARTICIPANTS,
        }));
        return;
      }

      if (msg.type === 'ready') {
        readyReceived = true;
        const targetStr = `rate=${msg.target_sample_rate} ch=${msg.target_channels} fmt=${msg.target_format}`;
        console.log(`${tag} Worker ready (${targetStr}) — streaming ${totalChunks} chunks at ${CHUNK_DELAY}ms intervals`);

        const startMs = Date.now();
        for (let i = 0; i < totalChunks; i++) {
          seq++;
          const chunk = pcmData.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);

          ws.send(JSON.stringify({
            type: 'chunk',
            stream_role: role,
            meeting_id: SESSION_ID,
            seq,
            timestamp_ms: startMs + (i * 1000),
            sample_rate: 16000,
            channels: 1,
            format: 'pcm_s16le',
            content_b64: chunk.toString('base64'),
          }));

          // Progress log every 30 chunks (30 seconds of audio)
          if (seq % 30 === 0) {
            const pct = (seq / totalChunks * 100).toFixed(0);
            console.log(`${tag} Streamed ${seq}/${totalChunks} chunks (${pct}%)`);
          }

          await sleep(CHUNK_DELAY);
        }

        console.log(`${tag} Finished streaming ${seq} chunks — sending close`);
        ws.send(JSON.stringify({ type: 'close', stream_role: role, reason: 'e2e-dual-complete' }));
        await sleep(3000);
        ws.close();
        return;
      }

      if (msg.type === 'error') {
        console.error(`${tag} Worker error: ${msg.detail || msg.message || JSON.stringify(msg)}`);
      } else if (msg.type !== 'ack' && msg.type !== 'transcript') {
        // Log non-ack/non-transcript messages for diagnostic visibility
        console.log(`${tag} Worker message: ${msg.type} ${JSON.stringify(msg).slice(0, 120)}`);
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      console.log(`${tag} WebSocket closed (code=${code}${reasonStr ? ' reason=' + reasonStr : ''})`);
      if (code === 4401) {
        reject(new Error(`${role} stream: authentication rejected by server (close code 4401)`));
      } else if (readyReceived) {
        resolve();
      } else {
        reject(new Error(`${role} stream closed before ready (code=${code})`));
      }
    });

    ws.on('error', (err) => {
      console.error(`${tag} WebSocket error: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Opens BOTH teacher and students ingest WebSockets and streams PCM concurrently.
 * Both streams run in parallel, mirroring what the real app does
 * (WebSocketService.connect() line 284: Promise.all(STREAM_ROLES.map(openSocket))).
 *
 * Uses Promise.allSettled (a deliberate improvement over the app's Promise.all): both
 * streams run to completion and we report each outcome before surfacing any failure,
 * rather than aborting the moment the first stream rejects. This gives a fuller
 * diagnostic picture (e.g. teacher OK / students failed) for the R1 gate.
 */
async function streamBothConcurrently() {
  console.log('\n=== Step 2: Dual-stream concurrent audio ingest ===');
  console.log(`  teacher PCM:  ${TEACHER_PCM}`);
  console.log(`  students PCM: ${STUDENTS_PCM}`);
  console.log(`  chunk delay:  ${CHUNK_DELAY} ms`);

  const teacherPcm  = readFileSync(TEACHER_PCM);
  const studentsPcm = readFileSync(STUDENTS_PCM);

  // Both streams start at the same time — this is the core dual-stream validation.
  // If one is shorter, it finishes first; the other continues until done.
  const [teacherResult, studentsResult] = await Promise.allSettled([
    streamRole('teacher',  teacherPcm),
    streamRole('students', studentsPcm),
  ]);

  // Report per-stream outcome but don't fail immediately — let both finish
  if (teacherResult.status === 'rejected') {
    console.error(`  [teacher]  FAILED: ${teacherResult.reason?.message}`);
  } else {
    console.log('  [teacher]  OK');
  }
  if (studentsResult.status === 'rejected') {
    console.error(`  [students] FAILED: ${studentsResult.reason?.message}`);
  } else {
    console.log('  [students] OK');
  }

  // Fail the harness if either stream failed
  if (teacherResult.status === 'rejected') throw teacherResult.reason;
  if (studentsResult.status === 'rejected') throw studentsResult.reason;
}

// ── Step 3: Trigger finalization ──────────────────────────────────────────────

async function triggerFinalize() {
  console.log('\n=== Step 3: Trigger finalization ===');
  const res = await httpJson(`/v1/sessions/${SESSION_ID}/finalize?version=v2`, {
    method: 'POST',
    body: JSON.stringify({
      metadata: {
        free_form_notes: FREE_FORM_NOTES,
        stages: STAGES,
        participants: PARTICIPANTS,
        interviewer_name: INTERVIEWER_NAME,
      },
    }),
  });
  console.log(`  Status: ${res.status}`);
  console.log(`  Response: ${JSON.stringify(res.data).slice(0, 300)}`);
  if (res.status >= 400) throw new Error(`Finalize failed: ${res.status}`);
  return res.data;
}

// ── Step 4: Poll finalization status ──────────────────────────────────────────

async function pollStatus() {
  console.log('\n=== Step 4: Poll finalization status ===');

  const maxWait  = 600_000; // 10 min — cloud pipeline is faster than local Whisper
  const interval = 5_000;
  const start    = Date.now();

  while (Date.now() - start < maxWait) {
    const res = await httpJson(`/v1/sessions/${SESSION_ID}/finalize/status`);
    const status  = res.data?.status;
    const stage   = res.data?.current_stage || res.data?.stage;
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);

    console.log(`  [${elapsed}s] status=${status} stage=${stage}`);

    if (status === 'succeeded' || status === 'completed') {
      console.log(`  Finalization succeeded in ${elapsed}s`);
      return elapsed;
    }
    if (status === 'failed') {
      const detail = JSON.stringify(res.data).slice(0, 400);
      throw new Error(`Finalization failed: ${detail}`);
    }

    await sleep(interval);
  }

  throw new Error('Finalization timed out after 10 minutes');
}

// ── Step 5: Fetch result & validate dual-stream output ────────────────────────

async function getAndValidateResult(finalizeElapsedSec) {
  console.log('\n=== Step 5: Fetch result & validate dual-stream output ===');

  const res = await httpJson(`/v1/sessions/${SESSION_ID}/result?version=v2`);
  console.log(`  HTTP status: ${res.status}`);
  if (res.status >= 400) {
    throw new Error(`Get result failed: ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
  }

  const result = res.data;

  // ── Transcript analysis: which streams/speakers appeared ──
  const transcript = result.transcript || [];
  console.log(`\n  Transcript: ${transcript.length} utterances`);

  const speakerCounts = {};
  const roleSet = new Set();
  transcript.forEach(u => {
    const name = u.speaker_name || u.cluster_id || 'unknown';
    speakerCounts[name] = (speakerCounts[name] || 0) + 1;
    if (u.stream_role) roleSet.add(u.stream_role);
  });

  console.log('  Utterance counts by speaker:');
  Object.entries(speakerCounts).forEach(([name, count]) => {
    console.log(`    ${name}: ${count} utterances`);
  });

  // Show first 5 utterances
  transcript.slice(0, 5).forEach(u => {
    const name = u.speaker_name || u.cluster_id || '?';
    const role = u.stream_role ? ` [${u.stream_role}]` : '';
    console.log(`    [${u.utterance_id}]${role} ${name}: "${u.text?.slice(0, 60)}..."`);
  });

  // ── Per-person feedback: should be students only ──
  const perPerson = result.per_person || [];
  console.log(`\n  Per-person feedback: ${perPerson.length} persons`);
  perPerson.forEach(p => {
    const displayName = p.display_name || p.person_key;
    const dims = (p.dimensions || []).length;
    console.log(`    ${displayName}: ${dims} dimension(s)`);
    (p.dimensions || []).forEach(d => {
      const s = d.strengths?.length || 0;
      const r = d.risks?.length || 0;
      const a = d.actions?.length || 0;
      console.log(`      ${d.dimension}: ${s}S ${r}R ${a}A`);
    });
  });

  // ── Overall: should contain interviewer context ──
  const overall = result.overall;
  const hasTeacherContext = !!(
    overall?.teacher_memos?.length ||
    overall?.interviewer_context ||
    (typeof overall?.summary_sections === 'object' &&
      JSON.stringify(overall).toLowerCase().includes('interview'))
  );

  console.log(`\n  Overall interviewer/teacher context present: ${hasTeacherContext}`);
  if (overall?.teacher_memos?.length) {
    console.log('  Teacher memos:');
    overall.teacher_memos.slice(0, 3).forEach(m => {
      console.log(`    - ${String(m).slice(0, 120)}`);
    });
  }
  if (overall?.summary_sections?.length) {
    console.log('  Summary sections:');
    overall.summary_sections.slice(0, 3).forEach(s => {
      console.log(`    ${s.topic || s.title || '?'}:`);
      (s.bullets || []).slice(0, 2).forEach(b => console.log(`      - ${String(b).slice(0, 100)}`));
    });
  }

  // ── Quality / stats ──
  const quality = result.quality;
  if (quality) {
    console.log(`\n  Quality: source=${quality.report_source} model=${quality.report_model} degraded=${quality.report_degraded}`);
    console.log(`  Claims: ${quality.claim_count} total, ${quality.invalid_claim_count} invalid`);
    console.log(`  Build time: ${quality.build_ms}ms`);
    if (quality.warnings?.length) {
      quality.warnings.forEach(w => console.log(`  WARN: ${w}`));
    }
  }

  const stats = result.stats || [];
  console.log(`\n  Speaker stats: ${stats.length} speakers`);
  stats.forEach(s => {
    const talkSec = ((s.talk_time_ms || 0) / 1000).toFixed(0);
    const stream  = s.stream_role ? ` [${s.stream_role}]` : '';
    console.log(`    ${s.speaker_name || s.speaker_key}${stream}: ${talkSec}s, ${s.turns} turn(s)`);
  });

  // ── Gate R1 summary ──
  console.log('\n  ── Gate R1 dual-stream validation summary ──');
  const studentsPersonCount = perPerson.length;
  const teacherInPerPerson = perPerson.some(p => {
    const name = (p.display_name || p.person_key || '').toLowerCase();
    return name.includes('interviewer') || name.includes('teacher');
  });

  console.log(`  Stream roles in transcript:      ${[...roleSet].join(', ') || '(none)'}`);
  console.log(`  Students per-person count:      ${studentsPersonCount}`);
  console.log(`  Interviewer in per-person:       ${teacherInPerPerson ? 'YES (unexpected — check report logic)' : 'NO (correct)'}`);
  console.log(`  Interviewer as context:          ${hasTeacherContext}`);
  console.log(`  Finalize elapsed:                ${finalizeElapsedSec}s`);

  // Warn on known failure patterns but don't gate hard — let the user judge for R1
  if (teacherInPerPerson) {
    console.warn('  WARN: Interviewer appears in per-person feedback. Expected students-only.');
  }
  if (studentsPersonCount === 0) {
    console.warn('  WARN: No per-person feedback generated. Students stream may not have diarized.');
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Dual-Stream E2E Harness (teacher + students)    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Session ID:    ${SESSION_ID}`);
  console.log(`Interviewer:   ${INTERVIEWER_NAME} (teacher stream — no diarization)`);
  console.log(`Participants:  ${PARTICIPANTS.join(', ')} (students stream — diarization on)`);
  console.log(`Teacher PCM:   ${TEACHER_PCM}`);
  console.log(`Students PCM:  ${STUDENTS_PCM}`);
  console.log(`Chunk delay:   ${CHUNK_DELAY} ms`);
  console.log(`Endpoint:      ${BASE_HTTP}`);

  try {
    await configureSession();            // Step 1
    await streamBothConcurrently();      // Step 2 — teacher + students WS concurrently
    const finalizeData = await triggerFinalize();  // Step 3
    const elapsed = await pollStatus();  // Step 4
    const result = await getAndValidateResult(elapsed);  // Step 5

    // Save full result for offline analysis
    const outPath = `/tmp/e2e_dual_result_${SESSION_ID}.json`;
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\nFull result saved: ${outPath}`);

    const totalMs = ((Date.now() - startMs) / 1000).toFixed(0);
    console.log(`\nTotal wall time: ${totalMs}s`);
    console.log('\n✅ DUAL-STREAM E2E PASSED');

  } catch (err) {
    const totalMs = ((Date.now() - startMs) / 1000).toFixed(0);
    console.error(`\n❌ DUAL-STREAM E2E FAILED after ${totalMs}s: ${err.message}`);
    process.exit(1);
  }
}

main();
