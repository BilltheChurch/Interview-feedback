const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell, session, screen } = require('electron');

const {
  finalizeRecording,
  normalizeFromFile,
  TARGET_CHANNELS,
  TARGET_CODEC,
  TARGET_SAMPLE_RATE
} = require('./lib/audioPipeline');
const { createDiarizationSidecar } = require('./lib/diarizationSidecar');
const { createPyannoteWindowBuilder } = require('./lib/pyannoteWindowBuilder');
const { TeamsWindowTracker } = require('./lib/teamsWindowTracker');
const { GraphCalendarClient } = require('./lib/graphCalendar');

const APP_TITLE = 'Interview Feedback Desktop (Phase 2.3)';
let preferredDisplaySourceId = null;
let mainWindow = null;
let windowMode = 'dashboard';

function logDesktop(message, details = null) {
  const stamp = new Date().toISOString();
  const line = details === null ? `[${stamp}] ${message}` : `[${stamp}] ${message} ${JSON.stringify(details)}`;
  try {
    if (app.isReady()) {
      const logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'desktop-main.log'), `${line}\n`, 'utf8');
    }
  } catch {
    // noop
  }
  console.error(line);
}

const sidecar = createDiarizationSidecar({
  appRoot: __dirname,
  log: (line) => logDesktop(line)
});
const windowBuilders = new Map();
let graphCalendar = null;
const teamsWindowTracker = new TeamsWindowTracker({
  getOverlayWindow: () => mainWindow,
  screen,
  pollMs: 400,
  log: (message, details) => logDesktop(`[teams-attach] ${message}`, details)
});

