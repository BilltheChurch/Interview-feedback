#!/usr/bin/env node
/**
 * Smoke test: Caption session lifecycle
 * Creates a session → sends caption events → finalizes → checks result
 *
 * Usage: node scripts/smoke_caption_session.mjs
 */

const BASE_HTTP = process.env.BASE_HTTP || 'http://127.0.0.1:8787';
const BASE_WS = process.env.BASE_WS || 'ws://127.0.0.1:8787';
const API_KEY = process.env.WORKER_API_KEY || 'dev-key';

const sessionId = `smoke-caption-${Date.now()}`;
const headers = { 'content-type': 'application/json', 'x-api-key': API_KEY };

async function post(path, body) {
  const res = await fetch(`${BASE_HTTP}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function get(path) {
  const res = await fetch(`${BASE_HTTP}${path}`, { headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`\n=== Caption Session Smoke Test ===`);
  console.log(`Session ID: ${sessionId}`);
  console.log(`Worker: ${BASE_HTTP}\n`);

  // Step 1: Create session via config endpoint
  console.log('Step 1: Create session config...');
  const configRes = await post(`/v1/sessions/${sessionId}/config`, {
    mode: '1v1',
    interviewer_name: 'Tim',
    position_title: 'Test Position',
    stages: ['intro', 'questions'],
  });
  console.log(`  Config: ${configRes.status}`, typeof configRes.data === 'object' ? '' : configRes.data);

  // Step 2: Connect WebSocket and send caption events
  console.log('\nStep 2: Connect WebSocket + send captions...');
  const { default: WebSocket } = await import('ws');
  const ws = await new Promise((resolve, reject) => {
    const url = `${BASE_WS}/v1/audio/ws/${sessionId}/teacher`;
    const w = new WebSocket(url, { headers: { 'x-api-key': API_KEY } });
    w.on('open', () => resolve(w));
    w.on('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 5000);
  });
  console.log('  WebSocket connected');

  // Send hello to initialize sessionStartMs
  ws.send(JSON.stringify({ type: 'hello', stream_role: 'teacher' }));
  console.log('  Sent hello { stream_role: "teacher" }');
  await sleep(300);

  // Send session_config with captionSource
  ws.send(JSON.stringify({ type: 'session_config', captionSource: 'acs-teams' }));
  console.log('  Sent session_config { captionSource: "acs-teams" }');
  await sleep(500);

  // Send caption events (must match Worker's expected format: resultType="Final", speaker, text, timestamp, language)
  const sessionStartMs = Date.now();
  const captions = [
    { speaker: 'Tim', text: '好，我们开始吧。首先请你自我介绍一下。', offsetMs: 0 },
    { speaker: '魏一心', text: '好的，我叫魏一心，目前在申请帝国理工的BTv项目。', offsetMs: 5500 },
    { speaker: 'Tim', text: '很好，那你为什么选择这个专业呢？', offsetMs: 13000 },
    { speaker: '魏一心', text: '我对生物技术和商业的交叉领域很感兴趣，特别是在药物研发方面。', offsetMs: 18000 },
    { speaker: 'Tim', text: '那你能举一个具体的例子吗？', offsetMs: 26000 },
    { speaker: '魏一心', text: '我曾经做过一个用数学模型优化代餐配方的项目。', offsetMs: 30000 },
    { speaker: 'Tim', text: '非常有趣。你在这个项目中学到了什么？', offsetMs: 37000 },
    { speaker: '魏一心', text: '我学到了如何将抽象的数学工具应用于实际的产品开发场景。', offsetMs: 43000 },
  ];

  for (const c of captions) {
    ws.send(JSON.stringify({
      type: 'caption',
      resultType: 'Final',
      speaker: c.speaker,
      text: c.text,
      timestamp: sessionStartMs + c.offsetMs,
      language: 'zh-CN',
    }));
  }
  console.log(`  Sent ${captions.length} caption events`);
  await sleep(1000);

  // Close WebSocket
  ws.close();
  console.log('  WebSocket closed');
  await sleep(1000);

  // Step 3: Check DO storage state
  console.log('\nStep 3: Check session state...');
  const stateRes = await get(`/v1/sessions/${sessionId}/state`);
  console.log(`  State: ${stateRes.status}`);
  if (stateRes.data) {
    const state = stateRes.data;
    console.log(`  caption_source in state: ${state.caption_source || state.captionSource || 'NOT FOUND'}`);
  }

  // Step 4: Finalize (full mode first)
  console.log('\nStep 4: Finalize (mode=full)...');
  const finalizeRes = await post(`/v1/sessions/${sessionId}/finalize?version=v2`, {
    metadata: {},
    mode: 'full'
  });
  console.log(`  Finalize: ${finalizeRes.status}`);
  if (finalizeRes.data?.job_id) {
    console.log(`  Job ID: ${finalizeRes.data.job_id}`);
  } else {
    console.log(`  Response:`, JSON.stringify(finalizeRes.data).slice(0, 200));
  }

  // Step 5: Poll finalization status
  console.log('\nStep 5: Poll finalization status...');
  let attempts = 0;
  let lastStatus = null;
  while (attempts < 60) { // max 2 min
    await sleep(2000);
    const statusRes = await get(`/v1/sessions/${sessionId}/state`);
    const v2 = statusRes.data?.finalize_v2;
    if (v2) {
      if (v2.stage !== lastStatus?.stage || v2.progress !== lastStatus?.progress) {
        console.log(`  [${attempts * 2}s] stage=${v2.stage} progress=${v2.progress}% status=${v2.status}`);
        lastStatus = v2;
      }
      if (v2.status === 'succeeded' || v2.status === 'done') {
        console.log('  ✅ Finalization succeeded!');
        if (v2.warnings?.length) console.log(`  Warnings: ${v2.warnings.join(', ')}`);
        break;
      }
      if (v2.status === 'failed') {
        console.log(`  ❌ Finalization failed: ${v2.errors?.join(', ')}`);
        break;
      }
    }
    attempts++;
  }
  if (attempts >= 60) console.log('  ⏱ Timed out after 2 minutes');

  // Step 6: Open feedback and check result
  console.log('\nStep 6: Open feedback...');
  const feedbackRes = await post(`/v1/sessions/${sessionId}/feedback-open`, {});
  console.log(`  Feedback: ${feedbackRes.status}`);
  if (feedbackRes.data?.report) {
    const report = feedbackRes.data.report;
    console.log(`  ✅ Report exists!`);
    console.log(`    session.caption_source = ${report.session?.caption_source || 'NOT SET'}`);
    console.log(`    transcript.length = ${report.transcript?.length || 0}`);
    console.log(`    evidence.length = ${report.evidence?.length || 0}`);
    console.log(`    per_person.length = ${report.per_person?.length || 0}`);
    console.log(`    stats.length = ${report.stats?.length || 0}`);
    if (report.transcript?.length > 0) {
      console.log(`    First utterance: "${report.transcript[0].text?.slice(0, 60)}..."`);
      console.log(`    Last utterance: "${report.transcript[report.transcript.length - 1].text?.slice(0, 60)}..."`);
    }
    console.log(`    quality.report_source = ${report.quality?.report_source}`);
  } else {
    console.log(`  ❌ No report returned`);
    console.log(`    blocking_reason: ${feedbackRes.data?.blocking_reason}`);
    console.log(`    ready: ${feedbackRes.data?.ready}`);
  }

  // Step 7: Test report-only re-generate
  console.log('\nStep 7: Re-generate (mode=report-only)...');
  const regenRes = await post(`/v1/sessions/${sessionId}/finalize?version=v2`, {
    metadata: {},
    mode: 'report-only'
  });
  console.log(`  Re-generate: ${regenRes.status}`);

  if (regenRes.status === 200 || regenRes.status === 202) {
    // Poll again
    attempts = 0;
    lastStatus = null;
    while (attempts < 30) {
      await sleep(2000);
      const statusRes = await get(`/v1/sessions/${sessionId}/state`);
      const v2 = statusRes.data?.finalize_v2;
      if (v2) {
        if (v2.stage !== lastStatus?.stage || v2.progress !== lastStatus?.progress) {
          console.log(`  [${attempts * 2}s] stage=${v2.stage} progress=${v2.progress}% status=${v2.status}`);
          lastStatus = v2;
        }
        if (v2.status === 'succeeded' || v2.status === 'done') {
          console.log('  ✅ Report-only re-generate succeeded!');
          break;
        }
        if (v2.status === 'failed') {
          console.log(`  ❌ Report-only failed: ${v2.errors?.join(', ')}`);
          break;
        }
      }
      attempts++;
    }

    // Check result again
    const regenFeedback = await post(`/v1/sessions/${sessionId}/feedback-open`, {});
    if (regenFeedback.data?.report) {
      const r = regenFeedback.data.report;
      console.log(`  ✅ Re-generated report:`);
      console.log(`    session.caption_source = ${r.session?.caption_source || 'NOT SET'}`);
      console.log(`    transcript.length = ${r.transcript?.length || 0}`);
      console.log(`    quality.report_source = ${r.quality?.report_source}`);
    }
  } else {
    console.log(`  Response: ${JSON.stringify(regenRes.data).slice(0, 300)}`);
  }

  console.log('\n=== Smoke Test Complete ===\n');
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
