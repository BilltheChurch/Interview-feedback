#!/usr/bin/env node
/**
 * speechmatics_rt_validate.mjs — §9.6 gate validation for the Speechmatics realtime API.
 *
 * Proves the decisive D3+D4 assumption empirically (the official docs have no
 * "mode matrix", so this must be tested live): that cmn_en bilingual + realtime
 * diarization=speaker + 16kHz raw PCM work simultaneously and return per-word speaker labels.
 *
 * Usage:
 *   SM_KEY=<speechmatics_api_key> node scripts/speechmatics_rt_validate.mjs <pcm_file> <language> [label]
 *
 * Prepare a raw PCM sample (16k mono s16le) from any audio with ffmpeg:
 *   ffmpeg -y -i input.wav -ar 16000 -ac 1 -f s16le out.pcm
 *
 * Endpoint/protocol: wss://eu.rt.speechmatics.com/v2/ , Bearer auth, StartRecognition →
 * binary AddAudio → AddTranscript (results[].alternatives[0].speaker + word timestamps).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `ws` is a dev dependency of the edge worker; resolve it from there.
const require = createRequire(join(__dirname, '..', 'edge', 'worker', 'package.json'));
const WebSocket = require('ws');

const [, , pcmPath, language = 'cmn_en', label = 'validate'] = process.argv;
const KEY = process.env.SM_KEY;
if (!KEY || !pcmPath) {
  console.error('Usage: SM_KEY=<key> node scripts/speechmatics_rt_validate.mjs <pcm_file> <language> [label]');
  process.exit(1);
}

const ENDPOINT = process.env.SM_ENDPOINT || 'wss://eu.rt.speechmatics.com/v2/';
const SAMPLE_RATE = 16000;
const CHUNK_BYTES = 8000; // 0.25s of 16k mono s16le

const pcm = readFileSync(pcmPath);
const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } });

let seqNo = 0;
let started = false;
let done = false;
const speakers = new Set();
const wordSamples = [];
let recognitionStarted = null;
let errorMsg = null;

const hardTimeout = setTimeout(() => {
  console.log(JSON.stringify({ label, result: 'TIMEOUT', started, speakers: [...speakers] }, null, 2));
  process.exit(4);
}, 90_000);

ws.on('open', () => {
  ws.send(JSON.stringify({
    message: 'StartRecognition',
    audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
    transcription_config: { language, diarization: 'speaker', enable_partials: true, max_delay: 2.0 },
  }));
});

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  switch (msg.message) {
    case 'RecognitionStarted':
      recognitionStarted = msg; started = true; streamAudio(); break;
    case 'AddTranscript':
      for (const r of msg.results || []) {
        const alt = (r.alternatives || [])[0];
        if (alt?.speaker) speakers.add(alt.speaker);
        if (r.type === 'word' && wordSamples.length < 12) {
          wordSamples.push({ w: alt?.content, spk: alt?.speaker, t: [r.start_time, r.end_time] });
        }
      }
      break;
    case 'EndOfTranscript': finish(); break;
    case 'Error': errorMsg = msg; ws.close(); break;
    case 'Warning': console.error('WARNING', JSON.stringify(msg)); break;
  }
});

ws.on('close', (code, reason) => {
  if (done) return;
  clearTimeout(hardTimeout);
  console.log(JSON.stringify({ label, result: errorMsg ? 'ERROR' : 'CLOSED_EARLY', code, reason: reason?.toString(), started, error: errorMsg }, null, 2));
  process.exit(errorMsg ? 2 : 0);
});
ws.on('error', (e) => { console.error('WS_ERROR', e.message); process.exit(3); });

async function streamAudio() {
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(pcm.subarray(off, Math.min(off + CHUNK_BYTES, pcm.length)));
    seqNo++;
    await new Promise((r) => setTimeout(r, 50));
  }
  ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: seqNo }));
}

function finish() {
  done = true;
  clearTimeout(hardTimeout);
  console.log(JSON.stringify({
    label, language, result: 'OK',
    recognition_started: !!recognitionStarted,
    language_pack: recognitionStarted?.language_pack_info ?? null,
    speaker_count: speakers.size,
    speakers: [...speakers],
    word_samples: wordSamples,
  }, null, 2));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
