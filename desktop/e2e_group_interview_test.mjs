#!/usr/bin/env node
/**
 * End-to-End Group Interview Test
 *
 * Streams a pre-recorded PCM audio file through the edge worker's WebSocket,
 * sends memos via POST /memos API during the session,
 * triggers finalization with free-form notes, and validates the result.
 *
 * Usage:
 *   node e2e_group_interview_test.mjs [--audio /path/to/file.pcm]
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const { createPyannoteWindowBuilder } = require('./lib/pyannoteWindowBuilder.js');

// ── CLI args ──
const args = process.argv.slice(2);
function argVal(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const BASE_HTTP = argVal('--base-http') || 'http://127.0.0.1:8787';
const BASE_WS = argVal('--base-ws') || 'ws://127.0.0.1:8787';
const API_KEY = 'c078a26cb3fa1edd4b6988687eae61aef6ded209e2f2092f0fcef9fb18ea8471';
const PCM_FILE = argVal('--audio') || '/tmp/group_interview_real_16k.pcm';
const SESSION_ID = `e2e_group_${Date.now()}`;
const CHUNK_SAMPLES = 16000; // 1 second @ 16kHz mono
const CHUNK_BYTES = CHUNK_SAMPLES * 2; // 16-bit = 2 bytes per sample
const CHUNK_DELAY_MS = 50; // send faster than real-time for testing
const SIDECAR_URL = argVal('--sidecar-url') || 'http://127.0.0.1:9705';
const USE_EDGE_DIARIZATION = args.includes('--edge-diarization');

// ── Participants ──
// Group interview: 4 students, no interviewer.
// Biomedical engineering group discussion.
const PARTICIPANTS = [
  'Tina',
  { name: 'Rice', aliases: ['小米'] },
  { name: 'Stephenie', aliases: ['思涵'] },
  'Daisy',
];
const INTERVIEWER_NAME = ''; // No interviewer in this audio

// ── Interview stages ──
const STAGES = ['Self Introduction', 'Q1 Discussion'];

// ── Memos (observer notes taken during interview) ──
const MEMOS = [
  { type: 'observation', text: 'Stephenie很好的开场，提出lightweight', tags: ['leadership', 'initiative'] },
  { type: 'observation', text: 'Daisy提出了很好的观点', tags: ['initiative'] },
  { type: 'observation', text: 'Tina确认了一下别人的观点，提出了biocompatibility', tags: ['collaboration', 'initiative'] },
  { type: 'observation', text: 'Rice也很好的提出了观点，关于repair', tags: ['initiative'] },
  { type: 'observation', text: 'Tina很好很自然地给出了关于补充的总结，然后也带到大家去rank', tags: ['leadership', 'structure'] },
  { type: 'observation', text: '思涵也很好的给了most important的观点', tags: ['initiative', 'logic'] },
  { type: 'observation', text: 'Tina给了不同的意见，给了非常好的建议，非常详细的讲解', tags: ['leadership', 'logic'] },
  { type: 'observation', text: 'Rice也很好的尝试了给出了自己的观点说biocompatibility应该是最重要的，给出了没有这个的后果', tags: ['logic', 'initiative'] },
  { type: 'observation', text: 'Daisy同意了小米的观点，很快的加强了一下论证，提到了important的两个建议', tags: ['collaboration'] },
  { type: 'observation', text: 'Tina很好的提到了问题中的内容，很好的callback', tags: ['logic', 'structure'] },
  { type: 'observation', text: '思涵同意了观点，就继续到其他的排序了，从least开始', tags: ['collaboration'] },
  { type: 'evidence', text: '总体时间把控不太好，least说了一个点，但没有完成整个任务', tags: ['structure'] },
];

const FREE_FORM_NOTES = `面试结构是从自我介绍到群面的第一道题的回答。主题是生物医学工程专业的群面。在我提供的音频里面，没有面试官的声音，全是面试者的声音。

Stephenie很好的开场，提出lightweight，Daisy提出了很好的观点，然后Tina确认了一下别人的观点，提出了biocompatability，Rice也很好的提出了观点，关于repair。Tina很好很自然地给出了关于补充的总结，然后也带到大家去rank，这时候思涵也很好的给了most Important的观点，Tina给了不同的意见，给了非常好的建议这里，非常详细的讲解。然后小米Rice也很好的尝试了给出了自己的观点说biocompatability应该是最重要的，给出了没有的这个的后果。这里大概就花了4分钟了，daisy同意了小米的观点，很快的加强了一下论证，提到了important的两个建议。Tina很好的提到了问题中的内容，很好的callback，然后思涵同意了观点，就继续到其他的排序了，从least开始。总体时间把控不太好，least说了一个点，但没有完成整个任务。`;

// ── Helpers ──

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function httpJson(path, opts = {}) {
  const url = `${BASE_HTTP}${path}`;
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...opts.headers },
    ...opts,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ── Step 1: Configure session ──

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
      diarization_backend: USE_EDGE_DIARIZATION ? 'edge' : 'cloud',
    }),
  });
  console.log(`  Status: ${res.status}`);
  console.log(`  Response: ${JSON.stringify(res.data).slice(0, 300)}`);
  if (res.status >= 400) throw new Error(`Configure session failed: ${res.status}`);
}

// ── Step 1b: Start enrollment (switches mode to "collecting") ──

async function startEnrollment() {
  console.log(`\n=== Step 1b: Start enrollment ===`);
  const res = await httpJson(`/v1/sessions/${SESSION_ID}/enrollment/start`, {
    method: 'POST',
    body: JSON.stringify({
      participants: PARTICIPANTS,
    }),
  });
  console.log(`  Status: ${res.status}`);
  const enrollState = res.data?.enrollment_state;
  if (enrollState) {
    console.log(`  Mode: ${enrollState.mode}`);
    console.log(`  Participants: ${Object.keys(enrollState.participants || {}).join(', ')}`);
  }
  if (res.status >= 400) throw new Error(`Enrollment start failed: ${res.status}`);
}

// ── Step 2: Stream audio via WebSocket ──

async function streamAudio() {
  console.log('\n=== Step 2: Stream audio via WebSocket ===');

  const pcmData = readFileSync(PCM_FILE);
  const totalChunks = Math.floor(pcmData.length / CHUNK_BYTES);
  console.log(`  PCM file: ${(pcmData.length / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Total chunks: ${totalChunks} (${totalChunks}s of audio)`);

  const wsUrl = `${BASE_WS}/v1/audio/ws/${SESSION_ID}/students`;
  console.log(`  Connecting to ${wsUrl}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'x-api-key': API_KEY } });
    let seq = 0;
    let readyReceived = false;

    ws.on('open', () => {
      console.log('  WebSocket connected');
      ws.send(JSON.stringify({
        type: 'hello',
        stream_role: 'students',
        interviewer_name: INTERVIEWER_NAME,
        teams_participants: PARTICIPANTS,
      }));
    });

    ws.on('message', async (rawMsg) => {
      const msg = JSON.parse(rawMsg.toString());
      if (msg.type === 'ready') {
        readyReceived = true;
        console.log('  Worker ready, streaming audio...');
        console.log(`  Target: rate=${msg.target_sample_rate} ch=${msg.target_channels} fmt=${msg.target_format}`);

        const startMs = Date.now();
        for (let i = 0; i < totalChunks; i++) {
          seq++;
          const chunk = pcmData.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);

          ws.send(JSON.stringify({
            type: 'chunk',
            meeting_id: SESSION_ID,
            seq,
            timestamp_ms: startMs + (i * 1000),
            sample_rate: 16000,
            channels: 1,
            format: 'pcm_s16le',
            content_b64: chunk.toString('base64'),
          }));

          if (seq % 60 === 0) {
            console.log(`  Sent ${seq}/${totalChunks} chunks (${(seq / totalChunks * 100).toFixed(0)}%)`);
          }
          await sleep(CHUNK_DELAY_MS);
        }

        console.log(`  Finished streaming ${seq} chunks`);
        ws.send(JSON.stringify({ type: 'close', reason: 'test-complete' }));
        await sleep(3000);
        ws.close();
      } else if (msg.type === 'error') {
        console.error(`  Worker error: ${msg.detail || msg.message}`);
      } else if (msg.type !== 'ack') {
        console.log(`  Worker message: ${msg.type} ${JSON.stringify(msg).slice(0, 120)}`);
      }
    });

    ws.on('close', () => {
      console.log('  WebSocket closed');
      if (readyReceived) resolve();
      else reject(new Error('WebSocket closed before ready'));
    });

    ws.on('error', (err) => {
      console.error(`  WebSocket error: ${err.message}`);
      reject(err);
    });
  });
}

// ── Step 2b: Run pyannote edge diarization on audio windows ──

const INFERENCE_URL = argVal('--inference-url') || 'http://127.0.0.1:8000';
const INFERENCE_API_KEY = argVal('--inference-api-key') || '93bbf4cb9878b3e82db41bda655e16358df1a73f20787cd5a9178059252dda90';
const DIARIZE_MAX_RETRIES = 2;
const DIARIZE_RETRY_BACKOFF_MS = 500;

// Collected diarization segments for enrollment simulation
const collectedSegments = [];

async function fetchWithRetry(url, opts, maxRetries = DIARIZE_MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.ok || resp.status < 500) return resp;
      const body = await resp.text().catch(() => '');
      console.error(`  [attempt ${attempt + 1}/${maxRetries + 1}] HTTP ${resp.status}: ${body.slice(0, 200)}`);
      lastError = new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    } catch (err) {
      console.error(`  [attempt ${attempt + 1}/${maxRetries + 1}] Network error: ${err.message}`);
      lastError = err;
    }
    if (attempt < maxRetries) {
      const backoff = DIARIZE_RETRY_BACKOFF_MS * Math.pow(2, attempt);
      await sleep(backoff);
    }
  }
  return { ok: false, status: 500, lastError };
}

async function runEdgeDiarization() {
  if (!USE_EDGE_DIARIZATION) return;
  console.log('\n=== Step 2b: Edge diarization via pyannote sidecar ===');

  // Check sidecar health
  const healthResp = await fetch(`${SIDECAR_URL}/health`);
  if (!healthResp.ok) throw new Error(`Sidecar health failed: ${healthResp.status}`);
  const healthData = await healthResp.json();
  console.log(`  Sidecar: ${healthData.segmentation_model?.split('/').pop()}`);

  const pcmData = readFileSync(PCM_FILE);
  const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
  const builder = createPyannoteWindowBuilder({ sampleRate: 16000, windowMs: 10000, hopMs: 2000 });

  const chunkSamples = 16000; // 1 second
  const totalChunks = Math.floor(samples.length / chunkSamples);
  const startMs = Date.now();
  let windowCount = 0;
  let speakerLogUploads = 0;
  let diarizeFails = 0;

  for (let i = 0; i < totalChunks; i++) {
    const seq = i + 1;
    const chunk = samples.subarray(i * chunkSamples, (i + 1) * chunkSamples);
    const timestampMs = startMs + i * 1000;

    const windowPayload = builder.pushSamples({ seq, timestampMs, samples: chunk });
    if (!windowPayload) continue;
    windowCount++;

    // Send window to pyannote sidecar with retry
    const diarizeResp = await fetchWithRetry(`${SIDECAR_URL}/diarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...windowPayload, session_id: SESSION_ID }),
    });
    if (!diarizeResp.ok) {
      diarizeFails++;
      continue;
    }
    const diarizeData = await diarizeResp.json();
    const tracks = Array.isArray(diarizeData.tracks) ? diarizeData.tracks : [];

    if (tracks.length === 0) continue;

    // Upload speaker logs to worker
    const seqRange = windowPayload.seq_range || [0, 0];
    // Convert wall-clock pyannote times to session-relative time.
    // Track times are in wall-clock ms; subtract window's wall-clock start to get
    // relative position, then add session-relative window start.
    const sessionWindowStartMs = (seqRange[0] - 1) * 1000;
    const [windowWallStart] = windowPayload.start_end_ms || [0, 0];
    // Use window-scoped cluster IDs to prevent cross-window speaker label collision.
    // Pyannote labels (SPEAKER_00, SPEAKER_01) are per-window only, NOT globally consistent.
    const windowTag = `w${seqRange[0]}_${seqRange[1]}`;
    const turns = tracks.map((track, idx) => ({
      turn_id: `${SESSION_ID}-edge-${seqRange[0]}-${seqRange[1]}-${Math.round(track.start_ms)}-${idx + 1}`,
      start_ms: sessionWindowStartMs + Math.max(0, track.start_ms - windowWallStart),
      end_ms: sessionWindowStartMs + Math.max(0, track.end_ms - windowWallStart),
      stream_role: 'students',
      cluster_id: `edge_${windowTag}_${String(track.speaker_id || idx + 1)}`,
    }));

    // Collect segments for enrollment simulation (session-relative times)
    for (const turn of turns) {
      collectedSegments.push({
        start_ms: turn.start_ms,
        end_ms: turn.end_ms,
        duration_ms: turn.end_ms - turn.start_ms,
        speaker_id: String(tracks.find(t =>
          turn.cluster_id.endsWith(`_${String(t.speaker_id)}`)
        )?.speaker_id || 'unknown'),
        window_tag: windowTag,
      });
    }

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

    const logResp = await httpJson(`/v1/sessions/${SESSION_ID}/speaker-logs`, {
      method: 'POST',
      body: JSON.stringify({
        source: 'edge',
        window: windowPayload.window,
        start_end_ms: windowPayload.start_end_ms,
        turns,
        clusters,
        speaker_map: [],
      }),
    });
    if (logResp.status < 400) speakerLogUploads++;
  }

  console.log(`  Windows processed: ${windowCount}`);
  console.log(`  Speaker-log uploads: ${speakerLogUploads}`);
  if (diarizeFails > 0) {
    console.warn(`  Diarize failures (after retries): ${diarizeFails}/${windowCount}`);
  }
  console.log(`  Segments collected for enrollment: ${collectedSegments.length}`);
}

// ── Step 2c: Simulate enrollment using diarization segments ──

async function simulateEnrollment() {
  if (!USE_EDGE_DIARIZATION) return;
  if (collectedSegments.length === 0) {
    console.log('\n=== Step 2c: Skipping enrollment (no diarization segments) ===');
    return;
  }
  console.log('\n=== Step 2c: Simulate enrollment via inference embeddings ===');

  const pcmData = readFileSync(PCM_FILE);
  const bytesPerMs = 32; // 16000 Hz * 2 bytes/sample / 1000 ms

  // Strategy: Pick non-overlapping segments from different time regions
  // to maximize speaker diversity. Sort by duration, greedily select
  // segments that don't overlap with already-selected ones.
  const sorted = [...collectedSegments]
    .filter(s => s.duration_ms >= 1500) // min 1.5s for reliable embedding
    .sort((a, b) => b.duration_ms - a.duration_ms);

  const selected = [];
  for (const seg of sorted) {
    if (selected.length >= 4) break;
    // Check no overlap with already selected
    const overlaps = selected.some(s =>
      seg.start_ms < s.end_ms && seg.end_ms > s.start_ms
    );
    if (overlaps) continue;
    selected.push(seg);
  }

  if (selected.length === 0) {
    console.log('  No suitable segments found for enrollment');
    return;
  }

  // Sort selected by start_ms for consistent participant mapping
  selected.sort((a, b) => a.start_ms - b.start_ms);

  const participantNames = PARTICIPANTS.map(p => typeof p === 'string' ? p : p.name);
  const profiles = [];

  for (let i = 0; i < selected.length; i++) {
    const seg = selected[i];
    const name = participantNames[i % participantNames.length];
    const startByte = Math.max(0, Math.floor(seg.start_ms * bytesPerMs));
    const endByte = Math.min(pcmData.length, Math.floor(seg.end_ms * bytesPerMs));

    if (endByte - startByte < 3200) continue; // skip if < 100ms of audio

    const audioSlice = pcmData.subarray(startByte, endByte);
    const durationSec = ((seg.end_ms - seg.start_ms) / 1000).toFixed(1);
    console.log(`  Enrolling ${name}: ${durationSec}s audio from ${seg.start_ms}-${seg.end_ms}ms`);

    try {
      const enrollResp = await fetch(`${INFERENCE_URL}/speaker/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INFERENCE_API_KEY },
        body: JSON.stringify({
          session_id: SESSION_ID,
          participant_name: name,
          audio: {
            content_b64: audioSlice.toString('base64'),
            format: 'pcm_s16le',
            sample_rate: 16000,
            channels: 1,
          },
          state: { participant_profiles: profiles },
        }),
      });

      if (!enrollResp.ok) {
        const errBody = await enrollResp.text().catch(() => '');
        console.error(`  Enroll failed for ${name}: ${enrollResp.status} ${errBody.slice(0, 200)}`);
        continue;
      }

      const enrollData = await enrollResp.json();
      const updatedProfiles = enrollData.updated_state?.participant_profiles || [];
      const profile = updatedProfiles.find(p => p.name === name);
      if (profile?.centroid?.length > 0) {
        profiles.push({
          name: profile.name,
          centroid: profile.centroid,
          sample_count: profile.sample_count || 1,
          sample_seconds: profile.sample_seconds || parseFloat(durationSec),
        });
        console.log(`  ✓ ${name}: embedding dim=${profile.centroid.length}, ${profile.sample_seconds?.toFixed(1)}s speech`);
      } else {
        console.warn(`  ✗ ${name}: no centroid returned`);
      }
    } catch (err) {
      console.error(`  Enroll error for ${name}: ${err.message}`);
    }
  }

  if (profiles.length === 0) {
    console.log('  No enrollment profiles created');
    return;
  }

  // Inject profiles into worker via enrollment/profiles endpoint
  const injectResp = await httpJson(`/v1/sessions/${SESSION_ID}/enrollment/profiles`, {
    method: 'POST',
    body: JSON.stringify({ participant_profiles: profiles }),
  });
  console.log(`  Injected ${profiles.length} profiles into worker: status=${injectResp.status}`);
  if (injectResp.data?.enrollment_state) {
    const es = injectResp.data.enrollment_state;
    console.log(`  Enrollment mode: ${es.mode}, participants: ${Object.keys(es.participants || {}).join(', ')}`);
  }
}

// ── Step 3: Send memos via POST /memos API ──

async function sendMemos() {
  console.log('\n=== Step 3: Send memos via POST /memos API ===');

  let sent = 0;
  for (const memo of MEMOS) {
    const res = await httpJson(`/v1/sessions/${SESSION_ID}/memos`, {
      method: 'POST',
      body: JSON.stringify(memo),
    });
    if (res.status >= 400) {
      console.error(`  Failed to send memo: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    } else {
      sent++;
    }
  }
  console.log(`  Sent ${sent}/${MEMOS.length} memos`);
}

// ── Step 4: Trigger finalization ──

async function triggerFinalize() {
  console.log('\n=== Step 4: Trigger finalization ===');

  const metadata = {
    free_form_notes: FREE_FORM_NOTES,
    stages: STAGES,
    participants: PARTICIPANTS,
  };

  const res = await httpJson(`/v1/sessions/${SESSION_ID}/finalize?version=v2`, {
    method: 'POST',
    body: JSON.stringify({ metadata }),
  });
  console.log(`  Status: ${res.status}`);
  console.log(`  Response: ${JSON.stringify(res.data).slice(0, 300)}`);
  if (res.status >= 400) throw new Error(`Finalize failed: ${res.status}`);
  return res.data;
}

// ── Step 5: Poll finalization status ──

async function pollStatus() {
  console.log('\n=== Step 5: Poll finalization status ===');

  const maxWait = 2_400_000;  // 40 min for local-whisper ASR processing
  const interval = 5000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const res = await httpJson(`/v1/sessions/${SESSION_ID}/finalize/status`);
    const status = res.data?.status;
    const stage = res.data?.current_stage || res.data?.stage;
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);

    console.log(`  [${elapsed}s] status=${status} stage=${stage}`);

    if (status === 'succeeded' || status === 'completed') {
      console.log('  Finalization succeeded!');
      return;
    }
    if (status === 'failed') {
      console.error(`  Finalization FAILED: ${JSON.stringify(res.data)}`);
      throw new Error(`Finalization failed: ${JSON.stringify(res.data)}`);
    }

    await sleep(interval);
  }

  throw new Error('Finalization timed out after 40 minutes');
}

// ── Step 6: Get result & analyze ──

async function getResult() {
  console.log('\n=== Step 6: Get result ===');

  const res = await httpJson(`/v1/sessions/${SESSION_ID}/result?version=v2`);
  console.log(`  Status: ${res.status}`);

  if (res.status >= 400) {
    console.error(`  Failed to get result: ${JSON.stringify(res.data).slice(0, 500)}`);
    throw new Error('Get result failed');
  }

  const result = res.data;

  // ── Analyze result ──
  console.log('\n=== RESULT ANALYSIS ===\n');

  // Memos
  const memos = result.memos || [];
  console.log(`Memos in result: ${memos.length}`);

  // Evidence
  const evidence = result.evidence || [];
  console.log(`Evidence items: ${evidence.length}`);
  evidence.slice(0, 10).forEach(e => {
    const speaker = e.speaker?.display_name || e.speaker?.person_id || e.speaker?.cluster_id || '?';
    console.log(`  [${e.evidence_id}] ${speaker}: "${e.quote?.slice(0, 80)}..." (conf=${e.confidence})`);
  });

  // Stats / Speaker diarization
  const stats = result.stats || [];
  console.log(`\nSpeaker Stats: ${stats.length} speakers`);
  stats.forEach(s => {
    const talkSec = ((s.talk_time_ms || 0) / 1000).toFixed(0);
    console.log(`  ${s.speaker_name || s.speaker_key}: ${talkSec}s talk, ${s.turns} turns`);
  });

  // Transcript summary
  const transcript = result.transcript || [];
  console.log(`\nTranscript: ${transcript.length} utterances`);
  const speakerCounts = {};
  transcript.forEach(u => {
    const name = u.speaker_name || u.cluster_id || 'unknown';
    speakerCounts[name] = (speakerCounts[name] || 0) + 1;
  });
  Object.entries(speakerCounts).forEach(([name, count]) => {
    console.log(`  ${name}: ${count} utterances`);
  });
  // Show first 5 utterances
  transcript.slice(0, 5).forEach(u => {
    const name = u.speaker_name || u.cluster_id || '?';
    console.log(`  [${u.utterance_id}] ${name}: "${u.text?.slice(0, 60)}..." (${u.start_ms}-${u.end_ms}ms)`);
  });

  // Per-person feedback
  const perPerson = result.per_person || [];
  console.log(`\nPer-Person Feedback: ${perPerson.length} persons`);
  perPerson.forEach(p => {
    console.log(`\n  ── ${p.display_name || p.person_key} ──`);
    (p.dimensions || []).forEach(d => {
      const s = d.strengths?.length || 0;
      const r = d.risks?.length || 0;
      const a = d.actions?.length || 0;
      console.log(`    ${d.dimension}: ${s}S ${r}R ${a}A`);
      d.strengths?.forEach(c => console.log(`      [S] ${c.text?.slice(0, 100)}... (conf=${c.confidence})`));
      d.risks?.forEach(c => console.log(`      [R] ${c.text?.slice(0, 100)}... (conf=${c.confidence})`));
      d.actions?.forEach(c => console.log(`      [A] ${c.text?.slice(0, 100)}... (conf=${c.confidence})`));
    });
  });

  // Overall
  const overall = result.overall;
  if (overall?.summary_sections) {
    console.log('\nOverall Summary:');
    overall.summary_sections.forEach(s => {
      console.log(`  ${s.topic}:`);
      s.bullets?.forEach(b => console.log(`    - ${b.slice(0, 120)}`));
    });
  }
  if (overall?.teacher_memos) {
    console.log('\n  Teacher Memos:');
    overall.teacher_memos.forEach(m => console.log(`    - ${m.slice(0, 120)}`));
  }

  // Quality
  const quality = result.quality;
  if (quality) {
    console.log(`\nQuality: source=${quality.report_source}, model=${quality.report_model}, degraded=${quality.report_degraded}`);
    console.log(`  Claims: ${quality.claim_count} total, ${quality.invalid_claim_count} invalid`);
    console.log(`  Build: ${quality.build_ms}ms`);
    if (quality.warnings?.length) {
      quality.warnings.forEach(w => console.log(`  WARN: ${w}`));
    }
  }

  return result;
}

// ── Main ──

async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║  E2E Group Interview Backend Test (v2)    ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`Session: ${SESSION_ID}`);
  console.log(`Participants: ${PARTICIPANTS.map(p => typeof p === 'string' ? p : `${p.name}(${p.aliases?.join('/')})`).join(', ')}`);
  console.log(`Audio: ${PCM_FILE}`);
  console.log(`Memos: ${MEMOS.length}`);
  console.log(`Edge Diarization: ${USE_EDGE_DIARIZATION ? `ON (${SIDECAR_URL})` : 'OFF'}`);

  try {
    await configureSession();          // Step 1: Set mode, roster, stages, free_form_notes
    await startEnrollment();           // Step 1b: Set enrollment mode to "collecting"
    await streamAudio();               // Step 2: Stream PCM audio via WebSocket
    await runEdgeDiarization();        // Step 2b: Edge diarization (if --edge-diarization)
    await simulateEnrollment();        // Step 2c: Simulate enrollment from diarization segments
    await sendMemos();                 // Step 3: Send memos via POST /memos API
    await triggerFinalize();           // Step 4: Trigger finalization pipeline
    await pollStatus();                // Step 5: Poll until complete
    const result = await getResult();  // Step 6: Fetch & analyze result

    // Save full result
    const { writeFileSync } = await import('fs');
    const outPath = `/tmp/e2e_result_${SESSION_ID}.json`;
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\nFull result saved to: ${outPath}`);

    console.log('\n✅ E2E TEST PASSED');
  } catch (err) {
    console.error(`\n❌ E2E TEST FAILED: ${err.message}`);
    process.exit(1);
  }
}

main();
