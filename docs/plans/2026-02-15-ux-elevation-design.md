# UX Elevation Design Specification

**Date:** 2026-02-15
**Author:** ux-researcher agent
**Purpose:** Blueprint for elevating Interview Feedback desktop app to Granola-level UX quality
**Status:** Ready for implementation

---

## 1. Competitor Analysis Summary

### 1.1 Granola (granola.ai) -- The Gold Standard

**What makes it premium:**
- **Zero-learning-curve notepad.** During meetings, the UI is simply a blank text canvas -- like Apple Notes. No distracting panels, metering, or status chrome. The entire philosophy is "just a notepad."
- **Human-first AI collaboration.** Users jot low-fidelity keyword notes; AI fills in the details after the meeting ends. The user is always in control of what matters.
- **Visual transparency.** User-authored text renders in **black**; AI-generated text renders in **gray**. This simple color distinction builds trust without requiring labels or badges.
- **Recipes.** Post-meeting, users type `/` to invoke "Recipes" -- expert AI prompts that act as lenses over the meeting (e.g., "BANT qualification," "Action items only").
- **No bots.** Captures audio from the device directly -- no visible meeting participant, no "BotName is recording" banner.
- **Typography-driven design.** Custom typefaces ("quadrant" headlines, "melange" body), dramatic size scaling, generous whitespace. Limited color palette (neutral base + single green accent).
- **Refined border treatments.** 1px separators, subtle shadows, precise padding ratios create a quiet sense of quality.

**Patterns to adopt:**
- During-session view should be predominantly a **notepad** -- minimize chrome
- Post-session notes should visually distinguish user input from AI output
- Use a single strong accent color sparingly
- Generous whitespace and typographic hierarchy over decorative elements

**Patterns to avoid:**
- Do NOT hide all contextual information (we need audio meters + stage flow for interview context)
- Do NOT require post-meeting processing delay -- our pipeline produces draft feedback in real-time

### 1.2 BrightHire (brighthire.com) -- Evidence-Linked Scorecards

**What makes it premium:**
- **1-click scorecard submission.** AI notes auto-fill ATS scorecards (Greenhouse integration). Interviewers mark key moments with timestamped reactions.
- **Candidate Highlights.** After every interview, the platform extracts highlight clips with evidence that replaces implicit bias with explicit evidence.
- **Hyperlinked timestamps.** Notes are linked to exact timestamps in the recording, so reviewers can jump to the moment a claim was made.
- **Import All Notes button.** Single action to port all AI-generated notes into scorecard question fields when a match is detected.
- **Debrief support.** Team members can access the same evidence, making collaborative hiring decisions based on shared data rather than individual recollections.

**Patterns to adopt:**
- Evidence chips should be clickable and jump to transcript timestamps
- Scorecard/feedback sections should have a "1-click export" or "auto-fill" feel
- Highlight clips (timestamp + speaker + quote) are the atomic unit of evidence
- Collaborative viewing -- multiple reviewers see the same evidence

**Patterns to avoid:**
- Heavy ATS integration chrome -- our app is standalone, not embedded in Greenhouse
- Complex multi-step scorecard workflows -- we need something faster

### 1.3 Metaview (metaview.ai) -- Structured Interview Notes

**What makes it premium:**
- **Question-organized notes.** Summaries are organized by each question asked, not just timestamps. This makes candidate comparison far easier.
- **Competency-based layout.** Notes arranged by competencies (communication, problem-solving, cultural fit) with color-coded category badges.
- **Card-based candidate profiles.** Avatar + skill badges + quote callouts + timeline hierarchy.
- **Glass-morphism effects.** Backdrop blur, semi-transparent overlays for depth.
- **80-90% accuracy.** Notes require only minor edits, delivered within minutes.
- **Customizable topics.** Users choose from AI-identified topics or add custom ones for tailored candidate snapshots.

**Patterns to adopt:**
- Organize feedback by **dimension/competency** (we already do this) with clear visual hierarchy
- Use **card-based layouts** with subtle depth (glassmorphism -- we already have this)
- Add **skill/competency badges** with category color coding
- Comparative candidate view for group sessions

