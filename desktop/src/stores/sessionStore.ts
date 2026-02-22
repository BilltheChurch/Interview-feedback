import { create } from 'zustand';

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
};

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

  // Timer
  elapsedSeconds: number;

  // Audio
  audioLevels: AudioLevels;
  micReady: boolean;
  systemReady: boolean;
  isCapturing: boolean;
  audioError: string | null;

  // WebSocket
  wsStatus: Record<StreamRole, WebSocketStatus>;
  wsError: string | null;
  wsConnected: boolean;

  // Finalization guard
  finalizeRequested: boolean;

  // Memos & Notes
  memos: Memo[];
  notes: string;
  stageArchives: StageArchive[];

  // Actions
  startSession: (config: SessionConfig) => void;
  endSession: () => void;
  addMemo: (type: MemoType, text: string) => void;
  advanceStage: () => void;
  addStageArchive: (archive: StageArchive) => void;
  setNotes: (html: string) => void;
  tick: () => void;
  setAudioLevels: (levels: AudioLevels) => void;
  setAudioReady: (device: 'mic' | 'system', ready: boolean) => void;
  setAudioError: (error: string | null) => void;
  setIsCapturing: (capturing: boolean) => void;
  setWsStatus: (role: StreamRole, status: WebSocketStatus) => void;
  setWsError: (error: string | null) => void;
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

  elapsedSeconds: 0,

  audioLevels: { mic: 0, system: 0, mixed: 0 } as AudioLevels,
  micReady: false,
  systemReady: false,
  isCapturing: false,
  audioError: null as string | null,

  wsStatus: { teacher: 'disconnected', students: 'disconnected' } as Record<StreamRole, WebSocketStatus>,
  wsError: null as string | null,
  wsConnected: false,

  finalizeRequested: false,

  memos: [] as Memo[],
  notes: '',
  stageArchives: [] as StageArchive[],
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
      elapsedSeconds: 0,
      memos: [],
      notes: '',
      stageArchives: [],
    }),

  endSession: () =>
    set({ status: 'feedback_draft' }),

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

  setFinalizeRequested: (value) => set({ finalizeRequested: value }),

  reset: () => set({ ...INITIAL_STATE }),
}));
