const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');

const {
  finalizeRecording,
  normalizeFromFile,
  TARGET_CHANNELS,
  TARGET_CODEC,
  TARGET_SAMPLE_RATE
} = require('./lib/audioPipeline');

const APP_TITLE = 'Interview Feedback Desktop (Phase 1)';

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
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') {
      callback(true);
      return;
    }
    callback(false);
  });

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
