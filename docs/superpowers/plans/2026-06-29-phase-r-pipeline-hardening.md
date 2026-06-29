# Phase R — Cloud Pipeline Hardening Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the all-cloud realtime pipeline bulletproof for real complex group interviews — dual-stream (interviewer mic + students system audio), 3–6 speakers, 30–60 min continuous tracking — and validate the untested live scenarios.

**Architecture:** Cloudflare Worker (Durable Object + R2 + D1) + Electron desktop. Desktop captures two audio streams (mic = interviewer/teacher, system-audio loopback = students) and opens two ingest WebSockets to the Worker DO. The DO opens one outbound Speechmatics realtime WS per stream (teacher: diarization off; students: diarization on → S-labels). Finalize reconciles both streams into one report (qwen3.7-plus in-Worker). This phase hardens the realtime path (keepalive, reconnect, backpressure, max_speakers) and the dual-stream merge, then gates on real live-meeting validation.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, Speechmatics realtime WS, vitest (worker 534 tests green), Electron + React (desktop).

**Design doc:** `docs/plans/2026-06-29-cloud-pipeline-hardening-roadmap-design.md` (Phase R section).

**Out of scope (do NOT touch):** Tier2 (Phase Q), B3 preferred-name (Phase Q), UI/UX (Phase X).

---

## File Structure

- `edge/worker/src/speechmatics-asr.ts` — add `maxSpeakers` to `SpeechmaticsConfig` + `buildStartRecognition` (`speaker_diarization_config.max_speakers`).
- `edge/worker/src/config.ts` — `Env.ASR_MAX_SPEAKERS`, `Env.ASR_KEEPALIVE_MS`; resolver helpers.
- `edge/worker/src/realtime-asr-processor.ts` — silence keepalive scheduling; backpressure (AudioAdded/seq_no) accounting; reconnect/replay already present — add regression coverage.
- `edge/worker/src/asr-helpers.ts` — `AsrRealtimeRuntime` keepalive/backpressure fields (init).
- `edge/worker/src/finalize-orchestrator.ts` / `reconcile.ts` — confirm teacher (interviewer) utterances are EXCLUDED from per-person student stats/scoring but PASSED to the LLM as question context.
- `edge/worker/wrangler.jsonc` — `ASR_MAX_SPEAKERS`, `ASR_KEEPALIVE_MS` vars.
- `edge/worker/tests/*.test.ts` — new unit tests per task.
- `desktop/src/services/WebSocketService.ts`, `AudioService.ts` — VERIFY both teacher+students streams connect + auth + stream concurrently (read first; add only if missing).
- `desktop/e2e_dual_stream_test.mjs` (new) — dual-stream live harness (teacher + students WS together).

> **First action for the implementer:** read `realtime-asr-processor.ts`, `websocket-handler.ts`, `speechmatics-asr.ts`, and `desktop/src/services/WebSocketService.ts` to confirm current behavior before each task. The §9.x references are in the design baseline `docs/plans/2026-06-27-cloud-companion-speechmatics-architecture.md`.

---

## Chunk 1: Speechmatics max_speakers

### Task 1: Configurable max_speakers for students diarization

**Files:**
- Modify: `edge/worker/src/speechmatics-asr.ts` (`SpeechmaticsConfig`, `buildStartRecognition`)
- Modify: `edge/worker/src/config.ts` (`Env`, add `resolveMaxSpeakers`)
- Modify: `edge/worker/wrangler.jsonc` (`ASR_MAX_SPEAKERS`)
- Test: `edge/worker/tests/speechmatics-config.test.ts`

- [ ] **Step 1: Write failing test** — `buildStartRecognition` with `maxSpeakers: 6` and `diarization: true` produces `transcription_config.speaker_diarization_config.max_speakers === 6`; with `maxSpeakers` undefined, no `speaker_diarization_config` key; with `diarization: false`, never emits speaker config.

- [ ] **Step 2: Run → FAIL** (`maxSpeakers` not on type). `cd edge/worker && npx vitest run tests/speechmatics-config.test.ts`

