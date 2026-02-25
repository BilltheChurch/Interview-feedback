# Code Review Fixes & Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all HIGH/MEDIUM/LOW issues from the 2026-02-25 deep code review — XSS, PDF security, race conditions, type safety, performance, and code cleanup.

**Architecture:** All changes are contained within `desktop/` (Electron main + React renderer + sanitize lib) and `inference/` (Python schema defaults). No new dependencies. Fix severity order: HIGH → MEDIUM → LOW.

**Tech Stack:** TypeScript, Electron (main.js), React, Tailwind v4, Python/Pydantic

**Batches:**
- Batch 1 (Tasks 1-4): HIGH + MEDIUM security — XSS, PDF hardening, data URL fix
- Batch 2 (Tasks 5-7): MEDIUM reliability — export guards, font loading, type consolidation
- Batch 3 (Tasks 8-11): LOW cleanup — performance, defensive guards, dead code, demo data

---

### Task 1: Add `escapeHtml` + `sanitizeHtml` to sanitize lib

**Files:**
- Modify: `desktop/src/lib/sanitize.ts`
- Create: `desktop/src/lib/__tests__/sanitize.test.ts`

**Step 1: Write the failing tests**

```ts
// desktop/src/lib/__tests__/sanitize.test.ts
import { describe, it, expect } from 'vitest';
import { escapeHtml, sanitizeHtml } from '../sanitize';

describe('escapeHtml', () => {
  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('passes through clean text unchanged', () => {
    expect(escapeHtml('Hello world 你好')).toBe('Hello world 你好');
  });
});

describe('sanitizeHtml', () => {
  it('strips script tags', () => {
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('strips on* event handlers', () => {
    expect(sanitizeHtml('<img onerror="alert(1)" src="x">')).not.toContain('onerror');
  });

  it('strips javascript: hrefs', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).not.toContain('javascript:');
  });

  it('preserves safe HTML', () => {
    const safe = '<p>Hello <b>world</b></p>';
    expect(sanitizeHtml(safe)).toContain('<p>');
    expect(sanitizeHtml(safe)).toContain('<b>');
  });

  it('strips iframe, object, embed, form tags', () => {
    const dirty = '<iframe src="evil.com"></iframe><p>safe</p>';
    expect(sanitizeHtml(dirty)).toBe('<p>safe</p>');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd desktop && npx vitest run src/lib/__tests__/sanitize.test.ts`
Expected: FAIL — `escapeHtml` and `sanitizeHtml` not exported

**Step 3: Implement `escapeHtml` and `sanitizeHtml`**

Add to end of `desktop/src/lib/sanitize.ts`:

```ts
/**
 * Escape HTML special characters to prevent XSS in generated HTML strings.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize untrusted HTML: strip dangerous tags and attributes.
 * Used for rendering TipTap notes from localStorage.
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove dangerous elements
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'style']) {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  }
  // Remove dangerous attributes
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || attr.value.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}
```

Note: vitest uses jsdom which provides DOMParser. No additional dependency needed.

**Step 4: Run tests to verify they pass**

Run: `cd desktop && npx vitest run src/lib/__tests__/sanitize.test.ts`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add desktop/src/lib/sanitize.ts desktop/src/lib/__tests__/sanitize.test.ts
git commit -m "feat: add escapeHtml + sanitizeHtml to sanitize lib"
```

---

### Task 2: Apply XSS protections in FeedbackView

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx`

This task fixes HIGH issue #1 (dangerouslySetInnerHTML) and HIGH issue #2 (markdownToSimpleHtml no-escape).

**Step 1: Import sanitize helpers**

At top of `FeedbackView.tsx`, add import alongside existing imports from `../lib/`:

```ts
import { escapeHtml, sanitizeHtml } from '../lib/sanitize';
```

**Step 2: Protect `dangerouslySetInnerHTML` usages**