**Patterns to avoid:**
- Over-reliance on avatar imagery (we don't have profile photos)
- ATS-centric workflow assumptions

### 1.4 Otter.ai -- Real-Time Transcript & Speaker ID

**What makes it premium:**
- **Live captions feel.** Text appears in real-time as people speak, with automatic paragraph breaks on speaker changes and topic shifts.
- **Speaker auto-detection.** Voices are matched against learned profiles; unknown speakers get "Speaker #" labels that can be renamed.
- **Retag and rename.** Clicking a speaker label opens a rename/retag flow; changes propagate across all conversations.
- **Keyword search.** Full-text search across all transcripts with highlighted matches.
- **Timestamped navigation.** Click any timestamp to jump to that point in the audio playback.
- **Inline editing.** Click Edit to correct any transcription errors in-place.

**Patterns to adopt:**
- Speaker labels with distinct visual identity (color-coded initials/avatars)
- Click-to-retag/rename speaker interaction
- Timestamp-based navigation in transcript
- Search/filter across transcript history

**Patterns to avoid:**
- Otter's speaker misidentification in cross-talk scenarios -- we handle this with SV embeddings
- Large transcript dumps without structure -- always group by question/stage

---

## 2. View-by-View Redesign Specifications

### 2.1 HomeView -- Dashboard

**Current pain points:**
- Hero banner takes too much vertical space for returning users
- "Start Interview" card duplicates what SetupView does
- Health indicators at bottom feel disconnected
- No at-a-glance statistics or trends
- Calendar integration placeholder feels empty

**Proposed layout:**

```
+--------------------------------------------------+
|  [Logo] Chorus           [Settings] [History]     |  <- Compact top bar
+--------------------------------------------------+
|                                                    |
|  Good morning                                      |
|  ┌────────────────────┐  ┌──────────────────────┐ |
|  │  START SESSION      │  │  RECENT              │ |
|  │                     │  │                       │ |
|  │  [1v1] [Group]      │  │  > Session 1  02:14  │ |
|  │  ________________   │  │  > Session 2  02:13  │ |
|  │  Session name       │  │  > Session 3  02:12  │ |
|  │                     │  │                       │ |
|  │  [Start Session >>] │  │  View all ->          │ |
|  └────────────────────┘  └──────────────────────┘ |
|                                                    |
|  ┌────────────────────┐  ┌──────────────────────┐ |
|  │  PENDING FEEDBACK   │  │  QUICK STATS         │ |
|  │  2 sessions         │  │  12 sessions total   │ |
|  │  > Finalize ...     │  │  4.2h recorded       │ |
|  │  > Finalize ...     │  │  28 participants     │ |
|  └────────────────────┘  └──────────────────────┘ |
|                                                    |
|  ── Audio: Ready  Backend: Connected  Teams: -- ── |
+--------------------------------------------------+
```

**Key changes:**
1. **Shrink hero.** Replace the large teal banner with a compact greeting line + subtle brand mark. The hero should be just 1 line of text, not 120px.
2. **Add "Recent Sessions" card.** Show the 3 most recent sessions with quick-access to feedback. Removes the need to navigate to History for recent items.
3. **Add "Quick Stats" card.** Show lifetime stats (total sessions, total hours, participants). Uses the `NumberTicker` component we already have.
4. **Compact health strip.** Keep it but make it a thin row with dot indicators, not a full-height section.
5. **Start Session card stays** but is more compact -- mode toggle + name field + CTA in a tight layout.

**Component changes:**
- Shrink `TextAnimate` hero to single-line greeting
- Add `RecentSessionsList` sub-component (3-item list with links)
- Add `QuickStatsCard` sub-component

### 2.2 SetupView -- Session Configuration

**Current pain points:**
- Long vertical scroll with 7 stacked cards -- feels like a form, not a guided flow
- Rubric template grid becomes unwieldy with custom templates
- Summary section is static and not actionable
- No visual indication of which sections are required vs optional
- Meeting Link section feels orphaned

**Proposed layout:**

```
+--------------------------------------------------+
|  <- Back   Session Setup              Step 1 of 3 |
+--------------------------------------------------+
|                                                    |
|  ┌──────────────────────────────────────────────┐ |
|  │               STEP INDICATOR                  │ |
|  │   (1) Basics    (2) Template    (3) Review    │ |
|  │   ========      --------       --------       │ |
|  └──────────────────────────────────────────────┘ |
|                                                    |
|  ┌──────────────────────────────────────────────┐ |
|  │                                                │ |
|  │  [Content for current step]                    │ |
|  │                                                │ |
|  │  Step 1: Mode + Name + Participants + Link     │ |
|  │  Step 2: Rubric Template + Flow stages         │ |
|  │  Step 3: Review summary + Start button         │ |
|  │                                                │ |
|  └──────────────────────────────────────────────┘ |
|                                                    |
|         [Back]              [Continue >>]          |
+--------------------------------------------------+
```

**Key changes:**
1. **Convert to 3-step wizard.** Instead of a long scroll, break into steps:
   - Step 1: Basics (mode, name, participants, meeting link)
   - Step 2: Template (rubric selection, interview flow/stages)
   - Step 3: Review (summary card + start button)
2. **Add step indicator.** Horizontal progress bar at top with numbered steps. Uses accent color for completed steps.
3. **Sticky bottom navigation.** Back/Continue buttons always visible at bottom, not scrolled away.
4. **Animate step transitions.** Use `motion/react` slide-left/slide-right for step changes.
5. **Required field indicators.** Subtle asterisk or dot next to required fields (Session Name).

**Component additions:**
- `StepIndicator` -- horizontal 3-dot progress with labels
- Refactor `SetupView` into step-based state machine

### 2.3 SidecarView -- Live Recording (Highest Priority)

**Current pain points:**
- Too much chrome visible during recording -- header, QuickMarkBar, StageIndicator, MemoTimeline, ContextDrawer all compete for attention
- The notes editor area (the most important element) gets squeezed
- MemoTimeline at bottom takes 190px of height even with 0 memos
- Context drawer (right rail) is dense with collapsible sections
- Transcript overlay is a placeholder with no real content
- Audio meters are hidden in the drawer -- they should be more visible
- No visual breathing room

**Proposed layout (Granola-inspired):**

```
+--------------------------------------------------+
|  [*] Recording  My Interview   12:34   [T] [End] |  <- 40px header (keep)
+--------------------------------------------------+
|  Stage: Intro  ===------- 1/5                     |  <- 28px stage bar
+--------------------------------------------------+
|                    |                               |
|                    |  ┌─────┐ ┌─────┐ ┌─────┐    |
|   NOTES EDITOR     |  │ Mic │ │ Sys │ │ Mix │    |  <- Vertical mini-meters
|   (80% of space)   |  └─────┘ └─────┘ └─────┘    |
|                    |                               |
|   The notepad      |  Flow:                        |
|   is the hero.     |  [x] Intro                    |
|   Type freely.     |  [ ] Q1                       |
|                    |  [ ] Q2                        |
|                    |  [Next Question]               |
|                    |                               |
|                    |  Speakers:                     |
|                    |  JD ████░░ 45%                 |
|                    |  JS ████░░ 35%                 |
|                    |                               |
+--------------------+-------------------------------+
|  [*] [!] [?] [@]  Cmd+1-4          3 memos        |  <- 32px mark bar
+--------------------------------------------------+
```

**Key changes:**
1. **Notes-first layout.** The RichNoteEditor occupies ~75-80% of the view. This is the Granola lesson: during a session, the notepad IS the product.
2. **Collapse MemoTimeline into the mark bar.** Instead of a 190px horizontal tray, show a compact count ("3 memos") in the bottom quick-mark bar. Memos are viewable in a popover or the feedback view after the session.
3. **Shrink Context Drawer.** Default width should be narrower (180px not 22%). Use compact vertical audio meters (thin bars) instead of the full `MeterBar` component.
4. **Move QuickMarkBar to bottom.** This follows the pattern of tools (text editors, IDEs) that put toolbars at the bottom. The top should be clean.
5. **Stage indicator stays at top** but is more compact -- single line with progress dots.
6. **Remove TranscriptOverlay.** During recording, real-time transcript is a distraction. If needed later, it can go in the drawer. The Granola philosophy is clear: don't show the transcript during the meeting.
7. **Subtle audio heartbeat.** Instead of 3 separate meter bars, show a single subtle pulsing border or glow on the header when audio is detected. This gives a "recording alive" feel without visual noise.

**Component changes:**
- Remove `MemoTimeline` from SidecarView (move to post-session only)
- Create `CompactAudioIndicator` -- single animated element showing audio activity
- Refactor `QuickMarkBar` to include memo count
- Reduce `ContextDrawer` default width

### 2.4 FeedbackView -- Post-Session Report (High Priority)

**Current pain points:**
- Long monolithic scroll with no navigation aids
- Person cards are very tall with all dimensions expanded
- No summary-at-a-glance before diving into details
- Evidence timeline at the bottom is easy to miss
- Export options are text-only (no PDF)
- No visual "scorecard" or radar chart for quick assessment
- Draft vs Final status banner is small
- Session memos section is not visually connected to the AI analysis

**Proposed layout:**

```
+--------------------------------------------------+
|  <- Back   Product Manager Final Round            |
|  Feb 14 | 12m | 2 participants | Group | Draft   |
|  [Copy] [Export MD] [Export PDF] [Re-generate]    |
+--------------------------------------------------+
|                                                    |
|  ┌───────────────┐  ┌───────────────────────────┐ |
|  │  NAV SIDEBAR   │  │                           │ |
|  │                 │  │  CONTENT AREA             │ |
|  │  Overview       │  │                           │ |
|  │  Session Notes  │  │  [Currently selected      │ |
|  │  ─────────      │  │   section renders here]   │ |
|  │  Alice Chen     │  │                           │ |
|  │  Bob Williams   │  │                           │ |
|  │  ─────────      │  │                           │ |
|  │  Evidence       │  │                           │ |
|  │                 │  │                           │ |
|  └───────────────┘  └───────────────────────────┘ |
+--------------------------------------------------+
```

**Key changes:**
1. **Add left navigation sidebar.** For reports with multiple participants, a sticky left nav allows jumping between sections without scrolling. Sections: Overview, Session Notes, [Person names], Evidence Timeline. Active section is highlighted.
2. **Add Competency Radar Chart.** At the top of each person's section, show a radar/spider chart plotting their scores across dimensions. This gives an instant visual read on strengths/weaknesses. Use a simple SVG radar chart component (no heavy charting library needed).
3. **Collapsible dimension sections.** Each dimension starts collapsed with a summary line (e.g., "Leadership: 2 strengths, 1 risk, 1 action"). Click to expand and see full claims.
4. **Draft status banner.** If status is "draft," show a prominent amber banner at the top: "This report is being finalized. Content may change." with a subtle progress animation.
5. **Connect memos to claims.** When a session memo matches an AI claim, show a visual link (e.g., a small "matches memo" badge on the claim card). This bridges the interviewer's observations with the AI analysis.
6. **Inline evidence preview.** Instead of opening a modal for every evidence click, show a hover tooltip with the quote + timestamp. Modal only for full context view.
7. **Person tab navigation.** For group sessions, add tab-style navigation at the top of the persons area so reviewers can switch between participants without scrolling.

**Component additions:**
- `CompetencyRadar` -- SVG radar chart (5-axis, configurable)
- `SectionNav` -- sticky left sidebar navigation
- `DraftBanner` -- amber animated progress banner
- `EvidenceTooltip` -- hover preview for evidence chips
- `DimensionSummaryRow` -- collapsed dimension with counts

### 2.5 HistoryView -- Session Archive

**Current pain points:**
- Basic list with no visual hierarchy
- No filtering by date range, mode, or status
- No sorting options
- Summary strip at bottom is easily missed
- No batch operations
- Search is pill-shaped (inconsistent with other inputs)

**Proposed layout:**

```
+--------------------------------------------------+
|  <- Back   Session History                         |
+--------------------------------------------------+
|  ┌──────────────────────────────────────────────┐ |
|  │  [Search...]  [Mode v] [Status v] [Date v]   │ |  <- Filter bar
|  └──────────────────────────────────────────────┘ |
|                                                    |
|  TODAY                                             |
|  ┌─ Session 1 ──────── Completed ─── > ──────┐   |
|  ┌─ Session 2 ──────── Draft ─────── > ──────┐   |
|                                                    |
|  YESTERDAY                                         |
|  ┌─ Session 3 ──────── Completed ─── > ──────┐   |
|  ┌─ Session 4 ──────── Failed ────── > ──────┐   |
|                                                    |
|  FEB 12                                            |
|  ┌─ Session 5 ──────── Completed ─── > ──────┐   |
|                                                    |
|  ── 5 total | 3 completed | 1 draft | 1 failed ── |
+--------------------------------------------------+
```

**Key changes:**
1. **Group by date.** Show date headers ("Today," "Yesterday," "Feb 12") to create visual rhythm and temporal context.
2. **Add filter chips.** Mode (All/1v1/Group), Status (All/Completed/Draft/Failed), Date range. Use compact chip-style filters.
3. **Consistent search input.** Use `TextField` component with search icon, not a custom pill input.
4. **Enhanced session row.** Add participant names preview (truncated), duration, and template used.
5. **Animated list.** Stagger entrance animation for items (we already have `animate-slide-up`).

**Component additions:**
- `FilterBar` -- horizontal chip filter group
- `DateGroupHeader` -- sticky date section divider

---

## 3. Component System Additions

### 3.1 New Components

| Component | Purpose | Priority |
|---|---|---|
| `CompetencyRadar` | SVG radar chart for per-person dimension scores | High |
| `StepIndicator` | Horizontal wizard progress for SetupView | High |
| `SectionNav` | Sticky left sidebar navigation for FeedbackView | High |
| `DraftBanner` | Amber animated "finalizing" banner | Medium |
| `CompactAudioIndicator` | Single pulsing element for recording status | Medium |
| `DateGroupHeader` | Date divider for HistoryView | Medium |
| `FilterBar` | Horizontal chip filter group | Medium |
| `EvidenceTooltip` | Hover preview for evidence chips | Medium |
| `DimensionSummaryRow` | Collapsed dimension row with claim counts | Medium |
| `QuickStatsCard` | Lifetime stats display for HomeView | Low |
| `RecentSessionsList` | 3-item recent sessions for HomeView | Low |

### 3.2 Modifications to Existing Components

| Component | Change | Reason |
|---|---|---|
| `MeterBar` | Add `compact` variant (thin vertical bar) | SidecarView drawer needs smaller meters |
| `Card` | Add `active` prop for navigation highlight | SectionNav uses active card state |
| `Chip` | Add `filter` variant (toggle-able, with x) | FilterBar needs dismissible chips |
| `EmptyState` | Add `compact` variant (no icon, smaller text) | Inline use in collapsed sections |
| `StatusDot` | Add `pulse` animation variant | CompactAudioIndicator reuses StatusDot |
| `Modal` | Add `tooltip` mode (smaller, no backdrop) | EvidenceTooltip is a lightweight modal |

### 3.3 Shared Animation Variants

Add these to a new `src/lib/animations.ts` (or inline in components):

```typescript
// Page-level transitions (already in App.tsx, standardize)
export const pageTransition = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
};

// Staggered list items
export const staggerContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};
export const staggerItem = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
};

// Card hover (consistent across all hoverable cards)
export const cardHover = {
  whileHover: { y: -3, transition: { duration: 0.2 } },
  whileTap: { scale: 0.98 },
};

// Wizard step slide
export const stepSlideLeft = {
  initial: { opacity: 0, x: 40 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -40 },
  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
};
export const stepSlideRight = {
  initial: { opacity: 0, x: -40 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 40 },
  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
};

// Expand/collapse
export const expandCollapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.25 },
};
```

---

## 4. Animation & Motion Design

### 4.1 Page Transitions

**Current:** Fade + subtle Y translate (good, keep it)
**Enhancement:** Add `exit` animation direction that matches navigation intent:
- Forward navigation (Home -> Setup -> Session): slide left
- Backward navigation (Session -> Home): slide right
- This requires tracking navigation direction in a `useNavigationDirection` hook

### 4.2 Microinteractions

| Interaction | Timing | Easing | Properties |
|---|---|---|---|
| Button hover | 150ms | ease-out | `y: -1px`, subtle shadow increase |
| Card hover | 200ms | [0.22,1,0.36,1] | `y: -3px` |
| Chip click | 100ms | spring(400,17) | `scale: 0.95` then `1` |
| QuickMark button press | 120ms | spring(400,17) | `scale: 0.92` |
| Modal appear | 250ms | spring(300,28) | `scale: 0.8 -> 1`, `opacity: 0 -> 1` |
| Drawer open/close | 250ms | [0.22,1,0.36,1] | `width` animation |
| Stage advance | 200ms | ease-out | Previous stage text slides up, new slides down |
| Memo count increment | 300ms | spring | Number ticker animation |

### 4.3 Loading States

| Context | Animation |
|---|---|
| Report generating | Skeleton cards pulse (already have `Skeleton` component) |
| Evidence loading | Shimmer sweep over evidence chip placeholders |
| Transcript processing | Typing dots animation ("...") |
| Audio initializing | Mic icon with expanding ring animation |

### 4.4 Audio Visualization

**Current:** 3 horizontal `MeterBar` components in the context drawer
**Proposed:** In addition to drawer meters, add a subtle **header glow** effect:
- When mic/system audio is active, the header bottom border pulses from `border-border` to `border-accent` with a 1s cycle
- This is the "heartbeat" that reassures users recording is working without needing to check the drawer
- Implementation: CSS animation on `border-color` keyed to `audioLevels.mic > 0`

---

## 5. Typography & Spacing Refinements

### 5.1 Type Scale Adjustments

**Current type scale (from Tailwind defaults):**
- `text-4xl` (36px) -- Hero title only
- `text-2xl` (24px) -- Report title
- `text-xl` (20px) -- View titles
- `text-base` (16px) -- Person names, section headers
- `text-sm` (14px) -- Body text, claims
- `text-xs` (12px) -- Labels, metadata
- `text-[11px]` -- Card previews
- `text-[10px]` -- Chips, badges
- `text-[9px]` -- Timestamps in cards

**Recommendations:**
1. **Eliminate sub-12px text.** The `text-[11px]`, `text-[10px]`, and `text-[9px]` sizes are hard to read. Consolidate:
   - `text-[11px]` -> `text-xs` (12px)
   - `text-[10px]` -> `text-xs` (12px) with `text-ink-tertiary` for de-emphasis
   - `text-[9px]` -> `text-xs` (12px) with `tabular-nums` for timestamps
2. **View titles should be consistent.** All use `text-xl font-semibold` (already mostly true).
3. **Section headers.** Currently `text-xs font-medium uppercase tracking-wider` -- this is good, keep it.

### 5.2 Spacing Rhythm

**Adopt an 8px base grid:**
- Component internal padding: 16px (`p-4`) or 20px (`p-5`) -- standardize on `p-5` for cards
- Gap between cards: 16px (`gap-4`)
- Section spacing: 24px (`space-y-6`)
- Page padding: 24px (`px-6 py-6`)
- Tight groups (chips, badges): 6px (`gap-1.5`)

**Key fix:** The `space-y-6` in SetupView's card stack creates too much vertical space. With the wizard redesign, this is resolved. For other views, use `space-y-4` between cards within a section.

### 5.3 Content Density Guidelines

| View | Density | Rationale |
|---|---|---|
| HomeView | Low | Dashboard -- scannable at a glance |
| SetupView | Medium | Form -- enough space to breathe, but not wasteful |
| SidecarView | Low | Notepad -- maximum writing space |
| FeedbackView | Medium-High | Dense report content is expected |
| HistoryView | Medium | List view -- balanced |
| SettingsView | Medium | Form/settings -- comfortable |

---

## 6. Empty States, Loading, Error UX

### 6.1 Empty State Designs

| View | Empty State | Visual |
|---|---|---|
| HomeView - Recent | "No sessions yet" | `Clock` icon + "Start your first interview session" + CTA |
| HomeView - Pending | "All caught up" | `CheckCircle` icon (already exists, keep) |
| HistoryView - No results | "No sessions found" | `Search` icon + "Try different search terms" |
| HistoryView - Empty | "Your sessions will appear here" | `Folder` icon + "Start a session to see it here" + CTA |
| FeedbackView - No memos | "No session notes" | `BookOpen` icon (already exists, good) |
| SidecarView - Memo bar | Inline text: "Type notes, then Cmd+1-4 to capture" | No icon needed |

**Design principle:** Empty states should always (1) explain what goes here, (2) suggest what action to take, (3) optionally provide a direct CTA button.

### 6.2 Skeleton Loader Patterns

We already have a `Skeleton` component. Define standard skeleton patterns for each view:

- **FeedbackView skeleton:**
  - Header: 2 skeleton lines (title + metadata)
  - Overall card: 4 skeleton lines + 2 skeleton chips
  - Person card: skeleton header + 3 skeleton claim rows
  - Evidence timeline: 5 skeleton rows

- **HistoryView skeleton:**
  - 5 skeleton `SessionRow` items (icon circle + 2 lines + chip)

- **HomeView skeleton:**
  - Greeting line: 1 skeleton line
  - 2 skeleton cards

### 6.3 Error State Designs

| Error | Design | Recovery |
|---|---|---|
| Network disconnected | Amber banner at top: "Connection lost. Reconnecting..." | Auto-retry with backoff |
| Audio permission denied | Red banner: "Microphone access required" | "Open System Preferences" button |
| Session creation failed | Inline error below Start button: "Could not create session" | Retry button |
| Report generation failed | Error card replacing skeleton: "Report generation failed" | "Try again" + "Contact support" |
| WebSocket dropped | Status dot turns amber, tooltip: "Reconnecting..." | Auto-reconnect (exponential backoff) |

**Design principle:** Errors should be (1) visible but not alarming, (2) actionable with a clear recovery path, (3) non-blocking when possible (degrade gracefully).

### 6.4 Connection Loss Handling

During a recording session, connection loss is critical. Design a 3-tier visual system:

1. **Tier 1 -- Brief hiccup (<5s).** StatusDot turns amber, no user-facing text. Auto-reconnect silently.
2. **Tier 2 -- Extended disconnect (5-30s).** Amber banner slides in below header: "Reconnecting to server... Audio is still being recorded locally." Recording continues.
3. **Tier 3 -- Persistent failure (>30s).** Banner turns red: "Connection lost. Your audio is saved locally. [End Session] [Keep Trying]"

---

## 7. Accessibility Checklist

### 7.1 Keyboard Navigation

| Area | Current | Improvement |
|---|---|---|
| SetupView wizard | Tab through all fields | Add `Enter` to advance step, `Escape` to go back |
| SidecarView | Cmd+1-4 shortcuts exist | Add `Cmd+N` for "Next Stage," `Cmd+E` for "End Session" |
| FeedbackView | No keyboard nav for sections | Add `Cmd+[` / `Cmd+]` to navigate between person tabs |
| HistoryView | No keyboard nav | Add `Up/Down` arrow key navigation through session list |
| Modal dialogs | Escape to close (if implemented) | Verify focus trap in all modals |
| Evidence chips | Not keyboard focusable | Add `tabIndex={0}` and `Enter` to open detail |

### 7.2 Screen Reader Considerations

- All icon-only buttons must have `aria-label` (mostly done, verify completeness)
- Status changes (recording start/stop, stage advance) should use `aria-live="polite"` announcements
- Evidence confidence badges should read as "85% confidence" not just the number
- Radar chart needs a text alternative: "Leadership: 4/5, Collaboration: 3/5, ..." as `aria-label`
- Draft/Final status should be announced: `role="status"` on the banner

### 7.3 Color Contrast

| Element | Current | WCAG AA | Fix Needed? |
|---|---|---|---|
| `text-ink` on `bg` | #1E2A32 on #F6F2EA | 8.5:1 | No |
| `text-ink-secondary` on `bg` | #637380 on #F6F2EA | 4.0:1 | Borderline -- increase to #566A77 |
| `text-ink-tertiary` on `bg` | #9CA8B2 on #F6F2EA | 2.5:1 | Yes -- only use for decorative text, not info-bearing |
| `text-accent` on `bg` | #0D6A63 on #F6F2EA | 5.2:1 | OK |
| `text-accent` on `accent-soft` | #0D6A63 on #DCF0ED | 4.1:1 | Borderline |
| White on `accent` | #FFF on #0D6A63 | 5.3:1 | OK |
| `text-warning` on white | #D97706 on #FFF | 3.4:1 | Fail -- darken to #B45309 |

**Action items:**
- Darken `--color-ink-secondary` slightly to ensure 4.5:1 on bg
- Darken `--color-warning` to #B45309 for text use
- Never use `text-ink-tertiary` for information-bearing text (only decorative or supplementary)

### 7.4 Focus Management

- When navigating to a new view, focus should move to the view's `<h1>` element
- When opening a modal, focus should move to the first focusable element inside
- When closing a modal, focus should return to the trigger element
- In SetupView wizard, focus should move to the first input of the new step
- `tabIndex={-1}` on heading elements to allow programmatic focus without visual indicator

---

## 8. Implementation Priority

### Phase 1 -- Highest Impact, Least Code (1-2 days)
1. **SidecarView: Notes-first layout** -- Move QuickMarkBar to bottom, collapse MemoTimeline, shrink drawer
2. **FeedbackView: Add SectionNav** -- Sticky left nav for report sections
3. **FeedbackView: Collapsible dimensions** -- DimensionSummaryRow (collapsed by default)
4. **Typography cleanup** -- Eliminate sub-12px text sizes
5. **Color contrast fixes** -- Darken warning and ink-secondary

### Phase 2 -- High Impact, Medium Effort (2-3 days)
6. **SetupView: Wizard conversion** -- 3-step flow with StepIndicator
7. **FeedbackView: CompetencyRadar** -- SVG radar chart per person
8. **HomeView: Compact hero + Recent Sessions** -- Dashboard refinement
9. **HistoryView: Date grouping + filters** -- Better organization
10. **DraftBanner** -- Animated finalizing status

### Phase 3 -- Polish (1-2 days)
11. **Animation standardization** -- Shared animation variants
12. **Skeleton loaders** -- Per-view loading patterns
13. **Error/connection loss states** -- 3-tier system
14. **Accessibility audit** -- Keyboard nav, screen reader, contrast
15. **EvidenceTooltip** -- Hover previews

---

## 9. Design Principles (Summary)

Drawing from competitor analysis, our design should follow these principles:

1. **Notes-first.** During recording, the notepad is the product. Everything else is secondary chrome.
2. **Trust through transparency.** Visually distinguish user input from AI output. Show confidence scores. Mark weak evidence.
3. **Evidence-backed claims.** Every AI assertion links to a timestamped, speaker-attributed quote. No ungrounded claims.
4. **Progressive disclosure.** Show summaries first, details on demand. Collapsed by default, expandable.
5. **Warm professionalism.** Our #F6F2EA + #0D6A63 palette is warmer than competitors. Lean into this -- use generous whitespace and soft shadows to create a calm, trustworthy environment.
6. **Quiet confidence.** Premium UX is about what you remove, not what you add. Reduce visual noise, increase breathing room.
