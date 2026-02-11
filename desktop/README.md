# Desktop (Phase 1)

This Electron app implements the Phase 1 local self-check path from the project docs:

- microphone capture
- local recording
- strict normalization to `16kHz / mono / pcm_s16le`
- metadata validation by `ffprobe`
- live WebSocket upload in 1-second `pcm_s16le` chunks

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
2. Confirm input level bar is moving.
3. Click `Start Upload` to stream `1s` chunks to `wss://api.frontierace.ai/v1/audio/ws/<meeting_id>`.
4. Observe `ack/missing/last_seq` status in the panel.
5. Optionally run `Start 30s Recording` and validate the normalized WAV.

## Smoke Normalize Existing Files

```bash
pnpm normalize:smoke
```

You can also pass explicit input files:

```bash
node scripts/normalize_smoke.js /absolute/path/to/alice.m4a /absolute/path/to/bob.m4a
```
