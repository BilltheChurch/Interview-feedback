import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore';

function getStore() {
  return useSessionStore.getState();
}

describe('sessionStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useSessionStore.setState({
      status: 'idle',
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
