# Desktop (Phase 2.3 Capture Reliability)

This Electron app implements the Phase 1 local self-check path from the project docs:

- dual capture: microphone + system audio
- local recording
- strict normalization to `16kHz / mono / pcm_s16le`
- metadata validation by `ffprobe`
- live dual WebSocket upload in 1-second `pcm_s16le` chunks
- session config + live transcript/events view for Phase 2.3
- automatic system-audio recovery state machine (no global upload stop on single-stream failure)
- default mic AEC + dual-stream echo suppression for no-headset scenarios

## Install

```bash
cd /Users/billthechurch/Interview-feedback/desktop
npm install
```

## Run UI

```bash
npm run dev
```

UI checklist:
1. Click `Init Mic`.
2. Click `Init System Audio`.
3. Confirm all 3 meters are moving: `Mic level`, `System level`, `Mixed level`.
4. Click `Start Upload` to open two WS connections:
   - `wss://api.frontierace.ai/v1/audio/ws/<meeting_id>/teacher` (mic)
   - `wss://api.frontierace.ai/v1/audio/ws/<meeting_id>/students` (system)
5. Observe `ack/missing/last_seq` status in the panel.
6. Optionally run `Start 30s Recording` and validate the normalized WAV.
7. Fill `Session Config`:
   - `Interviewer Name`
   - `Participants` list (`Add Participant` / `Import Names`)
   - Optional `Advanced -> Teams Interviewer Name`
8. Confirm mic processing defaults in `Advanced`:
   - `Echo Cancellation` = ON
   - `Noise Suppression` = ON
   - `Auto Gain Control` = OFF
9. Click `Save Session Config`.
10. Use `Refresh Live View` or rely on 2s auto-polling during upload to inspect:
   - `Live Transcript` (`teacher/students`, `raw/merged`)
   - `Speaker Events` (`identity_source`)
   - capture metrics from `state.capture_by_stream`

Runtime rules:
- If `students` system track ends or stalls, client enters `recovering` and auto-retries `1s -> 2s -> 5s` with source lock.
- During recovery, `teacher` stream continues uploading; students stream resumes after recovery.
- If recovery fails continuously, state becomes `failed` and UI prompts manual `Init System Audio`.
- If local 30s recording is running and one track ends, recording auto-stops for data consistency.
- Each stream has independent resume (`last_seq`) and ACK stats.
- Teacher echo leakage suppression is applied chunk-by-chunk using correlation and energy thresholds.

## Smoke Normalize Existing Files

```bash
npm run normalize:smoke
```

You can also pass explicit input files:

```bash
node scripts/normalize_smoke.js /absolute/path/to/alice.m4a /absolute/path/to/bob.m4a
```
