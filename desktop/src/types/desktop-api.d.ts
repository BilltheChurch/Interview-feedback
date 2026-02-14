interface DesktopAPI {
  getAppInfo(): Promise<{
    appName: string;
    appVersion: string;
    electronVersion: string;
    chromeVersion: string;
    target: { sampleRate: number; channels: number; codec: string };
  }>;
  finalizeRecording(payload: { rawBytes: ArrayBuffer; mimeType: string; meetingId: string }): Promise<unknown>;
  normalizeFile(payload: { inputPath: string; meetingId?: string }): Promise<unknown>;
  pickFile(): Promise<{ canceled: boolean; filePath?: string }>;
  openPath(filePath: string): Promise<{ ok: boolean; error?: string }>;
  apiRequest(payload: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; text: string }>;
  finalizeV2(payload: { baseUrl: string; sessionId: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  getFinalizeStatus(payload: { baseUrl: string; sessionId: string; jobId?: string }): Promise<unknown>;
  getResultV2(payload: { baseUrl: string; sessionId: string }): Promise<unknown>;
  getFeedbackReady(payload: { baseUrl: string; sessionId: string }): Promise<unknown>;
  openFeedback(payload: { baseUrl: string; sessionId: string; body?: Record<string, unknown> }): Promise<unknown>;
  regenerateFeedbackClaim(payload: { baseUrl: string; sessionId: string; body?: Record<string, unknown> }): Promise<unknown>;
  updateFeedbackClaimEvidence(payload: { baseUrl: string; sessionId: string; body?: Record<string, unknown> }): Promise<unknown>;
  listSessionHistory(payload: { baseUrl: string; limit?: number; cursor?: string }): Promise<unknown>;
  exportFeedback(payload: { baseUrl: string; sessionId: string; body?: Record<string, unknown> }): Promise<unknown>;
  diarizationStart(payload?: Record<string, unknown>): Promise<unknown>;
  diarizationStop(): Promise<unknown>;
  diarizationGetStatus(): Promise<unknown>;
  diarizationPushChunk(payload: Record<string, unknown>): Promise<unknown>;
  attachToTeams(): Promise<unknown>;
  detachFromTeams(): Promise<unknown>;
  getAttachStatus(): Promise<unknown>;
  setWindowMode(payload: { mode: 'dashboard' | 'session' }): Promise<unknown>;
  calendarSetConfig(payload: { clientId: string; tenantId?: string }): Promise<unknown>;
  calendarGetStatus(): Promise<unknown>;
  calendarConnectMicrosoft(): Promise<unknown>;
  calendarGetUpcomingMeetings(payload?: { days?: number }): Promise<unknown>;
  calendarCreateOnlineMeeting(payload: { subject: string; startAt: string; endAt: string; participants?: unknown[] }): Promise<unknown>;
  calendarDisconnectMicrosoft(): Promise<unknown>;
  openPrivacySettings(payload?: { target?: string }): Promise<unknown>;
  openExternalUrl(payload: { url: string }): Promise<unknown>;
  clearPreferredCaptureSource(): Promise<unknown>;
  getPreferredCaptureSource(): Promise<unknown>;
  onDeepLinkStart(listener: (payload: unknown) => void): () => void;

  // Secure credential storage (Electron safeStorage / macOS Keychain)
  secureStore?(payload: { key: string; value: string }): Promise<void>;
  secureRetrieve?(payload: { key: string }): Promise<string | null>;
  secureDelete?(payload: { key: string }): Promise<void>;
}

declare global {
  interface Window {
    desktopAPI: DesktopAPI;
  }
}

export {};
