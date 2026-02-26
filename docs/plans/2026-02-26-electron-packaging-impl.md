# Electron macOS Packaging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Package the Electron desktop app as distributable `.dmg` installers (arm64 + x64) with GitHub Actions CI/CD for automated releases.

**Architecture:** Fix packaged-app path resolution for `.env`, ffmpeg, and sidecar binaries. Split universal build into per-architecture DMGs. Add GitHub Actions workflow triggered by `v*` tags to build and upload draft Releases. pyannote-rs sidecar becomes optional with on-demand download.

**Tech Stack:** Electron 31, electron-builder 26, GitHub Actions (macos-14 runner), Vite 6

**Batches:**
- Batch 1 (Tasks 1-6): Core packaging — make `npm run dist` produce a working `.dmg`
- Batch 2 (Task 7): CI/CD — GitHub Actions auto-build on tag push
- Batch 3 (Task 8): Sidecar on-demand download — pyannote-rs runtime download

---

### Task 1: Create macOS entitlements plist

**Files:**
- Create: `desktop/build/entitlements.mac.plist`

**Step 1: Create the entitlements file**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

Entitlements explanation:
- `allow-jit` + `allow-unsigned-executable-memory`: Required by Electron's V8 engine
- `device.audio-input`: Microphone access for interview recording
- `network.client` + `network.server`: WebSocket connections to Edge Worker + local sidecar server
- `disable-library-validation`: Required for unsigned app to load native modules

**Step 2: Commit**

```bash
git add desktop/build/entitlements.mac.plist
git commit -m "build: add macOS entitlements plist for hardened runtime"
```

---

### Task 2: Update electron-builder.yml for per-architecture builds

**Files:**
- Modify: `desktop/electron-builder.yml`

**Step 1: Replace the entire file content**

```yaml
appId: com.frontierace.chorus
productName: Chorus
copyright: Copyright © 2026 FrontierAce

directories:
  output: release
  buildResources: build

files:
  - main.js
  - preload.js
  - "lib/**/*"
  - "dist/**/*"
  - "package.json"
  - "!src/**/*"
  - "!e2e/**/*"
  - "!**/*.test.*"
  - "!**/*.spec.*"
  - "!vitest*"
  - "!playwright*"
  - "!tsconfig*"
  - "!vite.config*"
  - "!bin/**/*"

mac:
  category: public.app-category.productivity
  icon: build/icons/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: false
  target:
    - target: dmg
      arch:
        - arm64
    - target: dmg
      arch:
        - x64

dmg:
  artifactName: "${productName}-${version}-${arch}.dmg"
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications

asar: true

protocols:
  - name: Chorus
    schemes:
      - interviewfeedback

extraResources:
  - from: node_modules/ffmpeg-static
    to: ffmpeg-static
    filter:
      - "**/*"
  - from: node_modules/ffprobe-static
    to: ffprobe-static
    filter:
      - "**/*"
  - from: .env
    to: .env
```

Key changes from original:
- `appId` → `com.frontierace.chorus`, `productName` → `Chorus`
- `icon: build/icons/icon.icns` added (was missing)
- `arch: [universal]` → two separate targets: `arm64` and `x64`
- `artifactName` with `${arch}` to distinguish DMG files
- `bin/**/*` explicitly excluded from `files` (not bundled)
- `.env` added to `extraResources` (accessible outside asar at runtime)

**Step 2: Commit**

```bash
git add desktop/electron-builder.yml
git commit -m "build: split universal into arm64+x64 DMGs, add icon and .env resource"
```

---

### Task 3: Fix .env loading for packaged app

**Files:**
- Modify: `desktop/main.js:3`

**Step 1: Read `desktop/main.js` lines 1-5**

Current code (line 3):
```javascript
require('dotenv').config({ path: path.join(__dirname, '.env') });
```

Problem: In a packaged app, `__dirname` points inside `app.asar`. The `.env` file is in `extraResources` at `process.resourcesPath/.env`.

**Step 2: Replace line 3 with packaged-aware path resolution**

```javascript
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });
```

But there's a problem: `app` is destructured on line 4 AFTER line 3 runs. We need to reorder. Change lines 1-4 to:

```javascript
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell, session, screen } = require('electron');
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });
```

**Step 3: Verify the app still starts in dev mode**

```bash
cd desktop && npm run dev
```

Expected: App window opens normally.

**Step 4: Commit**

```bash
git add desktop/main.js
git commit -m "fix: resolve .env path for packaged Electron app"
```

---

### Task 4: Fix ffmpeg/ffprobe path for packaged app

**Files:**
- Modify: `desktop/lib/audioPipeline.js:5-6`

**Step 1: Read `desktop/lib/audioPipeline.js` lines 1-10**

Current code:
```javascript
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
```