At line ~1264, wrap in `sanitizeHtml`:
```tsx
// BEFORE:
dangerouslySetInnerHTML={{ __html: archive.freeformHtml || archive.freeformText }}
// AFTER:
dangerouslySetInnerHTML={{ __html: sanitizeHtml(archive.freeformHtml || archive.freeformText || '') }}
```

At line ~1325, wrap in `sanitizeHtml`:
```tsx
// BEFORE:
dangerouslySetInnerHTML={{ __html: notes }}
// AFTER:
dangerouslySetInnerHTML={{ __html: sanitizeHtml(notes) }}
```

**Step 3: Add `escapeHtml` to `markdownToSimpleHtml`**

In the `markdownToSimpleHtml` function (~line 1643), escape content before wrapping in HTML tags. The function needs `escapeHtml` applied to the text portions (not the markdown syntax markers):

```ts
function markdownToSimpleHtml(md: string): string {
  return md
    .split('\n')
    .map(line => {
      // Headers
      if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      // Escape first, then apply inline formatting
      line = escapeHtml(line);
      // Bold (on escaped text, ** markers are safe since < > are escaped)
      line = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      // Italic
      line = line.replace(/_(.+?)_/g, '<i>$1</i>');
      // Numbered list items
      if (/^\d+\.\s/.test(line)) return `<li>${line.replace(/^\d+\.\s/, '')}</li>`;
      // List items
      if (line.startsWith('- ')) return `<li>${line.slice(2)}</li>`;
      // Blockquote
      if (line.startsWith('&gt; ')) return `<blockquote>${line.slice(5)}</blockquote>`;
      // Table rows (> is now &gt; from escapeHtml, | is safe)
      if (line.startsWith('|') && !line.match(/^\|[-|]+\|$/)) {
        const cells = line.split('|').filter(c => c.trim() !== '');
        return `<tr>${cells.map(c => `<td>${c.trim()}</td>`).join('')}</tr>`;
      }
      // Table separator — skip
      if (line.match(/^\|[-|]+\|$/)) return '';
      // Empty lines = paragraph breaks
      if (line.trim() === '') return '<br/>';
      return `<p>${line}</p>`;
    })
    .join('\n');
}
```

Key change: `escapeHtml(line)` is called early so all user content is escaped. The `>` in blockquote becomes `&gt;` so the blockquote check adapts to `'&gt; '`.

**Step 4: Verify build**

Run: `cd desktop && npx tsc --noEmit && npx vitest run`
Expected: 0 TS errors, all tests pass