function base64ToInt16(contentB64) {
  const buf = Buffer.from(String(contentB64 || ''), 'base64');
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

function getWindowBuilder(sessionId) {
  const key = String(sessionId || '').trim();
  if (!key) {
    throw new Error('sessionId is required for diarization window builder');
  }
  if (!windowBuilders.has(key)) {
    windowBuilders.set(
      key,
      createPyannoteWindowBuilder({
        sampleRate: TARGET_SAMPLE_RATE,
        windowMs: 10000,
        hopMs: 2000
      })
    );
  }
  return windowBuilders.get(key);
}

function pickDisplaySource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  if (preferredDisplaySourceId) {
    const matched = sources.find((item) => item.id === preferredDisplaySourceId);
    if (matched) {
      return matched;
    }
    return null;
  }

  const screenFirst = sources
    .slice()
    .sort((a, b) => {
      const aScore = a.id.startsWith('screen:') ? 0 : 1;
      const bScore = b.id.startsWith('screen:') ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return a.name.localeCompare(b.name);
    });
  return screenFirst[0];
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function setWindowMode(nextMode) {
  const mode = nextMode === 'session' ? 'session' : 'dashboard';
  windowMode = mode;
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { mode, applied: false };
  }

  if (mode === 'session') {
    mainWindow.setMinimumSize(380, 640);
    mainWindow.setMaximumSize(520, 2000);
    const current = mainWindow.getBounds();
    const nextWidth = Math.max(380, Math.min(520, current.width || 420));
    const nextHeight = Math.max(700, current.height || 860);
    mainWindow.setBounds({ ...current, width: nextWidth, height: nextHeight }, true);
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setFullScreenable(false);
    mainWindow.setResizable(true);
    return { mode, applied: true };
  }

  mainWindow.setMaximumSize(10000, 10000);
  mainWindow.setMinimumSize(900, 680);
  const current = mainWindow.getBounds();
  const nextWidth = Math.max(980, current.width || 1040);
  const nextHeight = Math.max(760, current.height || 780);
  mainWindow.setBounds({ ...current, width: nextWidth, height: nextHeight }, true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setResizable(true);
  return { mode, applied: true };
}

function createWindow() {
  const createdWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 900,
    minHeight: 680,
    title: APP_TITLE,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    fullScreenable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  createdWindow.loadFile(path.join(__dirname, 'index.html'));
  createdWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false });

  createdWindow.webContents.on('render-process-gone', (_event, details) => {
    logDesktop('[desktop] renderer process gone', details);
  });

  createdWindow.webContents.on('unresponsive', () => {
    logDesktop('[desktop] renderer became unresponsive');
  });

  createdWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logDesktop('[desktop] did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame });
  });

  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) {
      mainWindow = null;
    }
  });

  mainWindow = createdWindow;
  setWindowMode('dashboard');
  return createdWindow;
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-info', async () => {
    return {
      appName: APP_TITLE,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      target: {
        sampleRate: TARGET_SAMPLE_RATE,
        channels: TARGET_CHANNELS,
        codec: TARGET_CODEC
      }
    };
  });

  ipcMain.handle('recording:finalize', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('recording payload is required');
    }

    const recordsRoot = path.join(app.getPath('userData'), 'records');
    const result = await finalizeRecording({
      rawBytes: payload.rawBytes,
      mimeType: payload.mimeType,
      meetingId: payload.meetingId,
      outputDir: recordsRoot
    });
    return result;
  });

  ipcMain.handle('recording:normalize-file', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('normalize payload is required');
    }
    if (!payload.inputPath) {
      throw new Error('inputPath is required');
    }

    const recordsRoot = path.join(app.getPath('userData'), 'records');
    return normalizeFromFile({
      inputPath: payload.inputPath,
      meetingId: payload.meetingId,
      outputDir: recordsRoot
    });
  });

  ipcMain.handle('recording:pick-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select audio file',
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio',
          extensions: ['m4a', 'mp3', 'wav', 'webm', 'ogg', 'flac', 'mp4']
        }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return {
      canceled: false,
      filePath: result.filePaths[0]
    };
  });

  ipcMain.handle('recording:open-path', async (_event, filePath) => {
    if (!filePath) {
      return { ok: false, error: 'file path is empty' };
    }

    const error = await shell.openPath(filePath);
    if (error) {
      return { ok: false, error };
    }
    return { ok: true };
  });

  ipcMain.handle('api:request', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('api request payload is required');
    }

    const method = typeof payload.method === 'string' ? payload.method.toUpperCase() : 'GET';
    const url = typeof payload.url === 'string' ? payload.url : '';
    if (!url) {
      throw new Error('api request url is required');
    }

    const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
    const response = await fetch(url, {
      method,
      headers,
      body: payload.body === undefined ? undefined : payload.body
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text
    };
  });

  ipcMain.handle('session:finalizeV2', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('session finalize payload is required');
    }
    const baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
    const sessionId = String(payload.sessionId || '').trim();
    if (!baseUrl || !sessionId) {
      throw new Error('baseUrl and sessionId are required');
    }
    const response = await requestJson(
      `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/finalize?version=v2`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: payload.metadata || {} })
      }
    );
    if (!response.ok) {
      throw new Error(`finalize-v2 failed: ${response.status} ${JSON.stringify(response.data).slice(0, 240)}`);
    }
    return response.data;
  });

  ipcMain.handle('session:getFinalizeStatus', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('session status payload is required');
    }
    const baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
    const sessionId = String(payload.sessionId || '').trim();
    const jobId = String(payload.jobId || '').trim();
    if (!baseUrl || !sessionId) {
      throw new Error('baseUrl and sessionId are required');
    }
    const suffix = jobId ? `?job_id=${encodeURIComponent(jobId)}` : '';
    const response = await requestJson(
      `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/finalize/status${suffix}`
    );
    if (!response.ok) {
      throw new Error(`get-finalize-status failed: ${response.status} ${JSON.stringify(response.data).slice(0, 240)}`);
    }
    return response.data;
  });

  ipcMain.handle('session:getResultV2', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('session result payload is required');
    }
    const baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
    const sessionId = String(payload.sessionId || '').trim();
    if (!baseUrl || !sessionId) {
      throw new Error('baseUrl and sessionId are required');
    }
    const response = await requestJson(
      `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/result?version=v2`
    );
    if (!response.ok) {
      throw new Error(`get-result-v2 failed: ${response.status} ${JSON.stringify(response.data).slice(0, 240)}`);
    }
    return response.data;
  });

  ipcMain.handle('diarization:start', async (_event, payload) => {
    const options = payload && typeof payload === 'object' ? payload : {};
    return sidecar.start(options);
  });

  ipcMain.handle('diarization:stop', async () => {
    return sidecar.stop();
  });

  ipcMain.handle('diarization:getStatus', async () => {
    const status = sidecar.status();
    const healthy = await sidecar.health();
    return { ...status, healthy };
  });

  ipcMain.handle('diarization:pushChunk', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('diarization payload is required');
    }

    const sessionId = String(payload.sessionId || '').trim();
    const seq = Number(payload.seq);
    const timestampMs = Number(payload.timestampMs);
    const contentB64 = String(payload.content_b64 || '').trim();
    if (!sessionId || !Number.isFinite(seq) || !Number.isFinite(timestampMs) || !contentB64) {
      throw new Error('diarization chunk requires sessionId, seq, timestampMs, content_b64');
    }

    const builder = getWindowBuilder(sessionId);
    const samples = base64ToInt16(contentB64);
    const windowPayload = builder.pushSamples({
      seq,
      timestampMs,
      samples
    });
    if (!windowPayload) {
      return { queued: true };
    }

    const diarized = await sidecar.pushWindow({
      ...windowPayload,
      session_id: sessionId
    });

    const baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
    let upload = null;
    if (baseUrl && sessionId) {
      const tracks = Array.isArray(diarized.tracks) ? diarized.tracks : [];
      const seqRange = Array.isArray(windowPayload.seq_range) ? windowPayload.seq_range : [seq, seq];
      const seqStart = Number(seqRange[0] || seq);
      const seqEnd = Number(seqRange[1] || seq);
      const turns = tracks.map((track, index) => ({
        turn_id: `${sessionId}-edge-${seqStart}-${seqEnd}-${Math.round(Number(track.start_ms || 0))}-${index + 1}`,
        start_ms: Number(track.start_ms || 0),
        end_ms: Number(track.end_ms || 0),
        stream_role: 'students',
        cluster_id: String(track.speaker_id || `edge_${index + 1}`)
      }));
      const clusterMap = new Map();
      for (const turn of turns) {
        const prev = clusterMap.get(turn.cluster_id) || [];
        prev.push(turn.turn_id);
        clusterMap.set(turn.cluster_id, prev);
      }
      const clusters = Array.from(clusterMap.entries()).map(([clusterId, turnIds]) => ({
        cluster_id: clusterId,
        turn_ids: turnIds,
        confidence: null
      }));

      const response = await requestJson(
        `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/speaker-logs`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'edge',
            window: windowPayload.window || '10000ms/2000ms',
            start_end_ms: windowPayload.start_end_ms || null,
            turns,
            clusters,
            speaker_map: []
          })
        }
      );
      if (!response.ok) {
        throw new Error(`speaker-logs upload failed: ${response.status} ${JSON.stringify(response.data).slice(0, 240)}`);
      }
      upload = response.data;
    }

    return {
      diarized,
      upload
    };
  });

  ipcMain.handle('capture:clear-preferred-source', async () => {
    preferredDisplaySourceId = null;
    return { ok: true };
  });

  ipcMain.handle('capture:get-preferred-source', async () => {
    return {
      preferredSourceId: preferredDisplaySourceId
    };
  });

  ipcMain.handle('window:attachToTeams', async () => {
    return teamsWindowTracker.attach();
  });

  ipcMain.handle('window:detachFromTeams', async () => {
    return teamsWindowTracker.detach();
  });

  ipcMain.handle('window:getAttachStatus', async () => {
    return teamsWindowTracker.status();
  });

  ipcMain.handle('window:setMode', async (_event, payload) => {
    const mode = String(payload?.mode || '').trim().toLowerCase();
    if (mode !== 'dashboard' && mode !== 'session') {
      throw new Error("window mode must be 'dashboard' or 'session'");
    }
    return setWindowMode(mode);
  });

  ipcMain.handle('calendar:setConfig', async (_event, payload) => {
    if (!graphCalendar) {
      throw new Error('graph calendar is not initialized');
    }
    return graphCalendar.setConfig({
      clientId: String(payload?.clientId || '').trim(),
      tenantId: String(payload?.tenantId || '').trim() || 'common'
    });
  });

  ipcMain.handle('calendar:getStatus', async () => {
    if (!graphCalendar) {
      throw new Error('graph calendar is not initialized');
    }
    return graphCalendar.getStatus();
  });

  ipcMain.handle('calendar:connectMicrosoft', async () => {
    if (!graphCalendar) {
      throw new Error('graph calendar is not initialized');
    }
    return graphCalendar.connect();
  });

  ipcMain.handle('calendar:getUpcomingMeetings', async (_event, payload) => {
    if (!graphCalendar) {
      throw new Error('graph calendar is not initialized');
    }
    return graphCalendar.getUpcomingMeetings({
      days: Number(payload?.days || 3)
    });
  });

  ipcMain.handle('calendar:disconnectMicrosoft', async () => {
    if (!graphCalendar) {
      throw new Error('graph calendar is not initialized');
    }
    return graphCalendar.disconnect();
  });

  ipcMain.handle('system:openPrivacySettings', async (_event, payload) => {
    const target = String(payload?.target || 'accessibility').trim().toLowerCase();
    const urls = {
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
      screencapture: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    };
    const url = urls[target] || urls.accessibility;
    await shell.openExternal(url);
    return {
      ok: true,
      target,
      url
    };
  });
}

