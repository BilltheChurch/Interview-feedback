import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence } from 'motion/react';
import { motion } from 'motion/react';
import { RichNoteEditor, type RichNoteEditorRef } from '../components/RichNoteEditor';
import { useSessionStore } from '../stores/sessionStore';
import type { MemoType } from '../stores/sessionStore';
import { useSessionOrchestrator } from '../hooks/useSessionOrchestrator';
import { CaptionPanel } from '../components/CaptionPanel';

import { SidecarHeader } from '../components/sidecar/SidecarHeader';
import { StageProgressBar } from '../components/sidecar/StageProgressBar';
import {
  QuickMarkBar,
  FlyingMemo,
  MemoTray,
  MemoNotepadOverlay,
  memoShortcutOrder,
} from '../components/sidecar/MemoPanel';
import { StageTimeline } from '../components/sidecar/StageControls';
import { ContextDrawer } from '../components/sidecar/ContextDrawer';
import {
  defaultStages,
  type DisplayMemo,
  type Participant,
  type ParticipantStatus,
  type IncrementalBadgeStatus,
} from '../components/sidecar/types';

/* ─── SidecarView (main export) ──────────────── */

export function SidecarView() {
  const location = useLocation();
  const locationState = location.state as {
    sessionId?: string;
    sessionName?: string;
    mode?: string;
    participants?: string[];
    stages?: string[];
  } | null;

  // ── Store selectors ──
  const sessionTimer = useSessionStore((s) => s.elapsedSeconds);
  const storeMemos = useSessionStore((s) => s.memos);
  const currentStage = useSessionStore((s) => s.currentStage);
  const audioLevels = useSessionStore((s) => s.audioLevels);
  const storeAddMemo = useSessionStore((s) => s.addMemo);
  const advanceStage = useSessionStore((s) => s.advanceStage);
  const storeAddStageArchive = useSessionStore((s) => s.addStageArchive);
  const storeStageArchives = useSessionStore((s) => s.stageArchives);
  const storeSetNotes = useSessionStore((s) => s.setNotes);
  const storeStages = useSessionStore((s) => s.stages);
  const storeSessionName = useSessionStore((s) => s.sessionName);
  const storeSessionId = useSessionStore((s) => s.sessionId);
  const acsStatus = useSessionStore((s) => s.acsStatus);
  const acsCaptionCount = useSessionStore((s) => s.acsCaptionCount);
  const captions = useSessionStore((s) => s.captions);

  const { end } = useSessionOrchestrator();

  // Derive display values
  const sessionId = storeSessionId || locationState?.sessionId || `sess_${Date.now()}`;
  const sessionDisplayName = storeSessionName || locationState?.sessionName || 'Interview Session';
  const stages = storeStages.length > 0
    ? storeStages
    : (locationState?.stages && locationState.stages.length > 0 ? locationState.stages : defaultStages);

  // Build participant list from locationState only (no mock data)
  const initialParticipants: Participant[] = [
    ...(locationState?.participants || []).map(name => ({
      name,
      status: 'pending' as ParticipantStatus,
      talkTimePct: 0,
      turnCount: 0,
    })),
    ...(locationState?.participants && locationState.participants.length > 0
      ? [{ name: 'Interviewer', status: 'matched' as ParticipantStatus, confidence: 1.0, talkTimePct: 0, turnCount: 0 }]
      : []),
  ];

  const baseApiUrl = useSessionStore((s) => s.baseApiUrl);

  // ── Incremental processing status polling ──
  const [incrementalStatus, setIncrementalStatus] = useState<{
    status: IncrementalBadgeStatus;
    speakersDetected: number;
    incrementsCompleted: number;
    stableSpeakerMap: boolean;
  } | undefined>(undefined);

  useEffect(() => {
    if (!baseApiUrl || !storeSessionId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await window.desktopAPI.getIncrementalStatus({
          baseUrl: baseApiUrl,
          sessionId: storeSessionId,
        });
        if (cancelled) return;
        if (result && result.enabled) {
          setIncrementalStatus({
            status: result.status,
            speakersDetected: result.speakers_detected,
            incrementsCompleted: result.increments_completed,
            stableSpeakerMap: result.stable_speaker_map,
          });
        }
      } catch {
        // Incremental status not available — ignore silently
      }
    };

    const timer = setInterval(poll, 5000);
    poll(); // Initial check
    return () => { cancelled = true; clearInterval(timer); };
  }, [baseApiUrl, storeSessionId]);

  // ── UI-only local state ──
  const [notes, setNotes] = useState('');
  const [plainText, setPlainText] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [memosVisible, setMemosVisible] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>(initialParticipants);
  const [openMemoId, setOpenMemoId] = useState<string | null>(null);
  const [flyingMemo, setFlyingMemo] = useState<{
    type: MemoType;
    startRect: DOMRect;
  } | null>(null);
  const [pulsingMemoType, setPulsingMemoType] = useState<MemoType | null>(null);
  const [showMemoHint, setShowMemoHint] = useState(false);

  const editorRef = useRef<RichNoteEditorRef>(null);
  const memoTrayRef = useRef<HTMLDivElement>(null);
  const quickMarkButtonRefs = useRef<Map<MemoType, HTMLElement>>(new Map());
  const enrollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Audio activity indicator
  const audioActive = audioLevels.mic > 0.05 || audioLevels.system > 0.05;

  // Cleanup enrollment timers on unmount
  useEffect(() => {
    return () => {
      enrollTimersRef.current.forEach(timer => clearTimeout(timer));
      enrollTimersRef.current.clear();
    };
  }, []);

  // ── Local audio-level-based talk time accumulation ──
  const storeStatus = useSessionStore((s) => s.status);
  const storeMicActive = useSessionStore((s) => s.micActiveSeconds);
  const storeSysActive = useSessionStore((s) => s.sysActiveSeconds);
  const micTimeRef = useRef(storeMicActive);
  const sysTimeRef = useRef(storeSysActive);

  // Re-seed refs when store values change (e.g. after restoreSession)
  useEffect(() => {
    micTimeRef.current = storeMicActive;
    sysTimeRef.current = storeSysActive;
  }, [storeMicActive, storeSysActive]);

  useEffect(() => {
    if (storeStatus !== 'recording') {
      return;
    }

    const THRESHOLD = 1;

    const interval = setInterval(() => {
      const store = useSessionStore.getState();
      const levels = store.audioLevels;
      if (levels.mic > THRESHOLD) micTimeRef.current++;
      if (levels.system > THRESHOLD) sysTimeRef.current++;

      store.setMicActiveSeconds(micTimeRef.current);
      store.setSysActiveSeconds(sysTimeRef.current);

      const micT = micTimeRef.current;
      const sysT = sysTimeRef.current;
      const total = micT + sysT;
      if (total === 0) return;

      setParticipants(prev => {
        if (prev.length === 0) return prev;
        const others = prev.filter(pp => pp.name !== 'Interviewer').length;
        return prev.map(p => {
          if (p.name === 'Interviewer') {
            return { ...p, talkTimePct: Math.round((micT / total) * 100), turnCount: micT };
          }
          if (sysT === 0 || others === 0) {
            return { ...p, talkTimePct: 0, turnCount: 0 };
          }
          const share = Math.round((sysT / total / others) * 100);
          return { ...p, talkTimePct: share, turnCount: Math.round(sysT / others) };
        });
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [storeStatus]);

  // Enrich store memos with stage name for display
  const memos: DisplayMemo[] = useMemo(
    () => storeMemos.map((m) => ({
      id: m.id,
      type: m.type,
      text: m.text,
      timestamp: m.timestamp,
      stage: stages[m.stageIndex] ?? 'Unknown',
      createdAt: m.createdAt,
    })),
    [storeMemos, stages],
  );

  // Save memo — applies colored highlight to text, keeps text in editor
  const addMemo = useCallback(
    (type: MemoType, buttonRect?: DOMRect) => {
      const selectedText = editorRef.current?.getSelectedText()?.trim() ?? '';
      const text = selectedText || plainText.trim();
      if (!text) return;

      const memoId = `memo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (buttonRect) {
        setFlyingMemo({ type, startRect: buttonRect });
      }
      setMemosVisible(true);

      storeAddMemo(type, text.slice(0, 200));

      editorRef.current?.applyMemoMark(type, memoId);

      const html = editorRef.current?.getHTML() ?? '';
      storeSetNotes(html);
    },
    [plainText, storeAddMemo, storeSetNotes],
  );

  // Auto-archive on stage advance
  const handleAdvanceStage = useCallback(() => {
    const store = useSessionStore.getState();
    const freeformText = editorRef.current?.getText()?.trim() ?? '';
    const freeformHtml = editorRef.current?.getHTML() ?? store.notes;

    const stageMemoIds = store.memos
      .filter((m) => m.stageIndex === store.currentStage)
      .map((m) => m.id);

    if (freeformText || stageMemoIds.length > 0) {
      storeAddStageArchive({
        stageIndex: store.currentStage,
        stageName: stages[store.currentStage] ?? `Stage ${store.currentStage + 1}`,
        archivedAt: new Date().toISOString(),
        freeformText,
        freeformHtml: freeformHtml || undefined,
        memoIds: stageMemoIds,
      });
    }

    editorRef.current?.clearContent();
    setPlainText('');
    setNotes('');
    storeSetNotes('');

    advanceStage();
  }, [advanceStage, storeAddStageArchive, stages, storeSetNotes]);

  // Sync notes to store
  const handleNotesChange = useCallback(
    (html: string) => {
      setNotes(html);
      storeSetNotes(html);
    },
    [storeSetNotes],
  );

  // Keyboard shortcuts: Cmd+1/2/3/4 for quick marks
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < memoShortcutOrder.length) {
        e.preventDefault();
        const type = memoShortcutOrder[idx];

        setPulsingMemoType(type);
        setTimeout(() => setPulsingMemoType(null), 400);

        const el = quickMarkButtonRefs.current.get(type);
        const buttonRect = el?.getBoundingClientRect();

        const hasSelection = !!(editorRef.current?.getSelectedText()?.trim());
        if (hasSelection || plainText.trim()) {
          addMemo(type, buttonRect);
        } else {
          setShowMemoHint(true);
          setTimeout(() => setShowMemoHint(false), 1500);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [addMemo, plainText]);

  // Enrollment handlers
  const handleEnroll = useCallback(async (name: string) => {
    setParticipants(prev => prev.map(p =>
      p.name === name ? { ...p, status: 'capturing' as ParticipantStatus } : p
    ));

    try {
      if (window.desktopAPI?.enrollSpeaker) {
        const result = await window.desktopAPI.enrollSpeaker({
          sessionId,
          speakerName: name,
        });
        setParticipants(prev => prev.map(p =>
          p.name === name ? {
            ...p,
            status: result.success ? 'needs_confirm' as ParticipantStatus : 'not_enrolled' as ParticipantStatus,
            confidence: result.confidence ?? 0,
          } : p
        ));
      } else {
        const timer = setTimeout(() => {
          setParticipants(prev => prev.map(p =>
            p.name === name ? { ...p, status: 'needs_confirm' as ParticipantStatus, confidence: 0.85 } : p
          ));
        }, 2000);
        enrollTimersRef.current.set(name, timer);
      }
    } catch (error) {
      console.error('Enrollment failed:', error);
      setParticipants(prev => prev.map(p =>
        p.name === name ? { ...p, status: 'not_enrolled' as ParticipantStatus } : p
      ));
    }
  }, [sessionId]);

  const handleConfirm = useCallback((name: string) => {
    setParticipants(prev => prev.map(p =>
      p.name === name ? { ...p, status: 'matched' as ParticipantStatus } : p
    ));
  }, []);

  // End session — archive current stage first to preserve freeform notes
  const handleEndSession = useCallback(() => {
    const store = useSessionStore.getState();
    const freeformText = editorRef.current?.getText()?.trim() ?? '';
    const freeformHtml = editorRef.current?.getHTML() ?? store.notes;
    const stageMemoIds = store.memos
      .filter((m) => m.stageIndex === store.currentStage)
      .map((m) => m.id);
    if (freeformText || stageMemoIds.length > 0) {
      store.addStageArchive({
        stageIndex: store.currentStage,
        stageName: stages[store.currentStage] ?? `Stage ${store.currentStage + 1}`,
        archivedAt: new Date().toISOString(),
        freeformText,
        freeformHtml: freeformHtml || undefined,
        memoIds: stageMemoIds,
      });
    }

    try {
      const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
      const updated = sessions.map((s: Record<string, unknown>) =>
        s.id === sessionId ? { ...s, status: 'draft' } : s
      );
      localStorage.setItem('ifb_sessions', JSON.stringify(updated));
    } catch { /* ignore parse errors */ }

    end();
  }, [end, sessionId, stages]);

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Header */}
      <SidecarHeader
        elapsed={sessionTimer}
        sessionName={sessionDisplayName}
        audioActive={audioActive}
        currentStage={currentStage}
        stages={stages}
        acsStatus={acsStatus}
        acsCaptionCount={acsCaptionCount}
        incrementalStatus={incrementalStatus}
        onEndSession={handleEndSession}
      />

      {/* Thin stage progress bar */}
      <StageProgressBar currentStage={currentStage} stages={stages} />

      {/* Body */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Caption panel — left side, conditional on ACS status */}
        <CaptionPanel captions={captions} acsStatus={acsStatus} />

        {/* Notes workspace */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Notes editor */}
          <RichNoteEditor
            ref={editorRef}
            content={notes}
            onContentChange={handleNotesChange}
            onPlainTextChange={setPlainText}
            placeholder="Type your notes here..."
            className="flex-1"
            autoFocus
          />

          {/* Stage timeline — archived notes from previous stages */}
          <StageTimeline archives={storeStageArchives} allMemos={memos} />

          {/* Collapsible memo tray */}
          <AnimatePresence>
            {memosVisible && (
              <MemoTray ref={memoTrayRef} memos={memos} onOpenMemo={(id) => setOpenMemoId(id)} />
            )}
          </AnimatePresence>

          {/* Memo hint toast */}
          <AnimatePresence>
            {showMemoHint && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                className="px-3 py-1.5 text-xs text-ink-secondary bg-surface-hover border-t border-border text-center"
              >
                Type notes first, then use Cmd+1-4 to capture
              </motion.div>
            )}
          </AnimatePresence>

          {/* Quick mark bar */}
          <QuickMarkBar
            onMark={addMemo}
            memoCount={memos.length}
            onToggleMemos={() => setMemosVisible(v => !v)}
            memosVisible={memosVisible}
            buttonRefsMap={quickMarkButtonRefs}
            pulsingType={pulsingMemoType}
          />
        </div>

        {/* Context drawer — right rail */}
        <ContextDrawer
          open={drawerOpen}
          onToggle={() => setDrawerOpen((v) => !v)}
          currentStage={currentStage}
          onAdvanceStage={handleAdvanceStage}
          participants={participants}
          onEnroll={handleEnroll}
          onConfirm={handleConfirm}
          stages={stages}
          audioLevels={audioLevels}
        />

        {/* Memo notepad overlay */}
        <AnimatePresence>
          {openMemoId && (() => {
            const memo = memos.find((m) => m.id === openMemoId);
            if (!memo) return null;
            return (
              <MemoNotepadOverlay
                memo={memo}
                memos={memos}
                onClose={() => setOpenMemoId(null)}
                onNavigate={(id) => setOpenMemoId(id)}
              />
            );
          })()}
        </AnimatePresence>

        {/* Flying memo animation */}
        <AnimatePresence>
          {flyingMemo && (() => {
            const trayRect = memoTrayRef.current?.getBoundingClientRect();
            if (!trayRect) {
              const fallbackRect = new DOMRect(
                window.innerWidth - 200,
                window.innerHeight - 150,
                100,
                100
              );
              return (
                <FlyingMemo
                  type={flyingMemo.type}
                  startRect={flyingMemo.startRect}
                  endRect={fallbackRect}
                  onComplete={() => setFlyingMemo(null)}
                />
              );
            }
            return (
              <FlyingMemo
                type={flyingMemo.type}
                startRect={flyingMemo.startRect}
                endRect={trayRect}
                onComplete={() => setFlyingMemo(null)}
              />
            );
          })()}
        </AnimatePresence>
      </div>
    </div>
  );
}
