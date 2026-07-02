import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore, getPersistedSession } from './sessionStore';

function getStore() {
  return useSessionStore.getState();
}

describe('sessionStore', () => {
  beforeEach(() => {
    // Clear any persisted snapshot from a prior test so getPersistedSession()
    // reads only what the current test writes.
    localStorage.clear();
    // Reset store to initial state before each test
    useSessionStore.setState({
      status: 'idle',
      interviewType: undefined,
      dimensionPresets: undefined,
      sessionId: null,
      sessionName: '',
      mode: '1v1',
      participants: [],
      elapsedSeconds: 0,
      memos: [],
      stages: [],
      stageArchives: [],
      notes: '',
      currentStageIndex: 0,
      wsStatus: { teacher: 'disconnected', students: 'disconnected' },
      wsError: null,
      audioLevels: { mic: 0, system: 0, mixed: 0 },
      micReady: false,
      systemReady: false,
      isCapturing: false,
      audioError: null,
      finalizeRequested: false,
      acsStatus: 'off',
      acsCaptionCount: 0,
      captions: [],
      startedAt: null,
      baseApiUrl: '',
    });
  });

  it('starts in idle status', () => {
    expect(getStore().status).toBe('idle');
  });

  it('tick() increments elapsedSeconds', () => {
    expect(getStore().elapsedSeconds).toBe(0);
    getStore().tick();
    expect(getStore().elapsedSeconds).toBe(1);
    getStore().tick();
    expect(getStore().elapsedSeconds).toBe(2);
  });

  it('setAudioLevels updates audio levels', () => {
    getStore().setAudioLevels({ mic: 50, system: 30, mixed: 40 });
    const { audioLevels } = getStore();
    expect(audioLevels.mic).toBe(50);
    expect(audioLevels.system).toBe(30);
    expect(audioLevels.mixed).toBe(40);
  });

  it('setAudioReady updates mic and system ready flags', () => {
    getStore().setAudioReady('mic', true);
    expect(getStore().micReady).toBe(true);

    getStore().setAudioReady('system', true);
    expect(getStore().systemReady).toBe(true);

    getStore().setAudioReady('mic', false);
    expect(getStore().micReady).toBe(false);
  });

  it('setIsCapturing updates isCapturing flag', () => {
    getStore().setIsCapturing(true);
    expect(getStore().isCapturing).toBe(true);

    getStore().setIsCapturing(false);
    expect(getStore().isCapturing).toBe(false);
  });

  it('setAudioError stores error message', () => {
    getStore().setAudioError('Microphone init failed');
    expect(getStore().audioError).toBe('Microphone init failed');

    getStore().setAudioError(null);
    expect(getStore().audioError).toBeNull();
  });

  it('setWsStatus updates status for a given role', () => {
    getStore().setWsStatus('teacher', 'connected');
    expect(getStore().wsStatus.teacher).toBe('connected');

    getStore().setWsStatus('students', 'connecting');
    expect(getStore().wsStatus.students).toBe('connecting');
  });

  it('setWsError stores ws error message', () => {
    getStore().setWsError('teacher websocket error');
    expect(getStore().wsError).toBe('teacher websocket error');

    getStore().setWsError(null);
    expect(getStore().wsError).toBeNull();
  });

  it('setFinalizeRequested updates the flag', () => {
    getStore().setFinalizeRequested(true);
    expect(getStore().finalizeRequested).toBe(true);

    getStore().setFinalizeRequested(false);
    expect(getStore().finalizeRequested).toBe(false);
  });

  it('setAcsStatus updates ACS status', () => {
    getStore().setAcsStatus('connecting');
    expect(getStore().acsStatus).toBe('connecting');

    getStore().setAcsStatus('connected');
    expect(getStore().acsStatus).toBe('connected');
  });

  it('incrementAcsCaptionCount increments the count', () => {
    expect(getStore().acsCaptionCount).toBe(0);
    getStore().incrementAcsCaptionCount();
    getStore().incrementAcsCaptionCount();
    expect(getStore().acsCaptionCount).toBe(2);
  });

  it('addCaption adds an entry to captions', () => {
    getStore().addCaption({ speaker: 'Alice', text: 'Hello', timestamp: 1000, language: 'en' });
    const { captions } = getStore();
    expect(captions).toHaveLength(1);
    expect(captions[0].speaker).toBe('Alice');
    expect(captions[0].text).toBe('Hello');
  });

  it('startSession sets status to recording and stores config', () => {
    getStore().startSession({
      sessionId: 'sess_test',
      sessionName: 'Test Session',
      mode: 'group',
      participants: [{ name: 'Alice' }, { name: 'Bob' }],
      stages: ['Intro', 'Tech'],
      baseApiUrl: 'http://localhost:8787',
    });
    const store = getStore();
    expect(store.status).toBe('recording');
    expect(store.sessionId).toBe('sess_test');
    expect(store.sessionName).toBe('Test Session');
    expect(store.mode).toBe('group');
    expect(store.participants).toHaveLength(2);
  });

  it('startSession persists interviewType and dimensionPresets into the store', () => {
    const presets = [
      { key: 'leadership', label_zh: '领导力', label_en: 'Leadership', description: 'lead', weight: 1 },
      { key: 'communication', label_zh: '沟通', label_en: 'Communication', description: 'comm', weight: 1.5 },
    ];
    getStore().startSession({
      sessionId: 'sess_rubric',
      sessionName: 'Rubric Session',
      mode: '1v1',
      participants: [{ name: 'Alice' }],
      stages: ['Intro'],
      baseApiUrl: 'http://localhost:8787',
      interviewType: 'behavioral',
      dimensionPresets: presets,
    });
    const store = getStore();
    expect(store.interviewType).toBe('behavioral');
    expect(store.dimensionPresets).toEqual(presets);
  });

  it('startSession leaves interviewType/dimensionPresets undefined when not provided', () => {
    getStore().startSession({
      sessionId: 'sess_no_rubric',
      sessionName: 'No Rubric',
      mode: '1v1',
      participants: [],
      stages: [],
      baseApiUrl: 'http://localhost:8787',
    });
    const store = getStore();
    expect(store.interviewType).toBeUndefined();
    expect(store.dimensionPresets).toBeUndefined();
  });

  it('auto-save snapshot includes interviewType and dimensionPresets', () => {
    // The auto-save subscriber throttles writes to every 5s using Date.now()
    // (module-level lastSaveAt shared across tests). Drive the system clock far
    // forward so the throttle window is guaranteed to elapse, then mutate state
    // while recording so the subscriber fires and persists a fresh snapshot.
    // NOTE: test-setup.ts replaces localStorage with a plain-object mock, so we
    // read the actual persisted value via getPersistedSession() rather than
    // spying on Storage.prototype (which the mock never touches).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const presets = [
      { key: 'leadership', label_zh: '领导力', label_en: 'Leadership', description: 'lead', weight: 1 },
    ];
    getStore().startSession({
      sessionId: 'sess_snapshot',
      sessionName: 'Snapshot Session',
      mode: 'group',
      participants: [{ name: 'Alice' }],
      stages: ['Intro'],
      baseApiUrl: 'http://localhost:8787',
      interviewType: 'group',
      dimensionPresets: presets,
    });
    // Advance the clock past the 5s throttle, then mutate state so a write fires.
    vi.setSystemTime(new Date('2030-01-01T00:00:10Z'));
    getStore().tick();

    const snapshot = getPersistedSession();
    vi.useRealTimers();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.interviewType).toBe('group');
    expect(snapshot!.dimensionPresets).toEqual(presets);
  });

  it('endSession sets status to feedback_draft', () => {
    // endSession calls clearPersistedSession which uses localStorage.removeItem
    // Provide a minimal stub so it doesn't throw
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
    getStore().startSession({
      sessionId: 'sess_end',
      sessionName: 'End Test',
      mode: '1v1',
      participants: [{ name: 'Alice' }],
      stages: [],
      baseApiUrl: 'http://localhost:8787',
    });
    getStore().endSession();
    expect(getStore().status).toBe('feedback_draft');
    removeItemSpy.mockRestore();
  });

  it('reset() returns store to idle state', () => {
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
    getStore().startSession({
      sessionId: 'sess_reset',
      sessionName: 'Reset Test',
      mode: '1v1',
      participants: [{ name: 'Alice' }],
      stages: [],
      baseApiUrl: 'http://localhost:8787',
    });
    getStore().reset();
    const store = getStore();
    expect(store.status).toBe('idle');
    expect(store.sessionId).toBeNull();
    expect(store.elapsedSeconds).toBe(0);
    removeItemSpy.mockRestore();
  });
});

