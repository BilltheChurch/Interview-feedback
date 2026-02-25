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
  finalizeV2(payload: { baseUrl: string; sessionId: string; metadata?: Record<string, unknown>; mode?: 'full' | 'report-only' }): Promise<unknown>;
  getFinalizeStatus(payload: { baseUrl: string; sessionId: string; jobId?: string }): Promise<unknown>;
  getTier2Status(payload: { baseUrl: string; sessionId: string }): Promise<unknown>;
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
  calendarCreateOnlineMeeting(payload: {
    subject: string;
    startAt?: string;
    endAt?: string;
    participants?: { name: string; email?: string }[];
  }): Promise<{
    source: string;
    meeting_id: string;
    title: string;
    start_at: string;
    end_at: string;
    join_url: string;
    meeting_code: string;
    passcode: string;
    participants: { name: string; email?: string }[];
  }>;
  calendarCreateCalendarEvent(payload: {
    subject: string;
    startAt: string;
    endAt: string;
    timeZone?: string;
    participants?: { name: string; email?: string }[];
  }): Promise<{
    source: string;
    meeting_id: string;
    title: string;
    start_at: string;
    end_at: string;
    join_url: string;
    meeting_code: string;
    passcode: string;
    participants: { name: string; email?: string }[];
    web_link: string;
  }>;
  calendarDisconnectMicrosoft(): Promise<unknown>;
  authGetState(): Promise<{
    microsoft: { connected: boolean; account: { username?: string; home_account_id?: string; tenant_id?: string } | null };
    google: { connected: boolean; account: { email?: string } | null };
  }>;
  authSignOut(): Promise<{ ok: boolean; errors: string[] }>;
  googleConnect(): Promise<{ connected: boolean; account: { email?: string } }>;
  googleDisconnect(): Promise<{ connected: boolean }>;
  googleGetStatus(): Promise<{ configured: boolean; connected: boolean; account: { email?: string } | null }>;
  googleGetUpcomingMeetings(payload?: { days?: number }): Promise<unknown>;
  openPrivacySettings(payload?: { target?: string }): Promise<unknown>;
  openExternalUrl(payload: { url: string }): Promise<unknown>;
  clearPreferredCaptureSource(): Promise<unknown>;
  getPreferredCaptureSource(): Promise<unknown>;
  getWorkerApiKey(): Promise<string | undefined>;
  copyToClipboard(text: string): Promise<{ ok: boolean }>;
  enrollSpeaker?(payload: { sessionId: string; speakerName: string }): Promise<{ success: boolean; confidence?: number }>;
  onDeepLinkStart(listener: (payload: unknown) => void): () => void;
  onBeforeQuit(listener: () => void): () => void;

  // Secure credential storage (Electron safeStorage / macOS Keychain)
  secureStore?(payload: { key: string; value: string }): Promise<void>;
  secureRetrieve?(payload: { key: string }): Promise<string | null>;
  secureDelete?(payload: { key: string }): Promise<void>;

  // Export PDF (hidden-window approach: renderer passes print-optimized HTML)
  exportPDF(options?: { sessionName?: string; html?: string }): Promise<{ success: boolean; path?: string }>;

  // ACS Caption
  acsGetEnabled(): Promise<boolean>;
  acsGetToken(): Promise<{
    ok: boolean;
    token?: string;
    expiresOn?: string;
    userId?: string;
    error?: string;
  }>;

  // ── DualSync Integration (预留接口，Phase 2 实现) ──
  // getUpcomingGroupSessions?(): Promise<GroupSession[]>;
  // importGroupSession?(sessionId: string): Promise<SessionImport>;
}

/** DualSync group session (Phase 2 integration) */
export interface GroupSession {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  participants: { name: string; email?: string }[];
  teamsJoinUrl?: string;
  status: 'confirmed' | 'pending';
  source: 'dualsync' | 'manual';
}

/** Session import payload from DualSync (Phase 2 integration) */
export interface SessionImport {
  sessionName: string;
  mode: '1v1' | 'group';
  participants: { name: string; email?: string }[];
  teamsJoinUrl: string;
  meetingCode?: string;
  passcode?: string;
}


/** Dimension preset item for interview evaluation */
export interface DimensionPresetItem {
  key: string;
  label_zh: string;
  label_en: string;
  description: string;
  weight: number;
}

declare global {
  interface Window {
    desktopAPI: DesktopAPI;
  }
}

export {};
