/**
 * Inject/update demo sessions in localStorage on app startup.
 *
 * 1. Creates standalone demo session if not present.
 * 2. Upgrades "Wei Yixin" session with real ResultV2 + improvements.
 *
 * Called once on app startup. Idempotent.
 */
import demoResultV2 from './demo-result-v2.json';
import weiYixinResultV2 from './wei-yixin-result-v2.json';
import type { StoredSessionRecord } from '../types/stored-session';

/** Minimal shape for reading per_person and transcript from demo JSON. */
interface DemoResultV2 {
  per_person?: Array<{ display_name?: string }>;
  transcript?: Array<{ end_ms?: number }>;
  [key: string]: unknown;
}

const DEMO_SESSION_ID = 'demo_session_full';
const WEI_YIXIN_UPGRADE_KEY = 'ifb_wei_yixin_upgraded_v8';

export function injectDemoSession(): void {
  injectStandaloneDemo();
  upgradeWeiYixinSession();
}

function injectStandaloneDemo(): void {
  try {
    const existing = localStorage.getItem(`ifb_session_data_${DEMO_SESSION_ID}`);
    if (existing) return;
  } catch { /* continue */ }

  const typedDemo = demoResultV2 as DemoResultV2;
  const persons = typedDemo.per_person || [];
  const participants = persons.map((p) => p.display_name || 'Unknown');
  const lastUtterance = typedDemo.transcript?.slice(-1)[0];
  const durationSec = lastUtterance?.end_ms ? Math.round(lastUtterance.end_ms / 1000) : 600;

  const sessionRecord = {
    id: DEMO_SESSION_ID,
    name: 'Demo: 群面模拟 (含改进建议)',
    date: '2026-02-24',
    mode: 'group',
    participantCount: participants.length,
    participants,
    status: 'finalized',
  };

  try {
    const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
    if (!sessions.some((s: StoredSessionRecord) => s.id === DEMO_SESSION_ID)) {
      sessions.unshift(sessionRecord);
      localStorage.setItem('ifb_sessions', JSON.stringify(sessions));
    }
  } catch {
    localStorage.setItem('ifb_sessions', JSON.stringify([sessionRecord]));
  }

  localStorage.setItem(
    `ifb_session_data_${DEMO_SESSION_ID}`,
    JSON.stringify({
      sessionName: sessionRecord.name,
      mode: 'group',
      participants,
      date: '2026-02-24',
      elapsedSeconds: durationSec,
      report: demoResultV2,
    }),
  );
}

/**
 * Find the "Wei Yixin" session and inject its proper ResultV2 + improvements.
 * Uses wei-yixin-result-v2.json generated from demo data + local LLM improvements.
 */
function upgradeWeiYixinSession(): void {
  // Clean up orphaned version keys from previous iterations
  try {
    for (let i = 1; i < 8; i++) {
      localStorage.removeItem(`ifb_wei_yixin_upgraded_v${i}`);
    }
  } catch { /* ignore */ }

  try {
    if (localStorage.getItem(WEI_YIXIN_UPGRADE_KEY)) return;
  } catch { /* continue */ }

  try {
    const sessions: StoredSessionRecord[] = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
    const weiYixin = sessions.find((s: StoredSessionRecord) =>
      typeof s.name === 'string' &&
      (s.name.toLowerCase().includes('wei yixin') || s.name.includes('魏一新'))
    );
    if (!weiYixin) return;

    const sessionId = weiYixin.id;
    const dataKey = `ifb_session_data_${sessionId}`;

    let sessionData: Record<string, unknown> = {};
    try {
      const stored = localStorage.getItem(dataKey);
      if (stored) sessionData = JSON.parse(stored);
    } catch { /* start fresh */ }

    // Inject the Wei Yixin-specific ResultV2 (adapted from demo data + LLM improvements)
    sessionData.report = weiYixinResultV2;
    // Remove baseApiUrl so FeedbackView uses pre-stored report
    // (Worker can't generate report due to DashScope API issues)
    delete sessionData.baseApiUrl;

    localStorage.setItem(dataKey, JSON.stringify(sessionData));

    // Mark session as finalized
    const updated = sessions.map((s: StoredSessionRecord) =>
      s.id === sessionId ? { ...s, status: 'finalized' } : s
    );
    localStorage.setItem('ifb_sessions', JSON.stringify(updated));

    localStorage.setItem(WEI_YIXIN_UPGRADE_KEY, 'true');
  } catch (err) {
    console.warn('[injectDemoSession] Failed to upgrade Wei Yixin session:', err);
  }
}
