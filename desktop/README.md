# Desktop (Phase 1)

This Electron app implements the Phase 1 local self-check path from the project docs:

- dual capture: microphone + system audio
- local recording
- strict normalization to `16kHz / mono / pcm_s16le`
- metadata validation by `ffprobe`
- live dual WebSocket upload in 1-second `pcm_s16le` chunks
- session config + live transcript/events view for Phase 2.3

## Install

```bash
cd /Users/billthechurch/Interview-feedback/desktop
pnpm install
```

## Run UI

```bash
pnpm dev
```

UI checklist:
1. Click `Init Mic`.
2. Click `Init System Audio` and choose the active screen/window with system audio.
3. Confirm all 3 meters are moving: `Mic level`, `System level`, `Mixed level`.
4. Click `Start Upload` to open two WS connections:
   - `wss://api.frontierace.ai/v1/audio/ws/<meeting_id>/teacher` (mic)
   - `wss://api.frontierace.ai/v1/audio/ws/<meeting_id>/students` (system)
5. Observe `ack/missing/last_seq` status in the panel.
6. Optionally run `Start 30s Recording` and validate the normalized WAV.
7. Fill `Session Config` and click `Save Session Config`.
8. Use `Refresh Live View` or rely on 2s auto-polling during upload to inspect:
   - `Live Transcript` (`teacher/students`, `raw/merged`)
   - `Speaker Events` (`identity_source`)

Runtime rules:
- If mic/system track ends during meeting, client auto-stops upload/recording and surfaces a warning.
- Each stream has independent resume (`last_seq`) and ACK stats.

## Smoke Normalize Existing Files

```bash
pnpm normalize:smoke
```

You can also pass explicit input files:

```bash
node scripts/normalize_smoke.js /absolute/path/to/alice.m4a /absolute/path/to/bob.m4a
```
