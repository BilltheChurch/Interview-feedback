const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  finalizeRecording: (payload) => ipcRenderer.invoke('recording:finalize', payload),
  normalizeFile: (payload) => ipcRenderer.invoke('recording:normalize-file', payload),
  pickFile: () => ipcRenderer.invoke('recording:pick-file'),
  openPath: (filePath) => ipcRenderer.invoke('recording:open-path', filePath),
  apiRequest: (payload) => ipcRenderer.invoke('api:request', payload)
});