Problem: `require('ffmpeg-static')` returns a path inside `node_modules/` which is inside `app.asar` in a packaged app. Binaries cannot execute from inside an asar archive. electron-builder copies them to `extraResources`, but the require path still points to the asar.

**Step 2: Replace lines 5-6 with packaged-aware resolution**

```javascript
const { app } = require('electron');

function resolveFFmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg-static', 'ffmpeg');
  }
  return require('ffmpeg-static');
}

function resolveFFprobePath() {
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, 'ffprobe-static', 'bin');
    // ffprobe-static stores binary in bin/{platform}/{arch}/ffprobe
    return path.join(base, process.platform, process.arch, 'ffprobe');
  }
  return require('ffprobe-static').path;
}

const ffmpegPath = resolveFFmpegPath();
const ffprobePath = resolveFFprobePath();
```

**Step 3: Verify audio normalization still works in dev mode**

```bash
cd desktop && npm run normalize:smoke
```

If the smoke test doesn't exist or requires specific audio files, verify manually:
```bash
cd desktop && node -e "const ap = require('./lib/audioPipeline'); console.log('ffmpeg:', ap.TARGET_SAMPLE_RATE);"
```

Expected: No errors, prints `16000`.

**Step 4: Commit**

```bash
git add desktop/lib/audioPipeline.js
git commit -m "fix: resolve ffmpeg/ffprobe paths for packaged Electron app"
```

---

### Task 5: Create .env.opensource and .env.production

**Files:**
- Create: `desktop/.env.opensource`
- Create: `desktop/.env.production`

**Step 1: Create `.env.opensource`**

This is for open-source GitHub Release builds — no pre-configured backend:

```env
# Chorus Open Source Edition
# Configure your backend URL in Settings after launching the app.

# Microsoft Graph OAuth (optional — for Teams calendar integration)
MS_GRAPH_CLIENT_ID=
MS_GRAPH_TENANT_ID=common

# Google Calendar OAuth (optional)
GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=

# Backend API URL (required — set to your self-hosted Edge Worker)
API_BASE_URL=

# Azure Communication Services (optional — for Teams captions)
ACS_CONNECTION_STRING=
ACS_ENABLED=false
```

**Step 2: Create `.env.production`**

This is for commercial builds — pre-configured with hosted service:

```env
# Chorus Commercial Edition
# Pre-configured for FrontierAce hosted service.

MS_GRAPH_CLIENT_ID=
MS_GRAPH_TENANT_ID=common

GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=

API_BASE_URL=https://api.frontierace.ai

ACS_CONNECTION_STRING=
ACS_ENABLED=false
```

Note: Actual secrets (client IDs, ACS connection string) should be filled in before commercial builds but NOT committed to git.

**Step 3: Add both to .gitignore exceptions**

The `.env.opensource` and `.env.production` templates should be tracked in git (they contain no secrets). Verify they are NOT caught by the existing `desktop/.env` gitignore rule. The current `.gitignore` has `desktop/.env` which is an exact match, so `desktop/.env.opensource` and `desktop/.env.production` should NOT be ignored. Verify:

```bash
git check-ignore desktop/.env.opensource desktop/.env.production
```

Expected: No output (not ignored).

**Step 4: Commit**

```bash
git add desktop/.env.opensource desktop/.env.production
git commit -m "build: add env templates for open-source and commercial builds"
```

---

### Task 6: Add build scripts to package.json

**Files:**
- Modify: `desktop/package.json`
- Create: `desktop/scripts/build.sh`

**Step 1: Create `desktop/scripts/build.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:-opensource}"
ARCH="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Select .env variant
if [ "$VARIANT" = "production" ]; then
  echo "Building COMMERCIAL variant..."
  cp .env.production .env
elif [ "$VARIANT" = "opensource" ]; then
  echo "Building OPEN-SOURCE variant..."
  cp .env.opensource .env
else
  echo "Usage: build.sh [opensource|production] [arm64|x64]"
  exit 1
fi

# Build React app
echo "Building React app..."
npx vite build

# Build Electron DMG
if [ -n "$ARCH" ]; then
  echo "Building Electron DMG for arch=$ARCH..."
  npx electron-builder --mac --$ARCH
else
  echo "Building Electron DMG (all configured architectures)..."
  npx electron-builder --mac
fi

echo ""
echo "Build complete! Output in release/"
ls -lh release/*.dmg 2>/dev/null || echo "(no DMG files found)"
```

**Step 2: Make it executable**

```bash
chmod +x desktop/scripts/build.sh
```

**Step 3: Update `desktop/package.json` scripts**

Add these scripts (keep existing ones):

```json
"dist:arm64": "scripts/build.sh opensource arm64",
"dist:x64": "scripts/build.sh opensource x64",
"dist:all": "scripts/build.sh opensource",
"dist:commercial": "scripts/build.sh production"
```

