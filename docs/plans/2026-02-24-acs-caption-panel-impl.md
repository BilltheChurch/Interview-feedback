# ACS 实时字幕面板 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a live caption display panel to SidecarView so interviewers can see real-time Teams meeting captions during recording sessions.

**Architecture:** Ring buffer in Zustand store receives Final captions from ACSCaptionService via the orchestrator (dual-channel: Worker + local store). A new CaptionPanel component renders grouped captions with auto-scroll, positioned to the left of the notes editor in SidecarView. Panel is conditionally rendered based on ACS status.

**Tech Stack:** React 18 + TypeScript, Zustand (state), Tailwind v4 (styling), motion/react (animations), Lucide React (icons)

---

### Task 1: Add CaptionEntry type and ring buffer to sessionStore

**Files:**
- Modify: `desktop/src/stores/sessionStore.ts`

**Step 1: Add the CaptionEntry type after the existing AcsStatus type (line 44)**

```typescript
export type CaptionEntry = {
  id: string;
  speaker: string;
  text: string;
  timestamp: number;
  language: string;
};

const MAX_CAPTIONS = 200;
```

**Step 2: Add `captions` field to the SessionStore interface (after line 161, after `acsCaptionCount`)**

```typescript
  // ACS Caption
  acsStatus: AcsStatus;
  acsCaptionCount: number;
  captions: CaptionEntry[];
```

**Step 3: Add `addCaption` action to SessionStore interface (after `incrementAcsCaptionCount`, line 193)**

```typescript
  addCaption: (entry: Omit<CaptionEntry, 'id'>) => void;
```

**Step 4: Add initial state for `captions` (after `acsCaptionCount: 0` in INITIAL_STATE, line 228)**

```typescript
  captions: [] as CaptionEntry[],
```

**Step 5: Add `addCaption` implementation (after `incrementAcsCaptionCount` action, line 350)**

```typescript
  addCaption: (entry) =>
    set((s) => {
      const id = `cap_${entry.timestamp}_${s.captions.length}`;
      const next = [...s.captions, { ...entry, id }];
      return { captions: next.length > MAX_CAPTIONS ? next.slice(-MAX_CAPTIONS) : next };
    }),
```

**Step 6: Add `captions: []` to `startSession` set call (line 260, alongside `memos: []`)**

Add `captions: [],` after the `memos: [],` line.

**Step 7: Verify `reset()` clears captions**

The `reset()` action does `set({ ...INITIAL_STATE })` which already includes `captions: []` from Step 4. No extra change needed.

**Step 8: Run TypeScript check**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS with no errors

**Step 9: Commit**

```bash
git add desktop/src/stores/sessionStore.ts
git commit -m "feat(store): add CaptionEntry ring buffer to sessionStore"
```

---

### Task 2: Wire caption callback to store in useSessionOrchestrator

**Files:**
- Modify: `desktop/src/hooks/useSessionOrchestrator.ts`

**Step 1: Add Final caption → store write in the `start()` caption callback**

In the caption callback (lines 93-119), after `store.incrementAcsCaptionCount();` (line 101), add:

```typescript
                // Store Final captions locally for UI display
                if (caption.resultType === 'Final') {
                  store.addCaption({
                    speaker: caption.speaker,
                    text: caption.text,
                    timestamp: caption.timestamp,
                    language: caption.language,
                  });
                }
```

**Step 2: Add the same Final caption → store write in the `resume()` caption callback**

In the resume caption callback (lines 330-349), after `store.incrementAcsCaptionCount();` (around line 336), add the identical block:

```typescript
                // Store Final captions locally for UI display
                if (caption.resultType === 'Final') {
                  store.addCaption({
                    speaker: caption.speaker,
                    text: caption.text,
                    timestamp: caption.timestamp,
                    language: caption.language,
                  });
                }
```

**Step 3: Run TypeScript check**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add desktop/src/hooks/useSessionOrchestrator.ts
git commit -m "feat(orchestrator): dispatch Final captions to store for UI display"
```

---

### Task 3: Create CaptionPanel component

**Files:**
- Create: `desktop/src/components/CaptionPanel.tsx`

**Step 1: Create the full CaptionPanel component**

```tsx
import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MessageSquareText, ChevronLeft, ChevronRight, ArrowDown } from 'lucide-react';
import type { CaptionEntry, AcsStatus } from '../stores/sessionStore';