describe('sessionStore — A2 transcript downlink', () => {
  beforeEach(() => {
    useSessionStore.setState({ transcriptSegments: [] });
  });

  it('appendTranscriptSegment stores a segment with generated id + createdAt', () => {
    useSessionStore.getState().appendTranscriptSegment({
      role: 'students',
      speaker: 'S1',
      text: 'hello',
      isFinal: true,
      tsMs: 2000,
      startMs: 1000,
    });
    const segs = useSessionStore.getState().transcriptSegments;
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      role: 'students',
      speaker: 'S1',
      text: 'hello',
      isFinal: true,
      tsMs: 2000,
      startMs: 1000,
    });
    expect(segs[0].id).toBeTruthy();
    expect(typeof segs[0].createdAt).toBe('number');
  });

  it('preserves append order across multiple segments', () => {
    const store = useSessionStore.getState();
    store.appendTranscriptSegment({ role: 'teacher', speaker: null, text: 'one', isFinal: true, tsMs: 1000, startMs: 0 });
    store.appendTranscriptSegment({ role: 'students', speaker: 'S1', text: 'two', isFinal: true, tsMs: 2000, startMs: 1000 });
    expect(useSessionStore.getState().transcriptSegments.map((s) => s.text)).toEqual(['one', 'two']);
  });

  it('caps at 1000 segments, keeping the most recent', () => {
    const store = useSessionStore.getState();
    for (let i = 0; i < 1050; i++) {
      store.appendTranscriptSegment({
        role: 'students',
        speaker: 'S1',
        text: `seg-${i}`,
        isFinal: true,
        tsMs: i * 1000,
        startMs: (i - 1) * 1000,
      });
    }
    const segs = useSessionStore.getState().transcriptSegments;
    expect(segs).toHaveLength(1000);
    expect(segs[segs.length - 1].text).toBe('seg-1049');
    expect(segs[0].text).toBe('seg-50');
  });
});

