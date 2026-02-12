const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  finalizeRecording: (payload) => ipcRenderer.invoke('recording:finalize', payload),
  normalizeFile: (payload) => ipcRenderer.invoke('recording:normalize-file', payload),
  pickFile: () => ipcRenderer.invoke('recording:pick-file'),
  openPath: (filePath) => ipcRenderer.invoke('recording:open-path', filePath),
  apiRequest: (payload) => ipcRenderer.invoke('api:request', payload),
  finalizeV2: (payload) => ipcRenderer.invoke('session:finalizeV2', payload),
  getFinalizeStatus: (payload) => ipcRenderer.invoke('session:getFinalizeStatus', payload),
  getResultV2: (payload) => ipcRenderer.invoke('session:getResultV2', payload),
  diarizationStart: (payload) => ipcRenderer.invoke('diarization:start', payload),
  diarizationStop: () => ipcRenderer.invoke('diarization:stop'),
  diarizationGetStatus: () => ipcRenderer.invoke('diarization:getStatus'),
  diarizationPushChunk: (payload) => ipcRenderer.invoke('diarization:pushChunk', payload),
  attachToTeams: () => ipcRenderer.invoke('window:attachToTeams'),
  detachFromTeams: () => ipcRenderer.invoke('window:detachFromTeams'),
  getAttachStatus: () => ipcRenderer.invoke('window:getAttachStatus'),
  clearPreferredCaptureSource: () => ipcRenderer.invoke('capture:clear-preferred-source'),
  getPreferredCaptureSource: () => ipcRenderer.invoke('capture:get-preferred-source')
});
