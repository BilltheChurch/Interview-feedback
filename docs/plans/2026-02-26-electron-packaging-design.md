# Electron macOS Packaging & CI/CD Design

## Goal

Build a distributable `.dmg` installer for macOS (arm64 + x64) and set up GitHub Actions CI/CD to auto-build on tagged releases.

## Architecture

Two build variants from the same codebase, differentiated by `.env` files:
- **Open-source build** — no pre-configured backend, user self-configures in Settings
- **Commercial build** — pre-configured with hosted cloud service endpoints

CI/CD on GitHub Actions with macOS runners. Tag `v*` push triggers draft Release with two DMG assets (arm64 + x64). pyannote-rs sidecar downloaded on-demand at runtime (not bundled).

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Separate arm64 + x64 builds | ~80MB each vs ~200MB universal |
| pyannote-rs | On-demand download at runtime | Only needed for offline diarization; saves ~60MB |
| Code signing | Unsigned (for now) | No Apple Developer account; add install instructions |
| Auto-update | Deferred | Requires code signing; add after getting Apple cert |
| Release mode | Draft → manual publish | Developer reviews before public release |
| Default backend | Empty (open-source), pre-configured (commercial) | Two `.env` files at build time |

## Expected DMG Size

| Component | Size |
|-----------|------|
| Electron runtime (single arch) | ~60MB |
| React bundle + app code | ~5MB |
| ffmpeg-static + ffprobe-static | ~15MB |
| **Total** | **~80MB** |

## Files to Create/Modify

### Create

| File | Purpose |
|------|---------|
| `desktop/build/entitlements.mac.plist` | macOS hardened runtime permissions (mic, network, child process) |
| `desktop/.env.opensource` | Empty backend config for open-source build |
| `desktop/.env.production` | Pre-configured backend for commercial build |
| `desktop/scripts/build.sh` | Build script selecting env variant |
| `.github/workflows/release-desktop.yml` | CI: tag → build arm64+x64 → upload to GitHub Release |

### Modify

| File | Change |
|------|--------|
| `desktop/electron-builder.yml` | Remove `bin/` from files; split arch into arm64+x64; add icon path |
| `desktop/main.js` | Fix `.env` loading for packaged app (`app.getAppPath()` fallback) |
| `desktop/package.json` | Update license field; add `dist:arm64` / `dist:x64` scripts |
| `desktop/lib/diarizationSidecar.js` | Add on-demand download logic for pyannote-rs binary + models |

## Build Flow

```
npm run build:react          # Vite → dist/
npm run dist:arm64           # electron-builder → release/Chorus-x.y.z-arm64.dmg
npm run dist:x64             # electron-builder → release/Chorus-x.y.z-x64.dmg
```

## CI/CD Flow

```
git tag v0.1.0 && git push origin v0.1.0
    │
    ▼
GitHub Actions (macos-latest)
    │
    ├─ matrix: [arm64, x64]
    ├─ checkout + npm install
    ├─ cp .env.opensource .env
    ├─ npm run build:react
    ├─ npm run dist:${arch}
    └─ upload .dmg to GitHub Release (draft)
```

## pyannote-rs On-Demand Download

When user first enables local diarization:
1. Check if `bin/pyannote-rs` exists in app data directory
2. If not, show download progress dialog (~60MB from GitHub Release asset)
3. Download `pyannote-rs` binary + `models/*.onnx` to `app.getPath('userData')/bin/`
4. `diarizationSidecar.js` checks user data path first, then bundled path

Host the sidecar binary as a separate GitHub Release asset:
- `pyannote-rs-arm64.tar.gz` (~25MB compressed)
- `pyannote-rs-x64.tar.gz` (~25MB compressed)
- Models shared across architectures: `pyannote-rs-models.tar.gz` (~15MB compressed)

## Entitlements (macOS)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>              <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key> <true/>
  <key>com.apple.security.device.audio-input</key>         <true/>
  <key>com.apple.security.network.client</key>             <true/>
  <key>com.apple.security.network.server</key>             <true/>
  <key>com.apple.security.cs.disable-library-validation</key> <true/>
</dict>
</plist>
```

## Install Instructions (Unsigned App)

For GitHub Release page:

```markdown
### macOS Installation

1. Download the `.dmg` for your chip:
   - **Apple Silicon** (M1/M2/M3/M4): `Chorus-x.y.z-arm64.dmg`
   - **Intel**: `Chorus-x.y.z-x64.dmg`
2. Open the `.dmg` and drag Chorus to Applications
3. First launch: right-click the app → "Open" → click "Open" in the dialog
   (required because the app is not yet code-signed)
```
