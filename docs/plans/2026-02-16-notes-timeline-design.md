# Notes Timeline & Selective Categorization Design

**Date:** 2026-02-16
**Status:** Approved — ready for implementation planning

---

## Problem Statement

During interview recording in the Sidecar view, freeform notes accumulate in the Editor without any cleanup mechanism. This creates three pain points:

1. **Note fragmentation**: Users want to categorize individual sentences (not the entire editor content) into Memo categories (Strength, Risk, Flag, Idea)
2. **Stage transition clutter**: When switching stages (e.g., Intro → Q1), previous freeform content remains in the Editor, mixing with new-stage notes
3. **No archive for uncategorized notes**: Freeform text that isn't categorized has nowhere to go — it just piles up

## Design Solution

### Architecture Overview

```
┌─────────────────────────────────────┐
│  [Stage: Q1]  ◀ ▶                   │  ← Current stage indicator
├─────────────────────────────────────┤
│                                     │
│  Editor (active input for current   │  ← Clean: only current stage content
│  stage)                             │
│  · Select text + Cmd+1/2/3/4       │
│    → categorize SELECTION only      │
│  · No selection + Cmd+1/2/3/4      │
│    → categorize ALL editor text     │
│                                     │
├─────────────────────────────────────┤
│  ▸ Intro (3 notes)          12:05   │  ← Collapsible timeline
│  ▾ Q1 (2 notes)             12:12   │     Archived notes per stage
│    "candidate mentioned..."         │
│    "team collaboration aspect..."   │
├─────────────────────────────────────┤
│  [Strength] [Risk] [Flag] [Idea]    │  ← QuickMarkBar (unchanged)
└─────────────────────────────────────┘
```

### Core Behaviors

#### 1. Auto-Archive on Stage Switch

When the user advances to the next stage (e.g., clicks "Next" or Cmd+→):

1. Capture the current Editor plaintext content
2. If non-empty, create a `StageArchive` entry for the current stage
3. Clear the Editor
4. The archived content appears in the collapsible timeline below the Editor
5. User can expand any past stage to review its archived notes (read-only)

**Edge cases:**
- If Editor is empty when switching, no archive entry is created
- If user goes back to a previous stage, the archive for that stage is shown but remains read-only
- Multiple switches within the same stage accumulate into a single archive

#### 2. Selective Text Categorization

Enhanced Cmd+1/2/3/4 behavior:

- **With text selection**: Only the selected text is categorized as the chosen Memo type. The selected text is removed from the Editor; remaining text stays.
- **Without text selection**: Entire Editor content is categorized (current behavior preserved).
- The flying memo animation originates from the selection position (or the QuickMarkBar button as current fallback).

**Implementation in TipTap:**
- Use `editor.state.selection` to detect if there's a non-empty selection
- If selection exists: extract selected text via `editor.state.doc.textBetween(from, to)`
- Delete the selected range: `editor.chain().focus().deleteRange({ from, to }).run()`
- Create memo with extracted text only

#### 3. Collapsible Timeline (Below Editor)

Visual design:
- Located between the Editor and the QuickMarkBar
- Each stage entry shows: `▸ {stageName} ({noteCount} notes)  {timestamp}`
- Collapsed by default; click to expand
- Expanded view shows the freeform text as read-only, rendered as plain text paragraphs
- Already-categorized memos within that stage are shown with colored tags (matching Memo tray colors)
- Smooth AnimatePresence expand/collapse animation

**Constraints:**
- Timeline does not scroll independently — it's part of the main Sidecar scroll
- Maximum 4-5 visible archive entries before the timeline itself needs to scroll (rare case)
- No edit capability in archived notes — history is immutable

### Data Model

```typescript
// New type for stage archives
type StageArchive = {
  stageIndex: number;
  stageName: string;
  archivedAt: string;        // ISO timestamp
  freeformText: string;      // Uncategorized text from Editor
  memoIds: string[];         // IDs of memos created during this stage
};

// Addition to session store
interface SessionStore {
  // ... existing fields ...
  stageArchives: StageArchive[];
  addStageArchive: (archive: StageArchive) => void;
}
```

### Interaction Flow

```
User types notes during Intro stage
  ↓
User selects "Dan had mic issues" → presses Cmd+1 (Strength)
  ↓
Selected text becomes a Strength memo → removed from Editor
Remaining text stays in Editor
  ↓
User clicks "Next Stage" (Intro → Q1)
  ↓
Remaining Editor text → auto-archived as "Intro" stage archive
Editor clears → clean slate for Q1
Timeline shows: "▸ Intro (2 notes)  10:05"
  ↓
User types Q1 notes in clean Editor
```

### Components to Modify

1. **`sessionStore.ts`**: Add `stageArchives` state + `addStageArchive` action
2. **`SidecarView.tsx`**:
   - Modify `addMemo` to support text selection
   - Add auto-archive logic to stage advance handler
   - Add `StageTimeline` component below Editor
3. **`globals.css`**: Timeline-specific styles (if needed beyond Tailwind)

### Design Tokens

- Archive header: `text-xs font-semibold text-ink-tertiary` (matches date group headers in HistoryView)
- Archive content: `text-sm text-ink-secondary` with `bg-surface/50` background
- Expand/collapse chevron: Lucide `ChevronRight` with rotation animation
- Stage badge colors: Reuse existing `Chip` component variants