describe('sessionStore — R4 live partial transcripts', () => {
  beforeEach(() => {
    localStorage.clear();
    useSessionStore.setState({ transcriptSegments: [], partialTranscripts: {} });
  });

  it('updatePartialTranscript inserts a partial line keyed by role', () => {
    useSessionStore.getState().updatePartialTranscript({
      role: 'students',
      speaker: 'S1',
      text: 'it was',
    });
    const { partialTranscripts } = useSessionStore.getState();
    expect(partialTranscripts.students).toEqual({ role: 'students', speaker: 'S1', text: 'it was' });
  });

  it('updatePartialTranscript upserts (replaces) the same role in place', () => {
    const store = useSessionStore.getState();
    store.updatePartialTranscript({ role: 'students', speaker: 'S1', text: 'it' });
    store.updatePartialTranscript({ role: 'students', speaker: 'S1', text: 'it was good' });
    const { partialTranscripts } = useSessionStore.getState();
    expect(Object.keys(partialTranscripts)).toEqual(['students']);
    expect(partialTranscripts.students.text).toBe('it was good');
  });

  it('keeps teacher and students partials independently (one per stream)', () => {
    const store = useSessionStore.getState();
    store.updatePartialTranscript({ role: 'teacher', speaker: null, text: 'how are you' });
    store.updatePartialTranscript({ role: 'students', speaker: 'S2', text: 'im great' });
    const { partialTranscripts } = useSessionStore.getState();
    expect(partialTranscripts.teacher.text).toBe('how are you');
    expect(partialTranscripts.students.text).toBe('im great');
  });

  it('trims whitespace and drops the line for empty partial text', () => {
    const store = useSessionStore.getState();
    store.updatePartialTranscript({ role: 'students', speaker: 'S1', text: '  hi  ' });
    expect(useSessionStore.getState().partialTranscripts.students.text).toBe('hi');
    store.updatePartialTranscript({ role: 'students', speaker: 'S1', text: '   ' });
    expect('students' in useSessionStore.getState().partialTranscripts).toBe(false);
  });

  it('appendTranscriptSegment (final) clears the matching partial line', () => {
    const store = useSessionStore.getState();
    store.updatePartialTranscript({ role: 'students', speaker: 'S1', text: 'it was goo' });
    expect(useSessionStore.getState().partialTranscripts.students).toBeDefined();
    store.appendTranscriptSegment({
      role: 'students',
      speaker: 'S1',
      text: 'it was good',
      isFinal: true,
      tsMs: 2000,
      startMs: 1000,
    });
    const state = useSessionStore.getState();
    expect('students' in state.partialTranscripts).toBe(false);
    // The final still lands as a persisted segment.
    expect(state.transcriptSegments.at(-1)?.text).toBe('it was good');
  });

  it('a final on one stream does not clear a partial on the other stream', () => {
    const store = useSessionStore.getState();
    store.updatePartialTranscript({ role: 'teacher', speaker: null, text: 'next question' });
    store.appendTranscriptSegment({
      role: 'students',
      speaker: 'S1',
      text: 'done',
      isFinal: true,
      tsMs: 1000,
      startMs: 0,
    });
    expect(useSessionStore.getState().partialTranscripts.teacher.text).toBe('next question');
  });

  it('reset() clears partialTranscripts', () => {
    const store = useSessionStore.getState();
    store.updatePartialTranscript({ role: 'students', speaker: 'S1', text: 'lingering' });
    store.reset();
    expect(useSessionStore.getState().partialTranscripts).toEqual({});
  });

  it('startSession clears partialTranscripts (partials never carry into a new session)', () => {
    const store = useSessionStore.getState();
    store.updatePartialTranscript({ role: 'students', speaker: 'S1', text: 'lingering' });
    expect(useSessionStore.getState().partialTranscripts.students).toBeDefined();
    store.startSession({
      sessionId: 'sess_new',
      sessionName: 'New Session',
      mode: '1v1',
      participants: [{ name: 'Alice' }],
      stages: ['Intro'],
      baseApiUrl: 'http://localhost:8787',
    });
    expect(useSessionStore.getState().partialTranscripts).toEqual({});
  });

  it('restoreSession clears partialTranscripts (partials are UI-only, never restored)', () => {
    const store = useSessionStore.getState();
    store.updatePartialTranscript({ role: 'teacher', speaker: null, text: 'lingering' });
    expect(useSessionStore.getState().partialTranscripts.teacher).toBeDefined();
    store.restoreSession({
      sessionId: 'sess_restored',
      sessionName: 'Restored',
      mode: '1v1',
      participants: [{ name: 'Dana' }],
      stages: ['Intro'],
      currentStage: 0,
      startedAt: Date.now(),
      elapsedSeconds: 42,
      baseApiUrl: 'http://localhost:8787',
      interviewerName: '',
      teamsInterviewerName: '',
      teamsJoinUrl: '',
      templateId: '',
      memos: [],
      notes: '',
      stageArchives: [],
      micActiveSeconds: 0,
      sysActiveSeconds: 0,
      transcriptSegments: [],
      savedAt: Date.now(),
    });
    expect(useSessionStore.getState().partialTranscripts).toEqual({});
  });
});