**Step 5: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "fix(security): XSS protection for dangerouslySetInnerHTML and markdownToSimpleHtml"
```

---

### Task 3: Harden PDF BrowserWindow + replace data URL with temp file

**Files:**
- Modify: `desktop/main.js:1000-1041`

This task fixes MEDIUM issues #3 (data URL size limit) and #4 (missing webPreferences).

**Step 1: Rewrite the `export:printToPDF` handler**

Replace lines 1000-1041 in `main.js`:

```js
  // ── Export PDF ────────────────────────────────
  // Uses a hidden offscreen BrowserWindow to render print-optimized HTML,
  // so the main UI is never disturbed and PDF pagination is clean.
  ipcMain.handle('export:printToPDF', async (_event, options) => {
    if (!mainWindow) throw new Error('No main window');

    const htmlContent = options?.html || '';
    const defaultName = (options?.sessionName || 'feedback-report').replace(/[/\\?%*:|"<>]/g, '_');

    // Ask where to save first, so user isn't waiting during render
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export PDF',
      defaultPath: `${defaultName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!filePath) return { success: false };

    // Write HTML to temp file (avoids Chromium 2MB data-URL limit, especially for CJK)
    const tmpHtmlPath = path.join(app.getPath('temp'), `ifb-pdf-export-${Date.now()}.html`);
    fs.writeFileSync(tmpHtmlPath, htmlContent, 'utf-8');

    // Create hidden offscreen window with explicit security hardening
    const pdfWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });

    try {
      await pdfWindow.loadFile(tmpHtmlPath);
      // Wait for fonts to be ready (replaces fragile fixed 500ms timeout)
      await pdfWindow.webContents.executeJavaScript(
        'document.fonts.ready.then(() => true)'
      );

      const pdfData = await pdfWindow.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        preferCSSPageSize: false,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      });

      fs.writeFileSync(filePath, pdfData);
      return { success: true, path: filePath };
    } finally {
      pdfWindow.destroy();
      try { fs.unlinkSync(tmpHtmlPath); } catch { /* temp file cleanup best-effort */ }
    }
  });
```

**Step 2: Verify app launches and PDF export works**

Run: `cd desktop && npm run dev`
Manual test: Open Feedback → Export PDF → verify dialog shows, PDF generates, no error in console.

**Step 3: Commit**

```bash
git add desktop/main.js
git commit -m "fix(security): harden PDF window + replace data URL with temp file"
```

---

### Task 4: Add export button loading guards (prevent double-click)

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx` (FeedbackHeader component)

This task fixes MEDIUM issue #5 (concurrent export). All 4 export buttons (Markdown, DOCX, PDF, Slack) need a guard.

**Step 1: Add `exporting` state in FeedbackHeader**

Find the FeedbackHeader function component (around line ~1800). Add a state variable near the existing states:

```ts
const [exporting, setExporting] = useState<string | null>(null);
```

**Step 2: Wrap each export handler**

Replace the PDF button's onClick (around line ~1958):

```tsx
<Button variant="secondary" size="sm" disabled={!!exporting} onClick={async () => {
  if (exporting) return;
  setExporting('pdf');
  try {
    const html = buildPrintHtml(report, sessionNotes, sessionMemos);
    const result = await window.desktopAPI.exportPDF({
      sessionName: report.session_name,
      html,
    });
    if (result.success) {
      // success
    }
  } catch (err) {
    console.warn('PDF export failed:', err);
  } finally {
    setExporting(null);
  }
}} className="transition-all duration-200">
  <FileText className="w-3.5 h-3.5" />
  {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
</Button>
```

Apply similar pattern to:
- Markdown button (around line ~1920): `setExporting('md')` / `finally { setExporting(null) }`
- DOCX button (around line ~1935): `setExporting('docx')` / `finally { setExporting(null) }`
- Slack button (around line ~1975): `setExporting('slack')` / `finally { setExporting(null) }`

All buttons should have `disabled={!!exporting}` to grey out during any export.

**Step 3: Verify build**

Run: `cd desktop && npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "fix: add loading guards to prevent concurrent export operations"
```

---

### Task 5: Consolidate QuestionAnalysisItem type

**Files:**
- Modify: `desktop/src/components/QuestionBreakdownSection.tsx`
- Modify: `desktop/src/views/FeedbackView.tsx`

This task fixes LOW issue #9 (duplicate type definitions).

**Step 1: Export the canonical type from QuestionBreakdownSection**

The component already exports `QuestionAnalysisItem`. Verify it is the superset (has all optional fields). Current export at line 12-22 already has all fields.

**Step 2: Import and use in FeedbackView**

In `FeedbackView.tsx`, add the import:

```ts
import { QuestionBreakdownSection, type QuestionAnalysisItem } from '../components/QuestionBreakdownSection';
```

Remove the local `type QuestionAnalysisItem` definition (around line 143-153). Replace the existing import line:

```ts
// BEFORE:
import { QuestionBreakdownSection } from '../components/QuestionBreakdownSection';
// AFTER:
import { QuestionBreakdownSection, type QuestionAnalysisItem } from '../components/QuestionBreakdownSection';
```

**Step 3: Verify build**

Run: `cd desktop && npx tsc --noEmit`
Expected: 0 errors (types are structurally compatible)

**Step 4: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx desktop/src/components/QuestionBreakdownSection.tsx
git commit -m "refactor: consolidate QuestionAnalysisItem type to single source"
```

---

### Task 6: Memoize transcript lookup + fix duplicate getAnswerText calls

**Files:**
- Modify: `desktop/src/components/QuestionBreakdownSection.tsx`

This task fixes LOW issues #7 (duplicate call) and part of #8 (performance).

**Step 1: Add useMemo for transcript Map + compute answers once**

Replace the current `getAnswerText` and rendering logic:

```tsx
import { useState, useMemo } from 'react';

export function QuestionBreakdownSection({ questions, transcript }: Props) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const toggle = (i: number) => setExpandedIdx(prev => prev === i ? null : i);

  // O(1) lookup map instead of O(n) find per utterance ID
  const transcriptMap = useMemo(() => {
    const map = new Map<string, TranscriptUtterance>();
    for (const u of transcript ?? []) {
      map.set(u.utterance_id, u);
    }
    return map;
  }, [transcript]);

  // Pre-compute answer text for each question (avoids duplicate calls)
  const answerTexts = useMemo(() =>
    questions.map(q => {
      if (!q.answer_utterance_ids?.length || transcriptMap.size === 0) return null;
      const texts = q.answer_utterance_ids
        .map(id => transcriptMap.get(id))
        .filter(Boolean)
        .map(u => u!.text);
      return texts.length > 0 ? texts.join(' ') : null;
    }),
  [questions, transcriptMap]);

  const hasDetail = (q: QuestionAnalysisItem, answerText: string | null) =>
    !!(q.scoring_rationale || q.answer_highlights?.length || q.answer_weaknesses?.length || q.suggested_better_answer || answerText);

  return (
    <div className="space-y-3">
      {questions.map((q, i) => {
        const quality = QUALITY_CONFIG[q.answer_quality as keyof typeof QUALITY_CONFIG] || QUALITY_CONFIG.C;
        const expanded = expandedIdx === i;
        const answerText = answerTexts[i];
        const expandable = hasDetail(q, answerText);
        // ... rest of JSX unchanged
```

**Step 2: Verify build and tests**

Run: `cd desktop && npx tsc --noEmit && npx vitest run`
Expected: 0 errors, all tests pass

**Step 3: Commit**

```bash
git add desktop/src/components/QuestionBreakdownSection.tsx
git commit -m "perf: memoize transcript lookup and deduplicate getAnswerText calls"
```

---

### Task 7: Add defensive guards for `related_dimensions`

**Files:**
- Modify: `desktop/src/components/QuestionBreakdownSection.tsx`

This task fixes LOW issue #8 (null safety).

**Step 1: Add optional chaining**

In the JSX around line 75, change:

```tsx
// BEFORE:
{q.related_dimensions.length > 0 && (
// AFTER:
{(q.related_dimensions?.length ?? 0) > 0 && (
```

And in the map call:

```tsx
// BEFORE:
{q.related_dimensions.map(d => (
// AFTER:
{(q.related_dimensions ?? []).map(d => (
```

**Step 2: Verify build**

Run: `cd desktop && npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add desktop/src/components/QuestionBreakdownSection.tsx
git commit -m "fix: defensive null guard for related_dimensions in QuestionBreakdownSection"
```

---

### Task 8: Fix table header dead branch in markdownToSimpleHtml

**Files:**
- Modify: `desktop/src/views/FeedbackView.tsx`

This task fixes LOW issue #12 (dead code branch `cells.length > 0 ? 'td' : 'td'`).

**Step 1: Fix the table rendering**

Note: After Task 2, the `markdownToSimpleHtml` function is already rewritten. Verify that the dead branch is gone. If it still exists (around line ~1664 area), the already-fixed version from Task 2 should have replaced it with just `<td>`. If not, replace:

```tsx
// BEFORE:
const tag = cells.length > 0 ? 'td' : 'td';
return `<tr>${cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('')}</tr>`;

// AFTER (with first-row header detection):
return `<tr>${cells.map(c => `<td>${c.trim()}</td>`).join('')}</tr>`;
```

The first-row header styling is handled by CSS in `buildPrintHtml` (`tr:first-child td { background: #F6F2EA; font-weight: 600; }`).

**Step 2: Verify build**

Run: `cd desktop && npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add desktop/src/views/FeedbackView.tsx
git commit -m "fix: remove dead branch in table rendering"
```

---

### Task 9: Add default `answer_quality` fallback in inference parser

**Files:**
- Modify: `inference/app/services/report_synthesizer.py`

This task fixes LOW issues #4.2 and #4.3 (empty quality string propagates silently).

**Step 1: Add default quality**

In `report_synthesizer.py`, after the quality validation (~line 836-838):

```python
# BEFORE:
quality = str(qa.get("answer_quality", "")).strip().upper()
if quality not in ("A", "B", "C", "D"):
    quality = ""

# AFTER:
quality = str(qa.get("answer_quality", "")).strip().upper()
if quality not in ("A", "B", "C", "D"):
    quality = "C"  # Default for unparseable quality grades
```

**Step 2: Run inference tests**

Run: `cd inference && python -m pytest tests/test_report_synthesizer.py -v`
Expected: All 43 tests pass

**Step 3: Commit**

```bash
git add inference/app/services/report_synthesizer.py
git commit -m "fix: default answer_quality to C when LLM returns invalid grade"
```

---

### Task 10: Clean up orphaned localStorage version keys

**Files:**
- Modify: `desktop/src/demo/injectDemoSession.ts`

This task fixes LOW issue #11 (orphaned v1-v7 keys).

**Step 1: Add cleanup in upgradeWeiYixinSession**

At the start of `upgradeWeiYixinSession()`, before the version check, add:

```ts
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
  // ... rest unchanged
```

**Step 2: Verify build**

Run: `cd desktop && npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add desktop/src/demo/injectDemoSession.ts
git commit -m "chore: clean up orphaned demo version keys from localStorage"
```

---

### Task 11: Add enrichment fields to demo-result-v2.json (standalone demo)

**Files:**
- Modify: `desktop/src/demo/demo-result-v2.json`

This task fixes LOW issue #10 (standalone demo missing B-layer fields).

**Step 1: Check current demo-result-v2.json for question_analysis**

Read the `question_analysis` section in `demo-result-v2.json`. If it exists but lacks the new fields (`scoring_rationale`, `answer_highlights`, `answer_weaknesses`, `suggested_better_answer`), add realistic Chinese analysis data to each question entry — same pattern as `wei-yixin-result-v2.json`.

If `question_analysis` does not exist in this file, skip this task (the standalone demo may not have this section).

**Step 2: Verify build**

Run: `cd desktop && npx vite build 2>&1 | tail -3`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add desktop/src/demo/demo-result-v2.json
git commit -m "chore: add enrichment fields to standalone demo data"
```

---

## Verification Checklist

After all tasks complete, run full verification:

```bash
# TypeScript
cd desktop && npx tsc --noEmit

# Desktop tests
cd desktop && npx vitest run

# Inference tests
cd inference && python -m pytest tests/ -v

# Production build
cd desktop && npx vite build
```

Expected: 0 TS errors, 70+ desktop tests pass, 200 inference tests pass, vite build succeeds.

## Summary

| Task | Severity | Issue |
|------|----------|-------|
| 1 | HIGH | `escapeHtml` + `sanitizeHtml` library functions |
| 2 | HIGH | Apply XSS protection to `dangerouslySetInnerHTML` + `markdownToSimpleHtml` |
| 3 | MEDIUM | PDF BrowserWindow hardening + temp file (replaces data URL) |
| 4 | MEDIUM | Export button loading guards (prevent double-click) |
| 5 | LOW | Consolidate `QuestionAnalysisItem` type definition |
| 6 | LOW | Memoize transcript lookup + deduplicate calls |
| 7 | LOW | Defensive null guard for `related_dimensions` |
| 8 | LOW | Fix table header dead branch |
| 9 | LOW | Default `answer_quality` to "C" in inference parser |
| 10 | LOW | Clean up orphaned localStorage version keys |
| 11 | LOW | Add enrichment fields to standalone demo data |