Also update `license` field:

```json
"license": "MIT"
```

**Step 4: Commit**

```bash
git add desktop/scripts/build.sh desktop/package.json
git commit -m "build: add build scripts for open-source and commercial DMG variants"
```

---

### Task 7: Create GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release-desktop.yml`

**Step 1: Create the workflow file**

```yaml
name: Release Desktop

on:
  push:
    tags:
      - 'v*'

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: write

jobs:
  build-dmg:
    name: Build macOS DMG (${{ matrix.arch }})
    runs-on: macos-14
    strategy:
      matrix:
        arch: [arm64, x64]
    defaults:
      run:
        working-directory: desktop

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: desktop/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Copy open-source env
        run: cp .env.opensource .env

      - name: Build React app
        run: npx vite build

      - name: Build Electron DMG
        run: npx electron-builder --mac --${{ matrix.arch }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: List build output
        run: ls -lh release/*.dmg

      - name: Upload DMG artifact
        uses: actions/upload-artifact@v4
        with:
          name: dmg-${{ matrix.arch }}
          path: desktop/release/*.dmg
          retention-days: 30

  create-release:
    name: Create GitHub Release
    needs: build-dmg
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Download arm64 DMG
        uses: actions/download-artifact@v4
        with:
          name: dmg-arm64
          path: release/

      - name: Download x64 DMG
        uses: actions/download-artifact@v4
        with:
          name: dmg-x64
          path: release/

      - name: List release assets
        run: ls -lh release/

      - name: Create draft release
        uses: softprops/action-gh-release@v2
        with:
          draft: true
          generate_release_notes: true
          files: release/*.dmg
          body: |
            ## Installation (macOS)

            1. Download the `.dmg` for your chip:
               - **Apple Silicon** (M1/M2/M3/M4): `Chorus-${{ github.ref_name }}-arm64.dmg`
               - **Intel**: `Chorus-${{ github.ref_name }}-x64.dmg`
            2. Open the `.dmg` and drag **Chorus** to Applications
            3. First launch: right-click the app → **Open** → click **Open** in the dialog
               _(required because the app is not yet code-signed)_
            4. Configure your backend URL in **Settings**

            > This is an open-source build. To use Chorus, you need a running
            > [Edge Worker](https://github.com/BilltheChurch/Interview-feedback/tree/main/edge/worker)
            > and [Inference Service](https://github.com/BilltheChurch/Interview-feedback/tree/main/inference).
```

**Step 2: Commit**

```bash
git add .github/workflows/release-desktop.yml
git commit -m "ci: add GitHub Actions workflow for macOS DMG release on tag push"
```

---

### Task 8: Make pyannote-rs sidecar optional with on-demand download

**Files:**
- Modify: `desktop/lib/diarizationSidecar.js:57-78`

**Step 1: Read `desktop/lib/diarizationSidecar.js` fully to understand the current structure**

**Step 2: Add download helper and update binary resolution**

Add a download helper function BEFORE the `createDiarizationSidecar` function:

```javascript
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');

const SIDECAR_VERSION = 'v0.1.0';
const SIDECAR_BASE_URL = `https://github.com/BilltheChurch/Interview-feedback/releases/download/${SIDECAR_VERSION}`;

function getSidecarDir() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'bin');
  } catch {
    return path.join(require('node:os').homedir(), '.chorus', 'bin');
  }
}

function getSidecarBinaryPath() {
  return path.join(getSidecarDir(), 'pyannote-rs');
}

function getSidecarModelsDir() {
  return path.join(getSidecarDir(), 'models');
}

async function downloadFile(url, destPath, onProgress) {
  const dir = path.dirname(destPath);
  await fs.promises.mkdir(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Chorus-Desktop' } }, (response) => {
      // Follow redirects (GitHub releases redirect to S3)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, destPath, onProgress).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const fileStream = createWriteStream(destPath);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress && totalBytes > 0) {
          onProgress(downloadedBytes / totalBytes);
        }
      });

      pipeline(response, fileStream).then(resolve, reject);
    });
    request.on('error', reject);
  });
}

