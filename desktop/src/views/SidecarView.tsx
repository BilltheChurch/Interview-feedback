import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence } from 'motion/react';
import { motion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { RichNoteEditor, type RichNoteEditorRef } from '../components/RichNoteEditor';
import { useSessionStore } from '../stores/sessionStore';
import type { MemoType } from '../stores/sessionStore';
import { useSessionOrchestrator } from '../hooks/useSessionOrchestrator';
import { CaptionPanel } from '../components/CaptionPanel';
import { ToastContainer } from '../components/Toast';
import { useToast } from '../hooks/useToast';

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
import {
  isSpeechActive,
  MIC_ACTIVITY_LEVEL_THRESHOLD,
  SYSTEM_ACTIVITY_LEVEL_THRESHOLD,
} from '../components/sidecar/speechActivity';
import type { SystemAudioFailureReason } from '../stores/sessionStore';

/* ─── System audio warning copy ──────────────── */

/**
 * Single source of truth for the system-audio failure warning text, shared by
 * both the persistent banner and the one-shot toast so they never diverge.
 */
function getSystemAudioHint(reason: SystemAudioFailureReason): {
  title: string;
  message: string;
} {
  const title = 'System audio not captured';
  switch (reason) {
    case 'permission':
      return {
        title,
        message:
          'Grant Screen Recording permission in System Settings → Privacy & Security → Screen Recording, then retry.',
      };
    case 'no-track':
      return {
        title,
        message: 'Enable "Share audio" in the screen picker, then retry.',
      };
    default:
      return { title, message: 'Student speech will not be recorded.' };
  }
}

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
  const transcriptSegments = useSessionStore((s) => s.transcriptSegments);
  const partialTranscripts = useSessionStore((s) => s.partialTranscripts);
  const storeParticipants = useSessionStore((s) => s.participants);
  const interviewerName = useSessionStore((s) => s.interviewerName);
  const systemReady = useSessionStore((s) => s.systemReady);
  const systemAudioFailureReason = useSessionStore((s) => s.systemAudioFailureReason);
  const isCapturing = useSessionStore((s) => s.isCapturing);

  const { end } = useSessionOrchestrator();
  const { toasts, toast, dismiss } = useToast();

  // Derive display values
  const sessionId = storeSessionId || locationState?.sessionId || `sess_${Date.now()}`;
  const sessionDisplayName = storeSessionName || locationState?.sessionName || 'Interview Session';
  const stages = storeStages.length > 0
    ? storeStages
    : (locationState?.stages && locationState.stages.length > 0 ? locationState.stages : defaultStages);

  // ── Build the participant roster (Bug A) ──
  // Source of truth is the STORE, not the router location state: in 1v1 and after a
  // PiP round-trip the store still holds the roster while location.state is empty or
  // stale. Fall back to location.state only when the store roster is empty.
  // The candidate names (students) come from the roster; the interviewer row is ALWAYS
  // present (even with an empty roster, so 1v1 shows at least the interviewer + any
  // candidate) and carries the configured interviewer real name (Bug B name fix). The
  // `isInterviewer` flag — not the display name — is the stable branch key downstream.
  const candidateNames: string[] =
    storeParticipants.length > 0
      ? storeParticipants.map((p) => p.name)
      : (locationState?.participants || []);
  const interviewerDisplayName = (interviewerName || '').trim() || 'Interviewer';
  const initialParticipants: Participant[] = [
    {
      name: interviewerDisplayName,
      status: 'matched' as ParticipantStatus,
      confidence: 1.0,
      talkTimePct: 0,
      turnCount: 0,
      isInterviewer: true,
    },
    ...candidateNames.map((name) => ({
      name,
      status: 'pending' as ParticipantStatus,
      talkTimePct: 0,
      turnCount: 0,
      isInterviewer: false,
    })),
  ];

  const baseApiUrl = useSessionStore((s) => s.baseApiUrl);

  // ── System audio failure toast — fire once when capture starts without system audio ──
  const systemWarningFiredRef = useRef(false);
  useEffect(() => {
    if (!isCapturing) {
      // Reset so the warning can re-fire if the user stops/restarts
      systemWarningFiredRef.current = false;
      return;
    }
    if (systemReady || systemWarningFiredRef.current) return;
    systemWarningFiredRef.current = true;

    const { title, message } = getSystemAudioHint(systemAudioFailureReason);
    toast(`${title} — ${message}`, 'warning');
  }, [isCapturing, systemReady, systemAudioFailureReason, toast]);

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

  // Audio activity indicator — audioLevels are 0–100 (see readRmsLevel), so we
  // reuse the same per-stream silence gates as talk-time accumulation instead of
  // an out-of-scale 0–1 threshold that treated the noise floor as "active". The
  // mic uses the lower gate (noise-suppressed soft speech), system the R7 gate.
  const audioActive =
    isSpeechActive(audioLevels.mic, MIC_ACTIVITY_LEVEL_THRESHOLD) ||
    isSpeechActive(audioLevels.system, SYSTEM_ACTIVITY_LEVEL_THRESHOLD);

  // Cleanup enrollment timers on unmount
  useEffect(() => {
    return () => {
      enrollTimersRef.current.forEach(timer => clearTimeout(timer));
      enrollTimersRef.current.clear();
    };
  }, []);

  // ── Roster sync (Bug A) ──
  // Keep the enrollment-carrying `participants` state in sync with the store roster +
  // interviewer name, which may arrive late (1v1) or change after a PiP round-trip. We
  // reconcile by NAME + isInterviewer so an already-enrolled candidate keeps its
  // enrollment status/confidence across a resync instead of resetting to 'pending'.
  const rosterSignature = `${interviewerDisplayName}|${candidateNames.join(' ')}`;
  useEffect(() => {
    setParticipants((prev) => {
      const byName = new Map(prev.map((p) => [p.name, p]));
      const next = initialParticipants.map((base) => {
        const existing = byName.get(base.name);
        // Preserve live enrollment state; the interviewer row stays 'matched'.
        if (existing) {
          return { ...base, status: existing.status, confidence: existing.confidence };
        }
        return base;
      });
      return next;
    });
    // initialParticipants is derived from rosterSignature; depend on the signature to
    // avoid re-running every render (new array identity each time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterSignature]);

  // ── Speaker-activity talk-time — derived from real transcript utterances (Bug B) ──
  // ROOT-CAUSE FIX: talk-time no longer comes from local RMS levels (which cannot tell
  // real speech from music/noise/echo and mis-credited any system audio to students).
  // Instead we count FINAL transcript utterances per speaker: music/background audio
  // produces no utterances → silent students stay at 0%. Partials are excluded to avoid
  // jitter. Weighting is per-utterance (turn count): reliable and explainable, and it
  // needs no endMs (TranscriptSegment has startMs but no endMs).
  //   - role 'teacher'  → the interviewer row (matched by isInterviewer, not by name).
  //   - role 'students' → the segment's diarization `speaker` label, mapped onto the
  //     roster: exact name match wins; otherwise, if there is exactly one candidate,
  //     all student utterances fold into that candidate (1v1); else the raw speaker
  //     label is credited (shown as its own bucket).
  const participantsWithActivity: Participant[] = useMemo(() => {
    const finals = transcriptSegments.filter((s) => s.isFinal);
    const rosterCandidates = participants.filter((p) => !p.isInterviewer);
    const soleCandidate = rosterCandidates.length === 1 ? rosterCandidates[0].name : null;

    // Tally utterance counts per bucket key (participant name).
    const counts = new Map<string, number>();
    let total = 0;
    for (const seg of finals) {
      let key: string;
      if (seg.role === 'teacher') {
        key = interviewerDisplayName;
      } else {
        const label = (seg.speaker ?? '').trim();
        if (label && rosterCandidates.some((c) => c.name === label)) {
          key = label; // diarization label matches a roster candidate
        } else if (soleCandidate) {
          key = soleCandidate; // 1v1 → fold all student speech into the sole candidate
        } else {
          key = label || 'Student'; // unmatched multi-candidate → its own bucket
        }
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }

    // Apply counts to the known roster rows.
    const withActivity = participants.map((p) => {
      const c = counts.get(p.name) ?? 0;
      return {
        ...p,
        turnCount: c,
        talkTimePct: total > 0 ? Math.round((c / total) * 100) : 0,
      };
    });

    // Surface any student speaker labels that matched no roster row (multi-candidate,
    // diarization label unknown to the roster) so their talk-time is not silently lost.
    const knownNames = new Set(participants.map((p) => p.name));
    for (const [key, c] of counts) {
      if (!knownNames.has(key)) {
        withActivity.push({
          name: key,
          status: 'unknown' as ParticipantStatus,
          talkTimePct: total > 0 ? Math.round((c / total) * 100) : 0,
          turnCount: c,
          isInterviewer: false,
        });
      }
    }

    return withActivity;
  }, [transcriptSegments, participants, interviewerDisplayName]);

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

      {/* System audio warning banner — shown persistently while capturing without system audio */}
      <AnimatePresence>
        {isCapturing && !systemReady && (() => {
          const { title, message } = getSystemAudioHint(systemAudioFailureReason);
          return (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-2 px-3 py-1.5 bg-warning/10 border-b border-warning/30 text-warning shrink-0"
              role="alert"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-warning" />
              <span className="text-xs">
                <span className="font-semibold">{title}</span>
                {' — '}
                {message}
              </span>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Thin stage progress bar */}
      <StageProgressBar currentStage={currentStage} stages={stages} />

      {/* Body */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Caption panel — left side, conditional on ACS status */}
        <CaptionPanel
          captions={captions}
          acsStatus={acsStatus}
          transcriptSegments={transcriptSegments}
          partialTranscripts={partialTranscripts}
        />

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
          participants={participantsWithActivity}
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

      {/* Toast notifications (system audio warning, etc.) */}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
