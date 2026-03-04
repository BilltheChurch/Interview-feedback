import type { MemoType } from '../../stores/sessionStore';
import { Star, AlertTriangle, HelpCircle, Link2 } from 'lucide-react';

/* ─── Participant types ───────────────────────── */

export type ParticipantStatus = 'pending' | 'capturing' | 'matched' | 'needs_confirm' | 'not_enrolled' | 'unknown';

export type Participant = {
  name: string;
  status: ParticipantStatus;
  confidence?: number;
  talkTimePct: number;
  turnCount: number;
};

/* ─── DisplayMemo — enriches store Memo with stage name ── */

export type DisplayMemo = {
  id: string;
  type: MemoType;
  text: string;
  timestamp: number;
  stage: string;
  createdAt: Date;
};

/* ─── Incremental badge status ───────────────── */

export type IncrementalBadgeStatus = 'idle' | 'recording' | 'processing' | 'finalizing' | 'succeeded' | 'failed';

/* ─── Constants ──────────────────────────────── */

export const defaultStages = ['Intro', 'Q1', 'Q2', 'Q3', 'Wrap-up'];

export const memoConfig: Record<MemoType, { icon: typeof Star; label: string; chipVariant: 'accent' | 'warning' | 'info' | 'default' }> = {
  highlight: { icon: Star, label: 'Highlight', chipVariant: 'accent' },
  issue: { icon: AlertTriangle, label: 'Issue', chipVariant: 'warning' },
  question: { icon: HelpCircle, label: 'Question', chipVariant: 'info' },
  evidence: { icon: Link2, label: 'Evidence', chipVariant: 'default' },
};

export const memoShortcutOrder: MemoType[] = ['highlight', 'issue', 'question', 'evidence'];

export const flashcardStyle: Record<MemoType, { topBorder: string; bg: string; iconColor: string }> = {
  highlight: { topBorder: 'border-t-emerald-400', bg: 'bg-emerald-50/60', iconColor: 'text-emerald-600' },
  issue:     { topBorder: 'border-t-amber-400',   bg: 'bg-amber-50/60',   iconColor: 'text-amber-600' },
  question:  { topBorder: 'border-t-blue-400',    bg: 'bg-blue-50/60',    iconColor: 'text-blue-600' },
  evidence:  { topBorder: 'border-t-purple-400',  bg: 'bg-purple-50/60',  iconColor: 'text-purple-600' },
};

/* ─── Helpers ────────────────────────────────── */

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
