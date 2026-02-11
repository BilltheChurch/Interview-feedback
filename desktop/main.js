const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell, session } = require('electron');

const {
  finalizeRecording,
  normalizeFromFile,
  TARGET_CHANNELS,
  TARGET_CODEC,
  TARGET_SAMPLE_RATE
} = require('./lib/audioPipeline');

const APP_TITLE = 'Interview Feedback Desktop (Phase 2.3)';
let preferredDisplaySourceId = null;

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

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 700,
    title: APP_TITLE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  return mainWindow;
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

  ipcMain.handle('capture:clear-preferred-source', async () => {
    preferredDisplaySourceId = null;
    return { ok: true };
  });

  ipcMain.handle('capture:get-preferred-source', async () => {
    return {
      preferredSourceId: preferredDisplaySourceId
    };
  });
}

app.whenReady().then(() => {
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

  // Required for navigator.mediaDevices.getDisplayMedia() in Electron.
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
        console.error('setDisplayMediaRequestHandler failed:', error);
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
