import { create } from 'zustand';
import type { DimensionPresetItem } from '../lib/dimensionPresets';

/* ── Types ─────────────────────────────────── */

export type MemoType = 'highlight' | 'issue' | 'question' | 'evidence';
export type MemoAnchorMode = 'time' | 'utterance';

export type Memo = {
  id: string;
  type: MemoType;
  text: string;
  tags: string[];
  timestamp: number;
  stageIndex: number;
  anchor?: {
    mode: MemoAnchorMode;
    ref_id?: string;
    time_ms?: number;
  };
  createdAt: Date;
};

export type Participant = {
  name: string;
  speakerId?: string;
  status?: 'pending' | 'active' | 'left';
};

export type AudioLevels = {
  mic: number;
  system: number;
  mixed: number;
};

export type WebSocketStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export type StreamRole = 'teacher' | 'students';

/** Classification of a system-audio capture failure (null = ok / not attempted). */
export type SystemAudioFailureReason = 'permission' | 'no-track' | 'other' | null;

export type AcsStatus = 'off' | 'connecting' | 'connected' | 'receiving' | 'error';

export type CaptionEntry = {
  id: string;
  speaker: string;
  text: string;
  timestamp: number;
  language: string;
};

const MAX_CAPTIONS = 200;

/** A2: realtime transcript segment pushed from the Worker over the ingest WS.
 *  Universal (works for any STT provider), unlike CaptionEntry which is ACS/Teams-only. */
export type TranscriptSegment = {
  id: string;
  role: StreamRole;
  speaker: string | null;
  text: string;
  isFinal: boolean;
  tsMs: number;
  startMs: number;
  createdAt: number;
};

const MAX_TRANSCRIPT_SEGMENTS = 1000;

/** R4: an in-progress (unfinalized) transcript line for one stream. Speechmatics streams
 *  partials as the cumulative text of the current utterance; we keep at most one per stream
 *  (keyed by role) and replace it in place until the matching final lands. Purely a UI
 *  transient — never persisted, never part of transcriptSegments, never exported. */
export type PartialTranscript = {
  role: StreamRole;
  speaker: string | null;
  text: string;
};

export type SessionStatus =
  | 'idle'
  | 'setup'
  | 'recording'
  | 'feedback_draft'
  | 'feedback_final';

export type StageArchive = {
  stageIndex: number;
  stageName: string;
  archivedAt: string;
  freeformText: string;
  freeformHtml?: string;
  memoIds: string[];
};

export type SessionConfig = {
  sessionId: string;
  sessionName: string;
  mode: '1v1' | 'group';
  participants: Participant[];
  stages: string[];
  baseApiUrl: string;
  interviewerName?: string;
  teamsInterviewerName?: string;
  teamsJoinUrl?: string;
  templateId?: string;
  interviewType?: string;
  dimensionPresets?: DimensionPresetItem[];
};

/* ── Persistence key & helpers ─────────────── */

const ACTIVE_SESSION_KEY = 'ifb_active_session';
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Serializable subset of session state that can be persisted & restored. */
export type PersistedSession = {
  sessionId: string;
  sessionName: string;
  mode: '1v1' | 'group';
  participants: Participant[];
  stages: string[];
  currentStage: number;
  startedAt: number;
  elapsedSeconds: number;
  baseApiUrl: string;
  interviewerName: string;
  teamsInterviewerName: string;
  teamsJoinUrl: string;
  templateId: string;
  interviewType?: string;
  dimensionPresets?: DimensionPresetItem[];
  memos: Memo[];
  notes: string;
  stageArchives: StageArchive[];
  micActiveSeconds: number;
  sysActiveSeconds: number;
  transcriptSegments: TranscriptSegment[];
  savedAt: number;
};