// ── R5: memo 卡与笔记 <mark> 的 id 关联（复审揪出的 id 分叉回归） ─────────────
// SidecarView.addMemo 生成一个 memoId，同时写进笔记的 <mark data-memo-id> 和
// store memo——两者必须是同一个 id，FeedbackView 才能按 id 对 memo 卡去重。
// 复审实证：此前 store.addMemo 内部自生成第二个随机 id，去重判定恒 false。
describe('addMemo id linking (R5)', () => {
  beforeEach(() => {
    useSessionStore.setState({ memos: [], elapsedSeconds: 0, currentStage: 0 } as never);
  });

  it('respects an explicit id so the note mark and the store memo stay linked', () => {
    const memoId = 'memo-1782960444888-ofk0n5';
    useSessionStore.getState().addMemo('highlight', '这次的caption还比较不错。', memoId);
    const memos = useSessionStore.getState().memos;
    expect(memos).toHaveLength(1);
    expect(memos[0].id).toBe(memoId);
  });

  it('still generates an id when none is passed (other call sites unchanged)', () => {
    useSessionStore.getState().addMemo('issue', 'note text');
    const memos = useSessionStore.getState().memos;
    expect(memos).toHaveLength(1);
    expect(memos[0].id).toMatch(/^memo-\d+-[a-z0-9]{6}$/);
  });
});
