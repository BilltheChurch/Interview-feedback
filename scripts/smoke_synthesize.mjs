#!/usr/bin/env node
/**
 * Smoke test: POST /analysis/synthesize
 * Requires inference service running at localhost:8000
 *
 * Usage: node scripts/smoke_synthesize.mjs [--base-url http://localhost:8000]
 */

const args = process.argv.slice(2);
const baseUrlIdx = args.indexOf("--base-url");
const BASE_URL = baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : "http://localhost:8000";

async function main() {
  console.log(`[smoke] Testing POST ${BASE_URL}/analysis/synthesize`);

  const payload = {
    session_id: "smoke-synth-001",
    transcript: [
      {
        utterance_id: "u1",
        stream_role: "students",
        speaker_name: "Alice",
        cluster_id: "c1",
        text: "I would approach this system design by first identifying the key requirements and constraints.",
        start_ms: 0,
        end_ms: 5000,
        duration_ms: 5000,
        decision: "auto",
      },
      {
        utterance_id: "u2",
        stream_role: "teacher",
        speaker_name: "Interviewer",
        text: "Can you elaborate on the scalability aspect?",
        start_ms: 5500,
        end_ms: 8000,
        duration_ms: 2500,
        decision: "auto",
      },
    ],
    memos: [
      {
        memo_id: "m1",
        created_at_ms: 3000,
        author_role: "teacher",
        type: "observation",
        tags: ["structure"],
        text: "Alice shows clear structured thinking in system design approach",
        stage: "Q1: System Design",
        stage_index: 1,
      },
    ],
    evidence: [
      {
        evidence_id: "e_000001",
        time_range_ms: [0, 5000],
        utterance_ids: ["u1"],
        speaker_key: "Alice",
        quote: "I would approach this system design by first identifying the key requirements.",
        confidence: 0.85,
      },
    ],
    stats: [
      { speaker_key: "Alice", speaker_name: "Alice", talk_time_ms: 5000, turns: 1 },
      { speaker_key: "Interviewer", speaker_name: "Interviewer", talk_time_ms: 2500, turns: 1 },
    ],
    events: [],
    stages: ["Intro", "Q1: System Design"],
    locale: "zh-CN",
  };

  const headers = { "Content-Type": "application/json" };
  // Add API key if environment variable is set
  if (process.env.INFERENCE_API_KEY) {
    headers["x-api-key"] = process.env.INFERENCE_API_KEY;
  }

  try {
    const response = await fetch(`${BASE_URL}/analysis/synthesize`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const status = response.status;
    const body = await response.json();

    console.log(`[smoke] Status: ${status}`);

    if (status !== 200) {
      console.error(`[smoke] FAIL — expected 200, got ${status}`);
      console.error(JSON.stringify(body, null, 2));
      process.exit(1);
    }

    // Validate response shape
    const checks = [
      ["session_id", body.session_id === "smoke-synth-001"],
      ["has per_person", Array.isArray(body.per_person) && body.per_person.length > 0],
      ["has overall", typeof body.overall === "object"],
      ["has quality", typeof body.quality === "object"],
      ["report_source", body.quality?.report_source?.startsWith("llm_") || body.quality?.report_source === "memo_first_fallback"],
    ];

    let allPass = true;
    for (const [name, passed] of checks) {
      const icon = passed ? "PASS" : "FAIL";
      console.log(`  [${icon}] ${name}`);
      if (!passed) allPass = false;
    }

    if (body.per_person?.[0]) {
      const dims = body.per_person[0].dimensions?.length ?? 0;
      console.log(`  [INFO] Person: ${body.per_person[0].display_name}, Dimensions: ${dims}`);
    }

    if (body.quality) {
      console.log(`  [INFO] Source: ${body.quality.report_source}, Build: ${body.quality.build_ms}ms, Claims: ${body.quality.claim_count}`);
    }

    process.exit(allPass ? 0 : 1);
  } catch (err) {
    console.error(`[smoke] Network error: ${err.message}`);
    process.exit(1);
  }
}

main();
