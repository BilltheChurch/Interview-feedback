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
  getFeedbackReady: (payload) => ipcRenderer.invoke('session:getFeedbackReady', payload),
  openFeedback: (payload) => ipcRenderer.invoke('session:openFeedback', payload),
  regenerateFeedbackClaim: (payload) => ipcRenderer.invoke('session:regenerateFeedbackClaim', payload),
  updateFeedbackClaimEvidence: (payload) => ipcRenderer.invoke('session:updateFeedbackClaimEvidence', payload),
  listSessionHistory: (payload) => ipcRenderer.invoke('session:listHistory', payload),
  exportFeedback: (payload) => ipcRenderer.invoke('session:exportFeedback', payload),
  diarizationStart: (payload) => ipcRenderer.invoke('diarization:start', payload),
  diarizationStop: () => ipcRenderer.invoke('diarization:stop'),
  diarizationGetStatus: () => ipcRenderer.invoke('diarization:getStatus'),
  diarizationPushChunk: (payload) => ipcRenderer.invoke('diarization:pushChunk', payload),
  attachToTeams: () => ipcRenderer.invoke('window:attachToTeams'),
  detachFromTeams: () => ipcRenderer.invoke('window:detachFromTeams'),
  getAttachStatus: () => ipcRenderer.invoke('window:getAttachStatus'),
  setWindowMode: (payload) => ipcRenderer.invoke('window:setMode', payload),
  calendarSetConfig: (payload) => ipcRenderer.invoke('calendar:setConfig', payload),
  calendarGetStatus: () => ipcRenderer.invoke('calendar:getStatus'),
  calendarConnectMicrosoft: () => ipcRenderer.invoke('calendar:connectMicrosoft'),
  calendarGetUpcomingMeetings: (payload) => ipcRenderer.invoke('calendar:getUpcomingMeetings', payload),
  calendarCreateOnlineMeeting: (payload) => ipcRenderer.invoke('calendar:createOnlineMeeting', payload),
  calendarDisconnectMicrosoft: () => ipcRenderer.invoke('calendar:disconnectMicrosoft'),
  authGetState: () => ipcRenderer.invoke('auth:getState'),
  authSignOut: () => ipcRenderer.invoke('auth:signOut'),
  googleConnect: () => ipcRenderer.invoke('google:connect'),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  googleGetStatus: () => ipcRenderer.invoke('google:getStatus'),
  googleGetUpcomingMeetings: (payload) => ipcRenderer.invoke('google:getUpcomingMeetings', payload),
  openPrivacySettings: (payload) => ipcRenderer.invoke('system:openPrivacySettings', payload),
  openExternalUrl: (payload) => ipcRenderer.invoke('system:openExternalUrl', payload),
  clearPreferredCaptureSource: () => ipcRenderer.invoke('capture:clear-preferred-source'),
  getPreferredCaptureSource: () => ipcRenderer.invoke('capture:get-preferred-source'),
  onDeepLinkStart: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("deeplink:start", wrapped);
    return () => ipcRenderer.removeListener("deeplink:start", wrapped);
  }
});