app.whenReady().then(() => {
  graphCalendar = new GraphCalendarClient({
    cachePath: path.join(app.getPath('userData'), 'graph', 'token-cache.json'),
    clientId: process.env.MS_GRAPH_CLIENT_ID || '',
    tenantId: process.env.MS_GRAPH_TENANT_ID || 'common',
    log: (message, details) => logDesktop(message, details)
  });

  const allowedPermissions = new Set([
    'media',
    'microphone',
    'display-capture',
    'screen'
  ]);

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (allowedPermissions.has(permission)) {
      callback(true);
      return;
    }
    callback(false);
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window']
        });

        if (!sources || sources.length === 0) {
          callback({
            video: null,
            audio: null
          });
          return;
        }

        const chosen = pickDisplaySource(sources);
        if (!chosen) {
          callback({
            video: null,
            audio: null
          });
          return;
        }

        preferredDisplaySourceId = chosen.id;

        callback({
          video: chosen,
          audio: 'loopback'
        });
      } catch (error) {
        logDesktop('setDisplayMediaRequestHandler failed', { error: error?.message || String(error) });
        callback({
          video: null,
          audio: null
        });
      }
    },
    {
      useSystemPicker: false
    }
  );

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

process.on('uncaughtException', (error) => {
  logDesktop('[desktop] uncaughtException', { error: error?.stack || error?.message || String(error) });
});

process.on('unhandledRejection', (reason) => {
  logDesktop('[desktop] unhandledRejection', { reason: String(reason) });
});

app.on('before-quit', async () => {
  try {
    await teamsWindowTracker.detach();
  } catch (error) {
    logDesktop('teams tracker detach failed on quit', { error: error?.message || String(error) });
  }
  try {
    await sidecar.stop();
  } catch (error) {
    logDesktop('sidecar stop failed on quit', { error: error?.message || String(error) });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