/* ── Speaker color palette (6 colors, cycling) ── */

const SPEAKER_COLORS = [
  'text-blue-700 bg-blue-50',
  'text-emerald-700 bg-emerald-50',
  'text-purple-700 bg-purple-50',
  'text-amber-700 bg-amber-50',
  'text-rose-700 bg-rose-50',
  'text-cyan-700 bg-cyan-50',
];

const SPEAKER_DOT_COLORS = [
  'bg-blue-400',
  'bg-emerald-400',
  'bg-purple-400',
  'bg-amber-400',
  'bg-rose-400',
  'bg-cyan-400',
];

/* ── Group consecutive captions by same speaker ── */

type CaptionGroup = {
  speaker: string;
  entries: CaptionEntry[];
};

function groupCaptions(captions: CaptionEntry[]): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  for (const cap of captions) {
    const last = groups[groups.length - 1];
    if (last && last.speaker === cap.speaker) {
      last.entries.push(cap);
    } else {
      groups.push({ speaker: cap.speaker, entries: [cap] });
    }
  }
  return groups;
}

/* ── CaptionPanel ── */

export function CaptionPanel({
  captions,
  acsStatus,
}: {
  captions: CaptionEntry[];
  acsStatus: AcsStatus;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Build stable speaker → color index map
  const speakerColorMap = useMemo(() => {
    const map = new Map<string, number>();
    let idx = 0;
    for (const cap of captions) {
      if (!map.has(cap.speaker)) {
        map.set(cap.speaker, idx % SPEAKER_COLORS.length);
        idx++;
      }
    }
    return map;
  }, [captions]);

  const groups = useMemo(() => groupCaptions(captions), [captions]);

  // Auto-scroll to bottom when new captions arrive (only if already at bottom)
  useEffect(() => {
    if (isAtBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [captions.length, isAtBottom]);

  // Track scroll position to detect manual scroll-up
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setIsAtBottom(atBottom);
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setIsAtBottom(true);
    }
  };

  // Don't render at all if ACS is off
  if (acsStatus === 'off') return null;

  // Collapsed state — narrow icon bar
  if (collapsed) {
    return (
      <div className="w-9 shrink-0 border-r border-border bg-surface flex flex-col items-center pt-2">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1.5 rounded-lg text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover transition-colors"
          title="Show captions"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <MessageSquareText className="w-4 h-4 text-ink-tertiary mt-2" />
        {captions.length > 0 && (
          <span className="text-xs text-ink-tertiary mt-1 tabular-nums">{captions.length}</span>
        )}
      </div>
    );
  }

  // Expanded state
  return (
    <div className="w-60 shrink-0 border-r border-border bg-surface flex flex-col">
      {/* Panel header */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
        <div className="flex items-center gap-1.5">
          <MessageSquareText className="w-3.5 h-3.5 text-ink-tertiary" />
          <span className="text-xs font-medium text-ink-secondary">Captions</span>
          {captions.length > 0 && (
            <span className="text-xs text-ink-tertiary tabular-nums">({captions.length})</span>
          )}
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 rounded text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover transition-colors"
          title="Hide captions"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Caption list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-2 py-1.5 flex flex-col gap-1.5 relative"
      >
        {captions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-3 py-6">
            <MessageSquareText className="w-6 h-6 text-ink-tertiary/40 mb-2" />
            <p className="text-xs text-ink-tertiary">
              {acsStatus === 'connecting' ? 'Connecting to Teams...' :
               acsStatus === 'connected' ? 'Waiting for captions...' :
               acsStatus === 'error' ? 'Caption connection error' :
               'Captions will appear here'}
            </p>
          </div>
        ) : (
          groups.map((group, gi) => {
            const colorIdx = speakerColorMap.get(group.speaker) ?? 0;
            const dotColor = SPEAKER_DOT_COLORS[colorIdx];
            const textColor = SPEAKER_COLORS[colorIdx].split(' ')[0];

            return (
              <div key={`${group.speaker}-${group.entries[0].id}`} className="flex flex-col gap-0.5">
                {/* Speaker name — only show if different from previous group */}
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
                  <span className={`text-xs font-medium ${textColor} truncate`}>
                    {group.speaker}
                  </span>
                </div>
                {/* Grouped caption texts */}
                {group.entries.map((entry) => (
                  <p key={entry.id} className="text-xs text-ink-secondary leading-relaxed pl-3">
                    {entry.text}
                  </p>
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* Jump to bottom button */}
      <AnimatePresence>
        {!isAtBottom && captions.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            onClick={scrollToBottom}
            className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-full bg-accent text-white text-xs shadow-md hover:bg-accent-hover transition-colors z-10"
          >
            <ArrowDown className="w-3 h-3" />
            Latest
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
```

**Step 2: Run TypeScript check**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add desktop/src/components/CaptionPanel.tsx
git commit -m "feat(ui): add CaptionPanel component for live Teams captions"
```

---

### Task 4: Integrate CaptionPanel into SidecarView + fix header layout

**Files:**
- Modify: `desktop/src/views/SidecarView.tsx`

**Step 1: Add CaptionPanel import (after line 31)**

```typescript
import { CaptionPanel } from '../components/CaptionPanel';
```

**Step 2: Add `captions` store selector in SidecarView (after line 966, the `acsCaptionCount` selector)**

```typescript
  const captions = useSessionStore((s) => s.captions);
```

**Step 3: Fix header layout — add `shrink-0` to ACS badge and `overflow-hidden` to left container**

In `SidecarHeader` (line 172), change:

```tsx
      <div className="flex items-center gap-2 min-w-0">
```

to:

```tsx
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
```

And on line 174, change session name max-width:

```tsx
        <span className="text-sm text-ink truncate max-w-[140px]">
```

to:

```tsx
        <span className="text-sm text-ink truncate max-w-[120px]">
```

And wrap AcsStatusBadge (line 177) with `shrink-0`:

```tsx
        <div className="shrink-0">
          <AcsStatusBadge status={acsStatus} captionCount={acsCaptionCount} />
        </div>
```

**Step 4: Add CaptionPanel to SidecarView body layout**

In the body section (line 1285), the current layout is:

```tsx
      <div className="flex flex-1 min-h-0 relative">
        {/* Notes workspace — takes maximum space */}
        <div className="flex-1 flex flex-col min-w-0">
```

Insert CaptionPanel before the notes workspace div:

```tsx
      <div className="flex flex-1 min-h-0 relative">
        {/* Caption panel — left side, conditional on ACS status */}
        <CaptionPanel captions={captions} acsStatus={acsStatus} />

        {/* Notes workspace — takes maximum space */}
        <div className="flex-1 flex flex-col min-w-0">
```

**Step 5: Run TypeScript check**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

**Step 6: Run Vite build to verify production bundle**

Run: `cd desktop && npx vite build`
Expected: PASS (build completes with no errors)

**Step 7: Commit**

```bash
git add desktop/src/views/SidecarView.tsx
git commit -m "feat(sidecar): integrate CaptionPanel + fix header ACS badge visibility"
```

---

### Task 5: Run all desktop tests + final verification

**Files:**
- No new files

**Step 1: Run existing desktop tests to verify no regressions**

Run: `cd desktop && npx vitest run`
Expected: All 63+ tests PASS

**Step 2: Run TypeScript check**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

**Step 3: Run Vite production build**

Run: `cd desktop && npx vite build`
Expected: PASS

**Step 4: Commit (only if any fixes were needed)**

No commit needed if all pass on first run.

---

### Task 6: Build and launch app for manual verification

**Files:**
- No changes

**Step 1: Build production bundle**

Run: `cd desktop && npx vite build`

**Step 2: Launch Electron app**

Run: `cd desktop && npm run dev`

**Step 3: Verify in running app**

Manual checks:
- Start a session with a Teams meeting URL
- Verify ACS badge appears in header
- Verify CaptionPanel appears on the left side of notes editor
- Verify captions flow into the panel as people speak
- Verify panel collapse/expand works
- Verify auto-scroll behavior
- Verify panel is hidden when ACS is off (non-Teams session)