async function ensureSidecarAvailable(log, onProgress) {
  const binaryPath = getSidecarBinaryPath();
  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  const modelsDir = getSidecarModelsDir();
  const arch = process.arch; // arm64 or x64

  log(`[sidecar] downloading pyannote-rs for ${arch}...`);

  // Download binary
  const binaryUrl = `${SIDECAR_BASE_URL}/pyannote-rs-${arch}`;
  await downloadFile(binaryUrl, binaryPath, (p) => onProgress?.('binary', p));
  await fs.promises.chmod(binaryPath, 0o755);

  // Download models
  const models = ['segmentation-3.0.onnx', 'wespeaker_en_voxceleb_CAM++.onnx'];
  for (const model of models) {
    const modelPath = path.join(modelsDir, model);
    if (!fs.existsSync(modelPath)) {
      log(`[sidecar] downloading model ${model}...`);
      const modelUrl = `${SIDECAR_BASE_URL}/${model}`;
      await downloadFile(modelUrl, modelPath, (p) => onProgress?.(`model:${model}`, p));
    }
  }

  log(`[sidecar] download complete: ${binaryPath}`);
  return binaryPath;
}
```

**Step 3: Update the `start` function (line 57-78)**

Replace the binary path resolution block inside `start()`:

```javascript
  async function start(options = {}) {
    if (process.platform !== 'darwin') {
      throw new Error(
        `pyannote sidecar supports macOS only (current platform=${process.platform})`
      );
    }
    if (state.process && !state.process.killed) {
      return status();
    }
    state.stopRequested = false;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }

    // Resolve binary: explicit path > env var > user data dir > bundled fallback
    let binaryPath =
      options.binaryPath ||
      process.env.PYANNOTE_RS_BIN ||
      null;

    if (!binaryPath) {
      // Check user data directory first (on-demand downloaded)
      const userDataPath = getSidecarBinaryPath();
      if (fs.existsSync(userDataPath)) {
        binaryPath = userDataPath;
      } else {
        // Check bundled path (dev mode)
        const bundledPath = path.join(appRoot, 'bin', 'pyannote-rs');
        if (fs.existsSync(bundledPath)) {
          binaryPath = bundledPath;
        } else {
          throw new Error(
            'pyannote-rs binary not found. Use diarizationSidecar.download() to install it.'
          );
        }
      }
    }
```

**Step 4: Export the download function**

At the end of `createDiarizationSidecar`, add `download` to the returned object:

```javascript
  return {
    start,
    stop,
    status,
    pushChunk,
    download: (onProgress) => ensureSidecarAvailable(log, onProgress)
  };
```

**Step 5: Add IPC handler for download in `main.js`**

Search for existing diarization IPC handlers in `main.js` and add nearby:

```javascript
ipcMain.handle('diarization:download', async (_event) => {
  try {
    const binaryPath = await sidecar.download((stage, progress) => {
      mainWindow?.webContents.send('diarization:download-progress', { stage, progress });
    });
    return { success: true, path: binaryPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
```

Also add the IPC method to `preload.js`:

```javascript
diarizationDownload: () => ipcRenderer.invoke('diarization:download'),
onDiarizationDownloadProgress: (callback) => {
  ipcRenderer.on('diarization:download-progress', (_event, data) => callback(data));
},
```

**Step 6: Verify dev mode still works**

```bash
cd desktop && npm run dev
```

Expected: App starts. Diarization still works if `bin/pyannote-rs` exists locally.

**Step 7: Commit**

```bash
git add desktop/lib/diarizationSidecar.js desktop/main.js desktop/preload.js
git commit -m "feat: add on-demand pyannote-rs sidecar download for packaged app"
```

---

## Verification

### Local Build Test

```bash
cd desktop
cp .env.opensource .env
npx vite build
npx electron-builder --mac --arm64
ls -lh release/*.dmg
```

Expected: `release/Chorus-0.1.0-arm64.dmg` (~80MB)

### Install Test

```bash
open release/Chorus-0.1.0-arm64.dmg
# Drag to Applications
# Right-click → Open → Open
```

Expected: App launches, shows Settings/Home page.

### CI Test

```bash
git tag v0.1.0
git push origin v0.1.0
```

Expected: GitHub Actions builds both DMGs, creates draft Release.

---

## Summary

| Task | Component | Change | Status |
|------|-----------|--------|--------|
| 1 | build config | Create entitlements.mac.plist | ✅ Done |
| 2 | build config | Update electron-builder.yml (split arch, icon, .env resource) | ✅ Done |
| 3 | main.js | Fix .env loading for packaged app | ✅ Done |
| 4 | audioPipeline.js | Fix ffmpeg/ffprobe path for packaged app | ✅ Done |
| 5 | env config | Create .env.opensource + .env.production | ✅ Done |
| 6 | package.json | Add build scripts + build.sh | ✅ Done |
| 7 | CI/CD | GitHub Actions release workflow | ✅ Done |
| 8 | sidecar | On-demand pyannote-rs download | ✅ Done |

## Implementation Notes (2026-02-26)

- **Build verified:** Both `Chorus-0.1.0-arm64.dmg` (304MB) and `Chorus-0.1.0-x64.dmg` (312MB) built successfully
- **Code signing:** Auto-signed with local Apple Development certificate (notarization skipped as configured)
- **Fix applied:** Moved `electron` from `dependencies` to `devDependencies` (electron-builder requirement)
- **Pre-existing issue:** `dompurify` missing from node_modules required `npm install` before build; not related to packaging changes