/** Read persisted active session from localStorage, if valid. */
export function getPersistedSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedSession;
    if (!data.sessionId || !data.startedAt) return null;
    // Discard sessions older than 24 hours
    if (Date.now() - data.savedAt > MAX_SESSION_AGE_MS) {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/** Clear persisted active session. */
export function clearPersistedSession(): void {
  localStorage.removeItem(ACTIVE_SESSION_KEY);
}

/* ── Store shape ───────────────────────────── */

interface SessionStore {
  // Session metadata
  sessionId: string | null;
  sessionName: string;
  mode: '1v1' | 'group';
  status: SessionStatus;
  participants: Participant[];
  stages: string[];
  currentStage: number;
  startedAt: number | null;
  baseApiUrl: string;
  interviewerName: string;
  teamsInterviewerName: string;
  teamsJoinUrl: string;
  templateId: string;
  /** Evaluation rubric: interview type chosen in Setup (drives scoring dimensions). */
  interviewType?: string;
  /** Evaluation rubric: scoring dimensions forwarded to the worker at finalize. */
  dimensionPresets?: DimensionPresetItem[];

  // Timer
  elapsedSeconds: number;

  // Audio
  audioLevels: AudioLevels;
  micReady: boolean;
  systemReady: boolean;
  isCapturing: boolean;
  audioError: string | null;
  /** Set when system audio capture fails; null when it succeeds or hasn't been attempted. */
  systemAudioFailureReason: SystemAudioFailureReason;

  // WebSocket
  wsStatus: Record<StreamRole, WebSocketStatus>;
  wsError: string | null;
  wsConnected: boolean;

  // ACS Caption
  acsStatus: AcsStatus;
  acsCaptionCount: number;
  captions: CaptionEntry[];

  // A2: universal realtime transcript segments (Worker downlink)
  transcriptSegments: TranscriptSegment[];

  // R4: in-progress (unfinalized) partial lines, keyed by stream role. A UI-only transient
  // that is upserted from Speechmatics partials and cleared when the matching final lands.
  partialTranscripts: Record<string, PartialTranscript>;

  // Finalization guard
  finalizeRequested: boolean;

  // Memos & Notes
  memos: Memo[];
  notes: string;
  stageArchives: StageArchive[];

  // Speaker activity (accumulated active seconds for talk-time calculation)
  micActiveSeconds: number;
  sysActiveSeconds: number;
  setMicActiveSeconds: (v: number) => void;
  setSysActiveSeconds: (v: number) => void;

  // Actions
  startSession: (config: SessionConfig) => void;
  endSession: () => void;
  restoreSession: (persisted: PersistedSession) => void;
  addMemo: (type: MemoType, text: string) => void;
  advanceStage: () => void;
  addStageArchive: (archive: StageArchive) => void;
  setNotes: (html: string) => void;
  tick: () => void;
  setAudioLevels: (levels: AudioLevels) => void;
  setAudioReady: (device: 'mic' | 'system', ready: boolean) => void;
  setAudioError: (error: string | null) => void;
  setSystemAudioFailureReason: (reason: SystemAudioFailureReason) => void;
  setIsCapturing: (capturing: boolean) => void;
  setWsStatus: (role: StreamRole, status: WebSocketStatus) => void;
  setWsError: (error: string | null) => void;
  setAcsStatus: (status: AcsStatus) => void;
  incrementAcsCaptionCount: () => void;
  addCaption: (entry: Omit<CaptionEntry, 'id'>) => void;
  appendTranscriptSegment: (segment: Omit<TranscriptSegment, 'id' | 'createdAt'>) => void;
  /** R4: upsert the in-progress partial line for a stream (keyed by role). */
  updatePartialTranscript: (partial: PartialTranscript) => void;
  setFinalizeRequested: (value: boolean) => void;
  reset: () => void;
}

/* ── Initial state ─────────────────────────── */

const INITIAL_STATE = {
  sessionId: null as string | null,
  sessionName: '',
  mode: '1v1' as const,
  status: 'idle' as SessionStatus,
  participants: [] as Participant[],
  stages: [] as string[],
  currentStage: 0,
  startedAt: null as number | null,
  baseApiUrl: '',
  interviewerName: '',
  teamsInterviewerName: '',
  teamsJoinUrl: '',
  templateId: '',
  interviewType: undefined as string | undefined,
  dimensionPresets: undefined as DimensionPresetItem[] | undefined,

  elapsedSeconds: 0,

  audioLevels: { mic: 0, system: 0, mixed: 0 } as AudioLevels,
  micReady: false,
  systemReady: false,
  isCapturing: false,
  audioError: null as string | null,
  systemAudioFailureReason: null as SystemAudioFailureReason,

  wsStatus: { teacher: 'disconnected', students: 'disconnected' } as Record<StreamRole, WebSocketStatus>,
  wsError: null as string | null,
  wsConnected: false,

  acsStatus: 'off' as AcsStatus,
  acsCaptionCount: 0,
  captions: [] as CaptionEntry[],
  transcriptSegments: [] as TranscriptSegment[],
  partialTranscripts: {} as Record<string, PartialTranscript>,

  finalizeRequested: false,

  memos: [] as Memo[],
  notes: '',
  stageArchives: [] as StageArchive[],
  micActiveSeconds: 0,
  sysActiveSeconds: 0,
};

/* ── Store ─────────────────────────────────── */

export const useSessionStore = create<SessionStore>()((set, get) => ({
  ...INITIAL_STATE,

  startSession: (config) =>
    set({
      sessionId: config.sessionId,
      sessionName: config.sessionName,
      mode: config.mode,
      status: 'recording',
      participants: config.participants,
      stages: config.stages,
      currentStage: 0,
      startedAt: Date.now(),
      baseApiUrl: config.baseApiUrl,
      interviewerName: config.interviewerName ?? '',
      teamsInterviewerName: config.teamsInterviewerName ?? '',
      teamsJoinUrl: config.teamsJoinUrl ?? '',
      templateId: config.templateId ?? '',
      interviewType: config.interviewType,
      dimensionPresets: config.dimensionPresets,
      elapsedSeconds: 0,
      memos: [],
      captions: [],
      transcriptSegments: [],
      partialTranscripts: {},
      notes: '',
      stageArchives: [],
      micActiveSeconds: 0,
      sysActiveSeconds: 0,
    }),

  endSession: () => {
    clearPersistedSession();
    set({ status: 'feedback_draft' });
  },

  restoreSession: (persisted) =>
    set({
      sessionId: persisted.sessionId,
      sessionName: persisted.sessionName,
      mode: persisted.mode,
      status: 'recording',
      participants: persisted.participants,
      stages: persisted.stages,
      currentStage: persisted.currentStage,
      startedAt: persisted.startedAt,
      baseApiUrl: persisted.baseApiUrl,
      interviewerName: persisted.interviewerName,
      teamsInterviewerName: persisted.teamsInterviewerName,
      teamsJoinUrl: persisted.teamsJoinUrl,
      templateId: persisted.templateId,
      interviewType: persisted.interviewType,
      dimensionPresets: persisted.dimensionPresets,
      elapsedSeconds: persisted.elapsedSeconds,
      memos: persisted.memos,
      notes: persisted.notes,
      stageArchives: persisted.stageArchives,
      micActiveSeconds: persisted.micActiveSeconds ?? 0,
      sysActiveSeconds: persisted.sysActiveSeconds ?? 0,
      transcriptSegments: persisted.transcriptSegments ?? [],
      // Partials are UI-only transients and are never persisted; start clean on restore.
      partialTranscripts: {},
    }),

  addMemo: (type, text) =>
    set((s) => ({
      memos: [
        ...s.memos,
        {
          id: `memo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type,
          text,
          tags: [],
          timestamp: s.elapsedSeconds,
          stageIndex: s.currentStage,
          createdAt: new Date(),
        },
      ],
    })),

  advanceStage: () =>
    set((s) => {
      const next = s.currentStage + 1;
      return next < s.stages.length ? { currentStage: next } : {};
    }),

  addStageArchive: (archive) =>
    set((s) => ({
      stageArchives: [...s.stageArchives, archive],
    })),

  setNotes: (html) => set({ notes: html }),

  tick: () => set((s) => ({ elapsedSeconds: s.elapsedSeconds + 1 })),

  setAudioLevels: (levels) => set({ audioLevels: levels }),

  setAudioReady: (device, ready) =>
    set(device === 'mic' ? { micReady: ready } : { systemReady: ready }),

  setAudioError: (error) => set({ audioError: error }),

  setSystemAudioFailureReason: (reason) => set({ systemAudioFailureReason: reason }),

  setIsCapturing: (capturing) => set({ isCapturing: capturing }),

  setWsStatus: (role, status) =>
    set((s) => {
      const next = { ...s.wsStatus, [role]: status };
      return {
        wsStatus: next,
        wsConnected: next.teacher === 'connected' && next.students === 'connected',
      };
    }),

  setWsError: (error) => set({ wsError: error }),

  setMicActiveSeconds: (v) => set({ micActiveSeconds: v }),
  setSysActiveSeconds: (v) => set({ sysActiveSeconds: v }),

  setAcsStatus: (status) => set({ acsStatus: status }),
  incrementAcsCaptionCount: () => set((s) => ({ acsCaptionCount: s.acsCaptionCount + 1 })),

  addCaption: (entry) =>
    set((s) => {
      const id = `cap_${entry.timestamp}_${s.captions.length}`;
      const next = [...s.captions, { ...entry, id }];
      return { captions: next.length > MAX_CAPTIONS ? next.slice(-MAX_CAPTIONS) : next };
    }),

  appendTranscriptSegment: (segment) =>
    set((s) => {
      const id = `ts_${segment.role}_${segment.tsMs}_${s.transcriptSegments.length}`;
      const next = [...s.transcriptSegments, { ...segment, id, createdAt: Date.now() }];
      // A final for this stream supersedes its in-progress partial line — drop it so the
      // Desktop never shows the partial and its final side by side (duplicate text).
      const partialTranscripts = { ...s.partialTranscripts };
      delete partialTranscripts[segment.role];
      return {
        transcriptSegments:
          next.length > MAX_TRANSCRIPT_SEGMENTS ? next.slice(-MAX_TRANSCRIPT_SEGMENTS) : next,
        partialTranscripts,
      };
    }),

  updatePartialTranscript: (partial) =>
    set((s) => {
      const text = partial.text.trim();
      // Empty partial → clear the line rather than showing a blank row.
      if (!text) {
        if (!(partial.role in s.partialTranscripts)) return {};
        const partialTranscripts = { ...s.partialTranscripts };
        delete partialTranscripts[partial.role];
        return { partialTranscripts };
      }
      return {
        partialTranscripts: {
          ...s.partialTranscripts,
          [partial.role]: { ...partial, text },
        },
      };
    }),

  setFinalizeRequested: (value) => set({ finalizeRequested: value }),

  reset: () => {
    clearPersistedSession();
    set({ ...INITIAL_STATE });
  },
}));

/* ── Auto-save active session to localStorage ── */

const SAVE_INTERVAL_MS = 5_000; // throttle writes to every 5 seconds
let lastSaveAt = 0;

useSessionStore.subscribe((state) => {
  // Only persist while actively recording
  if (state.status !== 'recording' || !state.sessionId || !state.startedAt) return;

  const now = Date.now();
  if (now - lastSaveAt < SAVE_INTERVAL_MS) return;
  lastSaveAt = now;

  const snapshot: PersistedSession = {
    sessionId: state.sessionId,
    sessionName: state.sessionName,
    mode: state.mode,
    participants: state.participants,
    stages: state.stages,
    currentStage: state.currentStage,
    startedAt: state.startedAt,
    elapsedSeconds: state.elapsedSeconds,
    baseApiUrl: state.baseApiUrl,
    interviewerName: state.interviewerName,
    teamsInterviewerName: state.teamsInterviewerName,
    teamsJoinUrl: state.teamsJoinUrl,
    templateId: state.templateId,
    interviewType: state.interviewType,
    dimensionPresets: state.dimensionPresets,
    memos: state.memos,
    notes: state.notes,
    stageArchives: state.stageArchives,
    micActiveSeconds: state.micActiveSeconds,
    sysActiveSeconds: state.sysActiveSeconds,
    transcriptSegments: state.transcriptSegments,
    savedAt: now,
  };

  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full or unavailable — non-fatal
  }
});