- [ ] **Step 3: Implement** — add `maxSpeakers?: number` to `SpeechmaticsConfig`; in `buildStartRecognition`, when `cfg.diarization && cfg.maxSpeakers`, set `transcription_config.speaker_diarization_config = { max_speakers: cfg.maxSpeakers }`. Add `Env.ASR_MAX_SPEAKERS?: string` + `resolveMaxSpeakers(env)` (parse int, undefined if unset/invalid — let Speechmatics auto-detect). Wire the resolver where the students Speechmatics config is built (find the `DEFAULT_SPEECHMATICS_CONFIG` consumer in `realtime-asr-processor.ts`).
  > Verify the exact Speechmatics param against docs (Context7 `speechmatics` or https://docs.speechmatics.com). `speaker_diarization_config.max_speakers` is the realtime field as of writing; confirm before shipping.

- [ ] **Step 4: Run → PASS**. Also `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(worker): configurable Speechmatics max_speakers for students diarization`

---

## Chunk 2: Silence keepalive (§9.3.6)

> Problem: during the "read the question" phase everyone is silent; with no audio frames the outbound Speechmatics WS / ingest WS can idle out, dropping the session mid-interview. Keepalive sends silence/keepalive frames so both stay alive without spawning phantom speakers.

### Task 2: Keepalive scheduler for idle realtime streams

**Files:**
- Modify: `edge/worker/src/asr-helpers.ts` (`AsrRealtimeRuntime`: `lastAudioSentAt`, `keepaliveTimer` — or a pure "is keepalive due" helper to stay timer-free/testable)
- Modify: `edge/worker/src/realtime-asr-processor.ts` (send keepalive PCM-silence frame when idle > `ASR_KEEPALIVE_MS`)
- Modify: `edge/worker/src/config.ts` (`Env.ASR_KEEPALIVE_MS`, default e.g. 5000)
- Test: `edge/worker/tests/asr-keepalive.test.ts`

- [ ] **Step 1: Write failing test** — a pure helper `keepaliveDueAt(lastAudioMs, nowMs, intervalMs)` / `shouldSendKeepalive(...)`: returns true when `now - lastAudio >= interval`, false otherwise; never true if a real frame was just sent. (Keep the decision logic pure + unit-tested; the timer/DO-alarm wiring is integration, validated live.)

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** the pure helper + wire it: on each ingest chunk update `lastAudioSentAt`; on a DO alarm / interval check, if `shouldSendKeepalive`, send a short silence frame (or Speechmatics no-op) to the outbound WS. Reuse existing silence-PCM helpers if present.

- [ ] **Step 4: Run → PASS** + typecheck.

- [ ] **Step 5: Commit** — `feat(worker): silence keepalive for idle realtime ASR streams`

---

## Chunk 3: Backpressure accounting (§9.3.8)

> Speechmatics acks each audio frame with `AudioAdded{seq_no}`. Track sent-vs-acked to detect lag and avoid unbounded send-ahead on slow links.

### Task 3: AudioAdded/seq_no backpressure window

**Files:**
- Modify: `edge/worker/src/speechmatics-asr.ts` (parse `AudioAdded` seq_no if not already surfaced by `parseSpeechmaticsMessage`)
- Modify: `edge/worker/src/realtime-asr-processor.ts` (track `lastAckedSeq`; expose lag; pause/throttle send when `sentSeq - ackedSeq` exceeds a window)
- Modify: `edge/worker/src/asr-helpers.ts` (`AsrRealtimeRuntime.lastAckedSeq`)
- Test: `edge/worker/tests/asr-backpressure.test.ts`

- [ ] **Step 1: Write failing test** — pure helper `backpressureLag(sentSeq, ackedSeq)` + `shouldThrottle(lag, windowSize)`; AudioAdded parsing returns `{ type: "AudioAdded", seq_no }`.

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** — surface `AudioAdded` in `parseSpeechmaticsMessage` (return `{type:"AudioAdded", seqNo}`); in `handleSpeechmaticsMessage`, update `runtime.lastAckedSeq`; expose lag in ASR metrics; throttle the send loop when over window.

- [ ] **Step 4: Run → PASS** + typecheck.

- [ ] **Step 5: Commit** — `feat(worker): Speechmatics backpressure via AudioAdded seq tracking`

---

## Chunk 4: Dual-stream interviewer handling

> Confirm + lock the contract: interviewer (teacher/mic) utterances give the LLM question context but are NOT scored as a student.

### Task 4: Interviewer excluded from student scoring, kept as context

**Files:**
- Read: `edge/worker/src/finalize_v2.ts` (`computeSpeakerStats`, per-person build), `reconcile.ts`, `finalize-orchestrator.ts` (report payload build)
- Modify: as needed so `stream_role === "teacher"` utterances are excluded from per-person student stats/scoring but included in the transcript/context passed to `synthesizeReportInWorker`.
- Test: `edge/worker/tests/dual-stream-report.test.ts`

- [ ] **Step 1: Write failing test** — given a mixed transcript (teacher utterances + students S1/S2), `computeSpeakerStats`/per-person output contains ONLY students (no "Interviewer" person card), AND the synthesis payload transcript still contains the teacher lines (as context). Assert on the actual functions.

- [ ] **Step 2: Run → FAIL** (if teacher currently leaks into per-person) or PASS (if already correct — then this becomes a regression lock).

- [ ] **Step 3: Implement** only if Step 2 fails — filter teacher from per-person/stats; ensure synthesis payload keeps teacher lines labelled as interviewer/context.

- [ ] **Step 4: Run → PASS** + typecheck.

- [ ] **Step 5: Commit** — `test(worker): lock interviewer-as-context, not-scored contract (or fix if leaking)`

### Task 5: Dual-stream live harness

**Files:**
- Create: `desktop/e2e_dual_stream_test.mjs` (based on `e2e_group_interview_test.mjs`; opens BOTH `…/teacher` and `…/students` ingest WS, first-frame auth on each, streams a teacher PCM + a students PCM concurrently at `--chunk-delay`)
- Read first: `desktop/src/services/WebSocketService.ts`, `AudioService.ts` — confirm the real app already connects both streams; note gaps.

- [ ] **Step 1:** Read WebSocketService/AudioService; document whether both streams connect+auth+stream concurrently in the real app. If a gap exists, add a follow-up task here.
- [ ] **Step 2:** Build the dual-stream harness (two WS, two PCM inputs).
- [ ] **Step 3:** Smoke it against a LOCAL `wrangler dev` first (cheap), confirming both streams reach finalize and the report has students-only per-person + interviewer context.
- [ ] **Step 4: Commit** — `test(e2e): dual-stream (teacher+students) live harness`

---

## Chunk 5: Live validation gates (user-run — NOT auto-testable)

> These need real audio / real meetings; the user runs them. Each gate has a pass criterion. Record results in `Task.md` §最新验证记录.

- [ ] **Gate R1 — dual-stream real audio:** run `e2e_dual_stream_test.mjs` against prod with a real interviewer-mic PCM + the students recording (e.g. Qingnian Road). PASS = report attributes student turns to named students, interviewer turns appear as context only (no interviewer person-card), report quality high.
- [ ] **Gate R2 — complex multi-person:** real 5–6 person group recording. PASS = diarization yields ~N distinct S-labels, B3 binds names, no major speaker bleed.
- [ ] **Gate R3 — long-meeting continuous track:** a 30–60 min real session (or long recording) streamed at realtime. PASS = no WS drop, no lost segments across silence gaps (keepalive holds), reconnect (if any) recovers via R2 replay.
- [ ] **Gate R4 — timing budget:** measure finalize wall-time for a 30–60 min interview. PASS = Tier1 report acceptable latency; headroom confirmed for Tier2 ≤5min (Phase Q).
- [ ] **Gate R5 — concurrency/cost:** check Speechmatics portal for realtime concurrent quota + per-minute price (2 streams/session). Record numbers.

> **Runbook for the user** (each gate): convert audio with `ffmpeg -i in.<ext> -ar 16000 -ac 1 -f s16le out.pcm`; run the harness with `--base-http https://api.frontierace.ai --base-ws wss://api.frontierace.ai --chunk-delay 1000` (realtime). For dual-stream, supply both `--audio-teacher` and `--audio-students`.

---

## Notes for the implementer
- Keep all decision logic (keepalive-due, backpressure-lag, max_speakers-resolve, teacher-filter) as PURE functions so they're unit-testable; the DO/WS/timer wiring is integration validated by the live gates.
- DashScope rollback: `enable_thinking:false` already set; if qwen3.7-plus latency grows on long transcripts, the truncation budget `TRANSCRIPT_MAX_TOKENS` (llm-synthesizer.ts) is the knob — do not re-enable thinking.
- After code chunks land + green tests, deploy (`cd edge/worker && npx wrangler deploy`) before running the live gates, and keep `feat/phase6-cloud-companion` synced to `main`.
