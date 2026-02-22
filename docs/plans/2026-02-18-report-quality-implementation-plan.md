# Report Quality Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 4 report quality issues — evidence mapping (25%→75%+), tentative status (too strict), talk time inflation (763s vs 490s), and sparse content (22→35+ claims).

**Architecture:** Changes span Worker (finalize_v2.ts, index.ts, types_v2.ts) and Inference (report_synthesizer.py, schemas.py). Worker-side builds richer evidence before calling LLM; LLM prompt gets new instructions and richer input; stats calculation adds global dedup; tentative logic uses soft thresholds.

**Tech Stack:** TypeScript (Cloudflare Worker), Python (FastAPI/Pydantic), Vitest, pytest

---

### Task 1: Update types (types_v2.ts + schemas.py)

**Files:**
- Modify: `edge/worker/src/types_v2.ts:115-178`
- Modify: `inference/app/schemas.py:266-373`

**Step 1: Add `talk_time_pct`, `confidence_level`, `binding_source` to types_v2.ts**

In `SpeakerStatItem` (line 170), add `talk_time_pct`:

```typescript
export interface SpeakerStatItem {
  speaker_key: string;
  speaker_name?: string | null;
  talk_time_ms: number;
  talk_time_pct: number;           // NEW: percentage of audio duration
  turns: number;
  silence_ms: number;
  interruptions: number;
  interrupted_by_others: number;
}
```

In `EvidenceItem` (line 115), add `source` field:

```typescript
export interface EvidenceItem {
  evidence_id: string;
  type: "quote" | "segment" | "stats_summary" | "interaction_pattern" | "transcript_quote";  // EXPANDED
  time_range_ms: [number, number];
  utterance_ids: string[];
  speaker: {
    cluster_id?: string | null;
    person_id?: string | null;
    display_name?: string | null;
  };
  quote: string;
  confidence: number;
  weak?: boolean;
  weak_reason?: string | null;
  source?: "explicit_anchor" | "semantic_match" | "speaker_fallback" | "memo_text" | "llm_backfill" | "auto_generated";  // NEW
}
```

In `ResultV2.session` (line 180), add `confidence_level`:

```typescript
export interface ResultV2 {
  session: {
    session_id: string;
    finalized_at: string;
    tentative: boolean;
    confidence_level: "high" | "medium" | "low";  // NEW
    unresolved_cluster_count: number;
    diarization_backend: "cloud" | "edge";
  };
  // ... rest unchanged
}
```

In `SynthesizeRequestPayload` (line 296), add `stats_observations`:

```typescript
export interface SynthesizeRequestPayload {
  // ... existing fields ...
  stats_observations?: string[];  // NEW: auto-generated stats insights
}
```

**Step 2: Update schemas.py**

In `SynthesizeReportRequest` (line 450), add `stats_observations`:

```python
class SynthesizeReportRequest(BaseModel):
    # ... existing fields ...
    stats_observations: list[str] = Field(default_factory=list)  # NEW
```

**Step 3: Run type checks**

Run: `cd edge/worker && npx tsc --noEmit 2>&1 | head -30`
Expected: Type errors in places that construct these types (will fix in later tasks)

Run: `cd inference && python -m pytest tests/ -x --co -q 2>&1 | head -10`
Expected: Tests still collect OK

**Step 4: Commit**

```bash
git add edge/worker/src/types_v2.ts inference/app/schemas.py
git commit -m "feat(types): add confidence_level, talk_time_pct, evidence source, stats_observations"
```

---

### Task 2: Rewrite evidence semantic matching (finalize_v2.ts)

**Files:**
- Modify: `edge/worker/src/finalize_v2.ts:267-416`
- Test: `edge/worker/tests/reconcile.test.ts`

**Step 1: Write failing test for semantic matching**

Add to `edge/worker/tests/reconcile.test.ts`:

```typescript
import { buildMultiEvidence } from "../src/finalize_v2";

describe("buildMultiEvidence semantic matching", () => {
  const transcript = [
    { utterance_id: "u1", stream_role: "students" as const, cluster_id: "Tina", speaker_name: "Tina", decision: "confirm" as const, text: "I think biocompatibility is the most important factor because without it patients may get rejection reactions", start_ms: 200000, end_ms: 210000, duration_ms: 10000 },
    { utterance_id: "u2", stream_role: "students" as const, cluster_id: "Rice", speaker_name: "Rice", decision: "confirm" as const, text: "I agree with Tina and I also think repair should be easy", start_ms: 210000, end_ms: 220000, duration_ms: 10000 },
    { utterance_id: "u3", stream_role: "students" as const, cluster_id: "Daisy", speaker_name: "Daisy", decision: "confirm" as const, text: "Maybe we should start ranking these factors now", start_ms: 230000, end_ms: 240000, duration_ms: 10000 },
  ];

  const memos = [
    { memo_id: "m1", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: ["logic"], text: "Tina提出了biocompatibility，给了很好的论证" },
    { memo_id: "m2", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: ["collaboration"], text: "Rice同意了Tina的观点，提出了repair" },
  ];

  const bindings = [
    { memo_id: "m1", extracted_names: ["Tina"], matched_speaker_keys: ["Tina"], confidence: 1.0 },
    { memo_id: "m2", extracted_names: ["Rice", "Tina"], matched_speaker_keys: ["Rice", "Tina"], confidence: 1.0 },
  ];

  it("should map memos to utterances by speaker name + keyword", () => {
    const evidence = buildMultiEvidence({ memos, transcript, bindings });
    // Memo about Tina+biocompatibility should map to u1 (Tina's utterance containing "biocompatib")
    const tinaEvidence = evidence.filter(e => e.utterance_ids.includes("u1"));
    expect(tinaEvidence.length).toBeGreaterThanOrEqual(1);
    expect(tinaEvidence[0].confidence).toBeGreaterThanOrEqual(0.45);
    expect(tinaEvidence[0].source).toBe("semantic_match");
  });

  it("should use dynamic confidence scores, not hardcoded", () => {
    const evidence = buildMultiEvidence({ memos, transcript, bindings });
    const memoEvidence = evidence.filter(e => e.utterance_ids.length > 0 && e.type === "quote");
    const confidences = memoEvidence.map(e => e.confidence);
    // Should NOT all be the same hardcoded value
    const unique = new Set(confidences.map(c => Math.round(c * 100)));
    expect(unique.size).toBeGreaterThanOrEqual(1);
    // All should be in valid range
    for (const c of confidences) {
      expect(c).toBeGreaterThanOrEqual(0.35);
      expect(c).toBeLessThanOrEqual(0.95);
    }
  });

  it("should create fallback evidence with source=memo_text when no match", () => {
    const noMatchMemos = [
      { memo_id: "m_nomatch", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "整体节奏可以再快一些" },
    ];
    const evidence = buildMultiEvidence({ memos: noMatchMemos, transcript, bindings: [] });
    const fallback = evidence.find(e => e.utterance_ids.length === 0);
    expect(fallback).toBeDefined();
    expect(fallback!.confidence).toBe(0.35);
    expect(fallback!.source).toBe("memo_text");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts -t "semantic matching" 2>&1 | tail -10`
Expected: FAIL — `source` property doesn't exist yet on evidence items

**Step 3: Rewrite `buildMultiEvidence` with semantic matching**

Replace `buildMultiEvidence` function (lines 285-416) with new implementation:

```typescript
export function buildMultiEvidence(options: {
  memos: MemoItem[];
  transcript: TranscriptItem[];
  bindings: MemoSpeakerBinding[];
}): EvidenceItem[] {
  const { memos, transcript, bindings } = options;
  const sorted = [...transcript].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const weakUtterances = buildWeakEvidenceUtteranceSet(transcript);
  const bindingByMemoId = new Map(bindings.map((b) => [b.memo_id, b]));

  // Build speaker→utterances index for fast lookup
  const utterancesBySpeaker = new Map<string, TranscriptItem[]>();
  for (const u of sorted) {
    const key = speakerKey(u);
    const list = utterancesBySpeaker.get(key) ?? [];
    list.push(u);
    utterancesBySpeaker.set(key, list);
  }

  const evidence: EvidenceItem[] = [];
  let seq = 1;

  function nextEvidenceId(): string {
    return `e_${String(seq++).padStart(6, "0")}`;
  }

  for (const memo of memos) {
    const memoBinding = bindingByMemoId.get(memo.memo_id);
    const boundSpeakers = memoBinding?.matched_speaker_keys ?? [];

    // 1. Check explicit anchors first
    const anchoredIds = new Set(memo.anchors?.utterance_ids ?? []);
    if (anchoredIds.size > 0) {
      for (const u of sorted) {
        if (!anchoredIds.has(u.utterance_id)) continue;
        const isWeak = weakUtterances.has(u.utterance_id);
        evidence.push({
          evidence_id: nextEvidenceId(),
          type: "quote",
          time_range_ms: [u.start_ms, u.end_ms],
          utterance_ids: [u.utterance_id],
          speaker: {
            cluster_id: u.cluster_id ?? null,
            person_id: u.speaker_name ?? null,
            display_name: u.speaker_name ?? null,
          },
          quote: quoteFromUtterance(u.text),
          confidence: isWeak ? 0.75 : 0.90,
          weak: isWeak,
          weak_reason: isWeak ? "overlap_risk" : null,
          source: "explicit_anchor",
        });
      }
      continue; // Skip semantic matching for anchored memos
    }

    // 2. Semantic matching: filter candidates by speaker, then score by content
    const candidates: TranscriptItem[] = [];
    if (boundSpeakers.length > 0) {
      // Get utterances from bound speakers
      for (const spk of boundSpeakers) {
        const spkUtterances = utterancesBySpeaker.get(spk) ?? [];
        candidates.push(...spkUtterances);
      }
    } else {
      // No speaker binding: search all utterances
      candidates.push(...sorted);
    }

    // 3. Score candidates
    const scored = candidates.map((u) => {
      const kw = keywordOverlap(memo.text, u.text);
      const nameMatch = boundSpeakers.length > 0 && u.speaker_name
        ? (boundSpeakers.includes(u.speaker_name) ? 1.0 : 0.0)
        : 0.5;
      // Content semantic: check if memo describes something visible in utterance
      const contentBoost = contentSemanticScore(memo.text, u.text);

      const score = 0.50 * kw + 0.30 * nameMatch + 0.20 * contentBoost;
      return { utterance: u, score };
    });

    // 4. Sort by score, take top 3
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, 3).filter((s) => s.score > 0.05);

    // 5. Create evidence for each match
    for (const { utterance: u, score } of picked) {
      const isWeak = weakUtterances.has(u.utterance_id);
      const rawConf = score * 0.95;
      const confidence = Math.min(0.90, Math.max(0.45, isWeak ? rawConf - 0.15 : rawConf));
      evidence.push({
        evidence_id: nextEvidenceId(),
        type: "quote",
        time_range_ms: [u.start_ms, u.end_ms],
        utterance_ids: [u.utterance_id],
        speaker: {
          cluster_id: u.cluster_id ?? null,
          person_id: u.speaker_name ?? null,
          display_name: u.speaker_name ?? null,
        },
        quote: quoteFromUtterance(u.text),
        confidence,
        weak: isWeak,
        weak_reason: isWeak ? "overlap_risk" : null,
        source: "semantic_match",
      });
    }

    // 6. Fallback: memo text as evidence
    if (picked.length === 0) {
      evidence.push({
        evidence_id: nextEvidenceId(),
        type: "quote",
        time_range_ms: [memo.created_at_ms, memo.created_at_ms],
        utterance_ids: [],
        speaker: {
          cluster_id: null,
          person_id: boundSpeakers[0] ?? null,
          display_name: boundSpeakers[0] ?? null,
        },
        quote: quoteFromUtterance(memo.text),
        confidence: 0.35,
        weak: false,
        weak_reason: null,
        source: "memo_text",
      });
    }
  }

  // Fallback evidence per speaker (one representative utterance each)
  const fallbackBySpeaker = new Set<string>();
  for (const item of sorted) {
    const key = speakerKey(item);
    if (fallbackBySpeaker.has(key)) continue;
    evidence.push({
      evidence_id: nextEvidenceId(),
      type: "quote",
      time_range_ms: [item.start_ms, item.end_ms],
      utterance_ids: [item.utterance_id],
      speaker: {
        cluster_id: item.cluster_id ?? null,
        person_id: item.speaker_name ?? key,
        display_name: item.speaker_name ?? key,
      },
      quote: quoteFromUtterance(item.text),
      confidence: weakUtterances.has(item.utterance_id) ? 0.40 : 0.65,
      weak: weakUtterances.has(item.utterance_id),
      weak_reason: weakUtterances.has(item.utterance_id) ? "overlap_risk" : null,
      source: "speaker_fallback",
    });
    fallbackBySpeaker.add(key);
  }

  return evidence;
}
```

Add `contentSemanticScore` helper after `keywordOverlap` (line ~276):

```typescript
function contentSemanticScore(memoText: string, utteranceText: string): number {
  // Check if memo describes behaviors/content visible in utterance
  const memoLower = memoText.toLowerCase();
  const uttLower = utteranceText.toLowerCase();

  // Extract substantive keywords (3+ chars) from memo
  const memoWords = memoLower.match(/[a-z]{3,}/g) ?? [];
  const zhWords = memoLower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];

  let matches = 0;
  let total = memoWords.length + zhWords.length;
  if (total === 0) return 0;

  for (const word of memoWords) {
    if (uttLower.includes(word)) matches++;
  }
  for (const word of zhWords) {
    if (uttLower.includes(word)) matches++;
  }

  return matches / total;
}
```

**Step 4: Update `confidenceWithWeakEvidence` to use avg evidence confidence**

Replace the function (line 550-557):

```typescript
function confidenceWithWeakEvidence(
  _base: number,
  refs: string[],
  evidenceById: Map<string, EvidenceItem>
): number {
  if (refs.length === 0) return 0.35;
  // Use average evidence confidence instead of fixed base
  let sum = 0;
  let count = 0;
  for (const ref of refs) {
    const ev = evidenceById.get(ref);
    if (ev) {
      sum += ev.confidence;
      count++;
    }
  }
  const avg = count > 0 ? sum / count : 0.5;
  return Math.min(0.95, Math.max(0.3, avg));
}
```

**Step 5: Update `buildMemoFirstReport` claim confidence**

In `buildMemoFirstReport` (line ~756), replace hardcoded 0.42:

```typescript
// OLD: confidence: refs.length > 0 ? confidenceWithWeakEvidence(0.86, refs, evidenceById) : 0.42
// NEW:
confidence: confidenceWithWeakEvidence(0.86, refs, evidenceById)
```

Apply this to all 3 occurrences in the function (strengths/risks/actions fallbacks too).

**Step 6: Run tests**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts 2>&1 | tail -15`
Expected: All tests PASS including new semantic matching tests

**Step 7: Commit**

```bash
git add edge/worker/src/finalize_v2.ts edge/worker/tests/reconcile.test.ts
git commit -m "feat(evidence): rewrite buildMultiEvidence with semantic matching and dynamic confidence"
```

---

### Task 3: Evidence enrichment function (finalize_v2.ts)

**Files:**
- Modify: `edge/worker/src/finalize_v2.ts` (add new function after `buildMultiEvidence`)
- Test: `edge/worker/tests/reconcile.test.ts`

**Step 1: Write failing test**

```typescript
import { enrichEvidencePack } from "../src/finalize_v2";

describe("enrichEvidencePack", () => {
  const transcript = [
    { utterance_id: "u1", stream_role: "students" as const, cluster_id: "Tina", speaker_name: "Tina", text: "I think biocompatibility is most important because without it patients may experience rejection reactions and need secondary surgery", start_ms: 200000, end_ms: 210000, duration_ms: 10000 },
    { utterance_id: "u2", stream_role: "students" as const, cluster_id: "Tina", speaker_name: "Tina", text: "So let me summarize what we have discussed so far", start_ms: 230000, end_ms: 235000, duration_ms: 5000 },
    { utterance_id: "u3", stream_role: "students" as const, cluster_id: "Rice", speaker_name: "Rice", text: "I agree with your point about biocompatibility", start_ms: 210000, end_ms: 215000, duration_ms: 5000 },
    { utterance_id: "u4", stream_role: "students" as const, cluster_id: "Rice", speaker_name: "Rice", text: "And I also think the repair aspect is very important for long term use", start_ms: 250000, end_ms: 260000, duration_ms: 10000 },
  ];

  const stats = [
    { speaker_key: "Tina", speaker_name: "Tina", talk_time_ms: 15000, talk_time_pct: 0.5, turns: 2, silence_ms: 0, interruptions: 1, interrupted_by_others: 0 },
    { speaker_key: "Rice", speaker_name: "Rice", talk_time_ms: 15000, talk_time_pct: 0.5, turns: 2, silence_ms: 0, interruptions: 0, interrupted_by_others: 1 },
  ];

  it("should generate transcript_quote evidence for substantive utterances", () => {
    const enriched = enrichEvidencePack(transcript, stats);
    const quotes = enriched.filter(e => e.type === "transcript_quote");
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    expect(quotes.every(e => e.utterance_ids.length === 1)).toBe(true);
    expect(quotes.every(e => e.confidence === 0.85)).toBe(true);
    expect(quotes.every(e => e.source === "auto_generated")).toBe(true);
  });

  it("should generate stats_summary evidence for each speaker", () => {
    const enriched = enrichEvidencePack(transcript, stats);
    const summaries = enriched.filter(e => e.type === "stats_summary");
    expect(summaries.length).toBe(2); // One per speaker
    expect(summaries.every(e => e.confidence === 0.95)).toBe(true);
  });

  it("should detect interaction patterns (agree signals)", () => {
    const enriched = enrichEvidencePack(transcript, stats);
    const interactions = enriched.filter(e => e.type === "interaction_pattern");
    expect(interactions.length).toBeGreaterThanOrEqual(1);
    // Rice's "I agree" should be detected
    const agreeEvidence = interactions.find(e => e.quote.toLowerCase().includes("agree"));
    expect(agreeEvidence).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts -t "enrichEvidencePack" 2>&1 | tail -5`
Expected: FAIL — `enrichEvidencePack` not exported

**Step 3: Implement `enrichEvidencePack`**

Add after `buildMultiEvidence` in `finalize_v2.ts`:

```typescript
export function enrichEvidencePack(
  transcript: TranscriptItem[],
  stats: SpeakerStatItem[]
): EvidenceItem[] {
  const enriched: EvidenceItem[] = [];
  let seq = 900; // Start at 900 to avoid collision with memo-based evidence
  const nextId = () => `e_${String(seq++).padStart(6, "0")}`;

  // ── 1. Transcript quote evidence: top-5 longest per speaker ──
  const bySpeaker = new Map<string, TranscriptItem[]>();
  for (const u of transcript) {
    const key = speakerKey(u);
    if (key === "unknown") continue;
    const list = bySpeaker.get(key) ?? [];
    list.push(u);
    bySpeaker.set(key, list);
  }

  for (const [key, utterances] of bySpeaker) {
    const sorted = [...utterances].sort((a, b) => b.text.length - a.text.length);
    const top = sorted.slice(0, 5);
    for (const u of top) {
      if (u.text.trim().length < 20) continue; // Skip very short utterances
      enriched.push({
        evidence_id: nextId(),
        type: "transcript_quote",
        time_range_ms: [u.start_ms, u.end_ms],
        utterance_ids: [u.utterance_id],
        speaker: {
          cluster_id: u.cluster_id ?? null,
          person_id: u.speaker_name ?? key,
          display_name: u.speaker_name ?? key,
        },
        quote: quoteFromUtterance(u.text, 300),
        confidence: 0.85,
        weak: false,
        weak_reason: null,
        source: "auto_generated",
      });
    }
  }

  // ── 2. Stats summary evidence: one per speaker ──
  for (const stat of stats) {
    if (!stat.speaker_name || stat.speaker_name === "unknown") continue;
    const pct = stat.talk_time_pct != null
      ? `${Math.round(stat.talk_time_pct * 100)}%`
      : "N/A";
    const quote = `${stat.speaker_name} 发言 ${stat.turns} 次，占比 ${pct}` +
      (stat.interruptions > 0 ? `，打断他人 ${stat.interruptions} 次` : "") +
      (stat.interrupted_by_others > 0 ? `，被打断 ${stat.interrupted_by_others} 次` : "");
    enriched.push({
      evidence_id: nextId(),
      type: "stats_summary",
      time_range_ms: [0, 0],
      utterance_ids: [],
      speaker: {
        cluster_id: null,
        person_id: stat.speaker_key,
        display_name: stat.speaker_name,
      },
      quote,
      confidence: 0.95,
      weak: false,
      weak_reason: null,
      source: "auto_generated",
    });
  }

  // ── 3. Interaction pattern evidence ──
  const sorted = [...transcript].sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevKey = speakerKey(prev);
    const currKey = speakerKey(curr);
    if (prevKey === currKey || prevKey === "unknown" || currKey === "unknown") continue;

    const gap = curr.start_ms - prev.end_ms;
    const currLower = curr.text.toLowerCase();

    // Detect agreement signals
    if (currLower.includes("agree") || currLower.includes("同意") || currLower.includes("对") || currLower.includes("yeah")) {
      enriched.push({
        evidence_id: nextId(),
        type: "interaction_pattern",
        time_range_ms: [curr.start_ms, curr.end_ms],
        utterance_ids: [prev.utterance_id, curr.utterance_id],
        speaker: {
          cluster_id: curr.cluster_id ?? null,
          person_id: curr.speaker_name ?? currKey,
          display_name: curr.speaker_name ?? currKey,
        },
        quote: quoteFromUtterance(`${curr.speaker_name ?? currKey} 回应 ${prev.speaker_name ?? prevKey}: "${curr.text}"`, 250),
        confidence: 0.70,
        weak: false,
        weak_reason: null,
        source: "auto_generated",
      });
    }

    // Detect rapid response (potential interruption or quick collaboration)
    if (gap >= 0 && gap < 500 && prev.duration_ms >= 1200) {
      enriched.push({
        evidence_id: nextId(),
        type: "interaction_pattern",
        time_range_ms: [prev.start_ms, curr.end_ms],
        utterance_ids: [prev.utterance_id, curr.utterance_id],
        speaker: {
          cluster_id: curr.cluster_id ?? null,
          person_id: curr.speaker_name ?? currKey,
          display_name: curr.speaker_name ?? currKey,
        },
        quote: quoteFromUtterance(`${curr.speaker_name ?? currKey} 快速接上 ${prev.speaker_name ?? prevKey} 的发言 (间隔${gap}ms)`, 250),
        confidence: 0.70,
        weak: false,
        weak_reason: null,
        source: "auto_generated",
      });
    }
  }

  return enriched;
}
```

**Step 4: Run tests**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts 2>&1 | tail -15`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add edge/worker/src/finalize_v2.ts edge/worker/tests/reconcile.test.ts
git commit -m "feat(evidence): add enrichEvidencePack for transcript quotes, stats, and interaction patterns"
```

---

### Task 4: Global talk time deduplication (finalize_v2.ts)

**Files:**
- Modify: `edge/worker/src/finalize_v2.ts:84-149`
- Test: `edge/worker/tests/reconcile.test.ts`

**Step 1: Write failing test**

```typescript
import { computeSpeakerStats } from "../src/finalize_v2";

describe("computeSpeakerStats global dedup", () => {
  it("should not exceed audio duration in total talk time", () => {
    const transcript = [
      { utterance_id: "u1", stream_role: "students" as const, cluster_id: "A", speaker_name: "A", text: "hello", start_ms: 0, end_ms: 10000, duration_ms: 10000 },
      { utterance_id: "u2", stream_role: "students" as const, cluster_id: "B", speaker_name: "B", text: "world", start_ms: 5000, end_ms: 15000, duration_ms: 10000 },
      { utterance_id: "u3", stream_role: "students" as const, cluster_id: "A", speaker_name: "A", text: "test", start_ms: 15000, end_ms: 20000, duration_ms: 5000 },
    ];
    // Audio is 0-20000ms = 20s. Naive sum = 25s. Should be <= 20s.
    const stats = computeSpeakerStats(transcript);
    const total = stats.reduce((s, item) => s + item.talk_time_ms, 0);
    expect(total).toBeLessThanOrEqual(20000);
  });

  it("should split overlapping time equally between speakers", () => {
    const transcript = [
      { utterance_id: "u1", stream_role: "students" as const, cluster_id: "A", speaker_name: "A", text: "hello", start_ms: 0, end_ms: 10000, duration_ms: 10000 },
      { utterance_id: "u2", stream_role: "students" as const, cluster_id: "B", speaker_name: "B", text: "world", start_ms: 0, end_ms: 10000, duration_ms: 10000 },
    ];
    // Both speak for 10s at exact same time. Each should get ~5s.
    const stats = computeSpeakerStats(transcript);
    const a = stats.find(s => s.speaker_key === "A");
    const b = stats.find(s => s.speaker_key === "B");
    expect(a!.talk_time_ms).toBe(5000);
    expect(b!.talk_time_ms).toBe(5000);
  });

  it("should include talk_time_pct field", () => {
    const transcript = [
      { utterance_id: "u1", stream_role: "students" as const, cluster_id: "A", speaker_name: "A", text: "hello world this is a test", start_ms: 0, end_ms: 10000, duration_ms: 10000 },
    ];
    const stats = computeSpeakerStats(transcript);
    expect(stats[0].talk_time_pct).toBeCloseTo(1.0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts -t "global dedup" 2>&1 | tail -10`
Expected: FAIL — total > 20000 or talk_time_pct missing

**Step 3: Add global dedup to `computeSpeakerStats`**

After the existing per-speaker merge loop (after line ~124), add global dedup phase before the silence/interruption loop:

```typescript
  // ── Global timeline dedup: split overlapping cross-speaker time ──
  const audioDurationMs = items.length > 0
    ? Math.max(...items.map((u) => u.end_ms))
    : 0;

  if (audioDurationMs > 0) {
    // Build event timeline
    const events: Array<{ ms: number; type: "start" | "end"; key: string }> = [];
    for (const item of items) {
      const key = speakerKey(item);
      events.push({ ms: item.start_ms, type: "start", key });
      events.push({ ms: item.end_ms, type: "end", key });
    }
    events.sort((a, b) => a.ms - b.ms || (a.type === "end" ? -1 : 1));

    // Walk timeline, track active speakers
    const activeSpeakers = new Map<string, number>(); // key → count of active segments
    const adjustedTalkTime = new Map<string, number>();
    for (const key of statMap.keys()) adjustedTalkTime.set(key, 0);

    let prevMs = 0;
    for (const event of events) {
      const dt = event.ms - prevMs;
      if (dt > 0 && activeSpeakers.size > 0) {
        const share = dt / activeSpeakers.size;
        for (const [key] of activeSpeakers) {
          adjustedTalkTime.set(key, (adjustedTalkTime.get(key) ?? 0) + share);
        }
      }
      prevMs = event.ms;

      if (event.type === "start") {
        activeSpeakers.set(event.key, (activeSpeakers.get(event.key) ?? 0) + 1);
      } else {
        const count = (activeSpeakers.get(event.key) ?? 1) - 1;
        if (count <= 0) activeSpeakers.delete(event.key);
        else activeSpeakers.set(event.key, count);
      }
    }

    // Apply adjusted times and clamp
    let totalAdjusted = 0;
    for (const [key, ms] of adjustedTalkTime) {
      totalAdjusted += ms;
    }
    const scale = totalAdjusted > audioDurationMs
      ? audioDurationMs / totalAdjusted
      : 1;

    for (const [key, ms] of adjustedTalkTime) {
      const stat = statMap.get(key);
      if (stat) {
        stat.talk_time_ms = Math.round(ms * scale);
        stat.talk_time_pct = audioDurationMs > 0 ? stat.talk_time_ms / audioDurationMs : 0;
      }
    }
  } else {
    for (const stat of statMap.values()) {
      stat.talk_time_pct = 0;
    }
  }
```

**Step 4: Run tests**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts 2>&1 | tail -15`
Expected: All tests PASS

Run: `cd edge/worker && npx vitest run 2>&1 | tail -5`
Expected: All 236+ tests PASS

**Step 5: Commit**

```bash
git add edge/worker/src/finalize_v2.ts edge/worker/tests/reconcile.test.ts
git commit -m "feat(stats): add global timeline dedup to prevent talk_time inflation"
```

---

### Task 5: Tentative soft threshold + memo-assisted binding (index.ts + finalize_v2.ts)

**Files:**
- Modify: `edge/worker/src/index.ts:2520-2533, 2693, 4906, 5242`
- Modify: `edge/worker/src/finalize_v2.ts` (add `memoAssistedBinding`)
- Test: `edge/worker/tests/reconcile.test.ts`

**Step 1: Write failing test for memo-assisted binding**

```typescript
import { memoAssistedBinding } from "../src/finalize_v2";

describe("memoAssistedBinding", () => {
  it("should bind cluster when 2+ memos corroborate with content match", () => {
    const clusters = [
      { cluster_id: "c1", turn_ids: ["t1", "t2", "t3"] },
    ];
    const bindings: Record<string, string> = {};
    const bindingMeta: Record<string, { locked: boolean }> = {};
    const transcript = [
      { utterance_id: "u1", cluster_id: "c1", speaker_name: null, text: "biocompatibility is critical for patient safety", start_ms: 100000, end_ms: 110000, duration_ms: 10000, stream_role: "students" as const },
      { utterance_id: "u2", cluster_id: "c1", speaker_name: null, text: "I believe we should prioritize it", start_ms: 200000, end_ms: 210000, duration_ms: 10000, stream_role: "students" as const },
    ];
    const memos = [
      { memo_id: "m1", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "Rice提出了biocompatibility的重要性" },
      { memo_id: "m2", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "Rice给了很好的论证，关于patient safety" },
    ];
    const roster = ["Tina", "Rice", "Daisy"];

    const result = memoAssistedBinding({ clusters, bindings, bindingMeta, transcript, memos, roster });
    expect(result.newBindings["c1"]).toBe("Rice");
    expect(result.bindingSource["c1"]).toBe("memo_assisted");
  });

  it("should NOT bind when only 1 memo mentions the name (insufficient corroboration)", () => {
    const clusters = [{ cluster_id: "c1", turn_ids: ["t1", "t2"] }];
    const transcript = [
      { utterance_id: "u1", cluster_id: "c1", speaker_name: null, text: "some text here", start_ms: 100000, end_ms: 110000, duration_ms: 10000, stream_role: "students" as const },
      { utterance_id: "u2", cluster_id: "c1", speaker_name: null, text: "more text", start_ms: 200000, end_ms: 210000, duration_ms: 10000, stream_role: "students" as const },
    ];
    const memos = [
      { memo_id: "m1", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "Rice did well here" },
    ];

    const result = memoAssistedBinding({ clusters, bindings: {}, bindingMeta: {}, transcript, memos, roster: ["Rice"] });
    expect(result.newBindings["c1"]).toBeUndefined();
  });

  it("should NOT bind when multiple names are mentioned (ambiguous)", () => {
    const clusters = [{ cluster_id: "c1", turn_ids: ["t1", "t2"] }];
    const transcript = [
      { utterance_id: "u1", cluster_id: "c1", speaker_name: null, text: "something about design", start_ms: 100000, end_ms: 110000, duration_ms: 10000, stream_role: "students" as const },
      { utterance_id: "u2", cluster_id: "c1", speaker_name: null, text: "another point", start_ms: 200000, end_ms: 210000, duration_ms: 10000, stream_role: "students" as const },
    ];
    const memos = [
      { memo_id: "m1", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "Rice and Tina discussed this point" },
      { memo_id: "m2", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "Rice and Tina both contributed" },
    ];

    const result = memoAssistedBinding({ clusters, bindings: {}, bindingMeta: {}, transcript, memos, roster: ["Rice", "Tina"] });
    expect(result.newBindings["c1"]).toBeUndefined();
  });

  it("should NOT bind when name already bound to another cluster", () => {
    const clusters = [{ cluster_id: "c2", turn_ids: ["t3", "t4"] }];
    const bindings = { "c1": "Rice" }; // Rice already bound to c1
    const transcript = [
      { utterance_id: "u3", cluster_id: "c2", speaker_name: null, text: "biocompatibility matters", start_ms: 300000, end_ms: 310000, duration_ms: 10000, stream_role: "students" as const },
      { utterance_id: "u4", cluster_id: "c2", speaker_name: null, text: "for sure", start_ms: 310000, end_ms: 320000, duration_ms: 10000, stream_role: "students" as const },
    ];
    const memos = [
      { memo_id: "m1", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "Rice gave good point about biocompatibility" },
      { memo_id: "m2", created_at_ms: Date.now(), author_role: "teacher" as const, type: "observation" as const, tags: [], text: "Rice continued with strong argument" },
    ];

    const result = memoAssistedBinding({ clusters, bindings, bindingMeta: {}, transcript, memos, roster: ["Rice", "Tina"] });
    expect(result.newBindings["c2"]).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts -t "memoAssistedBinding" 2>&1 | tail -5`
Expected: FAIL

**Step 3: Implement `memoAssistedBinding`**

Add to `finalize_v2.ts`:

```typescript
export function memoAssistedBinding(params: {
  clusters: Array<{ cluster_id: string; turn_ids: string[] }>;
  bindings: Record<string, string>;
  bindingMeta: Record<string, { locked: boolean }>;
  transcript: TranscriptItem[];
  memos: MemoItem[];
  roster: string[];
}): {
  newBindings: Record<string, string>;
  bindingSource: Record<string, "memo_assisted">;
} {
  const { clusters, bindings, bindingMeta, transcript, memos, roster } = params;
  const newBindings: Record<string, string> = {};
  const bindingSource: Record<string, "memo_assisted"> = {};

  // Names already bound to clusters
  const boundNames = new Set(Object.values(bindings));

  // Build cluster→utterances index
  const utterancesByCluster = new Map<string, TranscriptItem[]>();
  for (const u of transcript) {
    if (!u.cluster_id) continue;
    const list = utterancesByCluster.get(u.cluster_id) ?? [];
    list.push(u);
    utterancesByCluster.set(u.cluster_id, list);
  }

  for (const cluster of clusters) {
    // Skip already resolved
    const bound = bindings[cluster.cluster_id];
    const meta = bindingMeta[cluster.cluster_id];
    if (bound && meta?.locked) continue;

    const clusterUtterances = utterancesByCluster.get(cluster.cluster_id) ?? [];

    // Safety check 5: minimum volume
    if (clusterUtterances.length < 2) continue;

    const clusterText = clusterUtterances.map((u) => u.text).join(" ").toLowerCase();

    // Find memos that mention roster names and have content overlap
    const nameCounts = new Map<string, number>(); // name → count of corroborating memos

    for (const memo of memos) {
      const memoLower = memo.text.toLowerCase();

      // Find which roster names this memo mentions
      const mentionedNames: string[] = [];
      for (const name of roster) {
        if (memoLower.includes(name.toLowerCase())) {
          mentionedNames.push(name);
        }
      }

      // Safety check 1: uniqueness — skip if memo mentions multiple names
      if (mentionedNames.length !== 1) continue;

      const candidateName = mentionedNames[0];

      // Safety check 4: no conflict — skip if name already bound elsewhere
      if (boundNames.has(candidateName)) continue;

      // Safety check 3: content corroboration — memo keywords in cluster text
      const memoWords = memoLower.match(/[a-z]{3,}/g) ?? [];
      const zhWords = memoLower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
      const allWords = [...memoWords, ...zhWords].filter(
        (w) => !["the", "and", "for", "this", "that", "with", "also", "very", "good", "well"].includes(w)
      );

      let contentMatches = 0;
      for (const word of allWords) {
        if (clusterText.includes(word)) contentMatches++;
      }
      const contentRatio = allWords.length > 0 ? contentMatches / allWords.length : 0;
      if (contentRatio < 0.15) continue; // At least 15% keyword overlap

      nameCounts.set(candidateName, (nameCounts.get(candidateName) ?? 0) + 1);
    }

    // Safety check 2: multi-source corroboration — need 2+ memos
    // Also ensure only 1 candidate name across all memos
    const candidates = [...nameCounts.entries()].filter(([, count]) => count >= 2);
    if (candidates.length !== 1) continue;

    const [winnerName] = candidates[0];

    // All 5 checks passed
    newBindings[cluster.cluster_id] = winnerName;
    bindingSource[cluster.cluster_id] = "memo_assisted";
  }

  return { newBindings, bindingSource };
}
```

**Step 4: Update tentative logic in index.ts**

At lines 2693, 4906, and 5242, replace the tentative determination:

```typescript
// OLD (at each location):
const tentative = unresolvedClusterCount > 0;
// or:
const tentative = unresolvedClusterCount > 0 || !gateEvaluation.passed;

// NEW (at each location):
const totalClusters = state.clusters.length;
const unresolvedRatio = totalClusters > 0 ? unresolvedClusterCount / totalClusters : 0;
const confidenceLevel: "high" | "medium" | "low" =
  unresolvedRatio === 0 ? "high" :
  unresolvedRatio <= 0.25 ? "medium" : "low";
const tentative = confidenceLevel === "low" || !qualityGateEvaluation.passed;
// (For the location at 4906 that doesn't use qualityGateEvaluation, just: confidenceLevel === "low")
```

Update quality gate threshold at line 2526:

```typescript
// OLD:
if (!Number.isFinite(params.unknownRatio) || params.unknownRatio > 0.10) {
// NEW:
if (!Number.isFinite(params.unknownRatio) || params.unknownRatio > 0.25) {
```

Add `confidence_level` to result assembly at line ~5295:

```typescript
// In buildResultV2 call, add confidence_level to session:
tentative: finalTentative,
confidence_level: confidenceLevel,  // NEW
```

**Step 5: Run all tests**

Run: `cd edge/worker && npx vitest run 2>&1 | tail -10`
Expected: All tests PASS

Run: `cd edge/worker && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

**Step 6: Commit**

```bash
git add edge/worker/src/finalize_v2.ts edge/worker/src/index.ts edge/worker/tests/reconcile.test.ts
git commit -m "feat(tentative): soft threshold with confidence_level + memo-assisted cluster binding"
```

---

### Task 6: LLM prompt enhancements (report_synthesizer.py)

**Files:**
- Modify: `inference/app/services/report_synthesizer.py:319-498`
- Modify: `inference/app/schemas.py:450-464`
- Test: `inference/tests/test_report_synthesizer.py`

**Step 1: Write failing test**

```python
def test_user_prompt_includes_stats_observations(synthesizer_fixture):
    """Stats observations should appear in the user prompt."""
    req = make_synth_request(stats_observations=["Tina spoke most (42%)", "Rice spoke least (15%)"])
    prompt = synthesizer_fixture._build_user_prompt(req, req.transcript)
    import json
    data = json.loads(prompt)
    assert "stats_observations" in data
    assert len(data["stats_observations"]) == 2

def test_system_prompt_includes_supporting_utterances_instruction(synthesizer_fixture):
    """System prompt should instruct LLM to output supporting_utterances."""
    req = make_synth_request()
    prompt = synthesizer_fixture._build_system_prompt(req)
    assert "supporting_utterances" in prompt

def test_system_prompt_requires_minimum_summary_sections(synthesizer_fixture):
    """System prompt should require minimum 2 summary sections."""
    req = make_synth_request()
    prompt = synthesizer_fixture._build_system_prompt(req)
    assert "at least 2" in prompt.lower() or "minimum 2" in prompt.lower()

def test_transcript_truncation_increased(synthesizer_fixture):
    """Transcript should be truncated at 6000 tokens, not 3000."""
    long_transcript = [make_utterance(f"u{i}", f"Long text about topic number {i} " * 20, i*10000) for i in range(50)]
    req = make_synth_request(transcript=long_transcript)
    truncated, was_truncated = synthesizer_fixture._truncate_transcript(long_transcript, max_tokens=6000)
    # Should keep more utterances than old 3000 limit
    assert len(truncated) > 10
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_report_synthesizer.py -v -k "stats_observations or supporting_utterances or minimum_summary or truncation_increased" 2>&1 | tail -10`
Expected: FAIL

**Step 3: Update system prompt**

In `_build_system_prompt` (line 319), add rules 19-21:

```python
    "19. For each claim, also select 1-3 transcript segments that best support the claim. "
    "Output as supporting_utterances: [utterance_id, ...] in each claim object. "
    "Prefer segments containing key arguments, specific examples, or behavioral evidence.\n"
    "20. MINIMUM SECTIONS: Generate at least 2 summary_sections (e.g., discussion stages, "
    "key themes). Generate at least 2 team_dynamics highlights and at least 2 risks.\n"
    "21. Use stats_observations (if provided) to enrich analysis with quantitative insights. "
    "Incorporate relevant statistics into claims naturally.\n"
```

**Step 4: Update user prompt**

In `_build_user_prompt` (line 429), add `stats_observations`:

```python
        if req.stats_observations:
            prompt_data["stats_observations"] = req.stats_observations
```

Update the `transcript_segments` format to group by speaker (after line 364):

```python
        transcript_segments = [
            {
                "utterance_id": u.utterance_id,
                "speaker_name": u.speaker_name,
                "text": u.text[:600],
                "start_ms": u.start_ms,
                "end_ms": u.end_ms,
            }
            for u in truncated_transcript
        ]
```

(Keep as-is — the grouping by speaker is conceptual in the prompt, the LLM handles it)

**Step 5: Update truncation limit**

In `_truncate_transcript` (line 519), change default:

```python
    def _truncate_transcript(
        self, transcript: list[TranscriptUtterance], max_tokens: int = 6000  # WAS 4000
    ) -> tuple[list[TranscriptUtterance], bool]:
```

**Step 6: Update `_parse_llm_output` to handle `supporting_utterances`**

In `_parse_llm_output`, inside `parse_claims` (line 623), extract `supporting_utterances`:

```python
                        supporting = c.get("supporting_utterances", [])
                        supp_ids = [str(s).strip() for s in supporting if str(s).strip()]
                        claims.append(
                            DimensionClaim(
                                claim_id=cid or f"c_{person_key}_{dim_name}_{len(claims)+1:02d}",
                                text=text,
                                evidence_refs=refs[:5],
                                confidence=conf,
                                supporting_utterances=supp_ids[:3],  # NEW
                            )
                        )
```

**Step 7: Add `supporting_utterances` to DimensionClaim schema (schemas.py)**

At line 284:

```python
class DimensionClaim(BaseModel):
    claim_id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=3000)
    evidence_refs: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0, le=1)
    supporting_utterances: list[str] = Field(default_factory=list)  # NEW
```

**Step 8: Run tests**

Run: `cd inference && python -m pytest tests/test_report_synthesizer.py -v 2>&1 | tail -15`
Expected: All tests PASS

**Step 9: Commit**

```bash
git add inference/app/services/report_synthesizer.py inference/app/schemas.py inference/tests/test_report_synthesizer.py
git commit -m "feat(synthesizer): add supporting_utterances, stats_observations, increase transcript budget"
```

---

### Task 7: Generate stats observations + wire enrichment (finalize_v2.ts + index.ts)

**Files:**
- Modify: `edge/worker/src/finalize_v2.ts:984-1052` (buildSynthesizePayload)
- Modify: `edge/worker/src/index.ts` (finalization pipeline, ~line 4930-5100)
- Test: `edge/worker/tests/reconcile.test.ts`

**Step 1: Write failing test for generateStatsObservations**

```typescript
import { generateStatsObservations } from "../src/finalize_v2";

describe("generateStatsObservations", () => {
  it("should generate insights about talk time distribution", () => {
    const stats = [
      { speaker_key: "Tina", speaker_name: "Tina", talk_time_ms: 120000, talk_time_pct: 0.42, turns: 12, silence_ms: 0, interruptions: 2, interrupted_by_others: 0 },
      { speaker_key: "Rice", speaker_name: "Rice", talk_time_ms: 50000, talk_time_pct: 0.18, turns: 5, silence_ms: 0, interruptions: 0, interrupted_by_others: 1 },
      { speaker_key: "Daisy", speaker_name: "Daisy", talk_time_ms: 60000, talk_time_pct: 0.21, turns: 8, silence_ms: 0, interruptions: 1, interrupted_by_others: 1 },
    ];
    const observations = generateStatsObservations(stats, 290000);
    expect(observations.length).toBeGreaterThanOrEqual(2);
    // Should mention the highest speaker
    expect(observations.some(o => o.includes("Tina"))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts -t "generateStatsObservations" 2>&1 | tail -5`
Expected: FAIL

**Step 3: Implement `generateStatsObservations`**

Add to `finalize_v2.ts`:

```typescript
export function generateStatsObservations(
  stats: SpeakerStatItem[],
  audioDurationMs: number
): string[] {
  const observations: string[] = [];
  const named = stats.filter((s) => s.speaker_name && s.speaker_name !== "unknown");
  if (named.length === 0) return observations;

  // Sort by talk_time descending
  const sorted = [...named].sort((a, b) => b.talk_time_ms - a.talk_time_ms);

  // 1. Highest speaker
  const top = sorted[0];
  const topPct = Math.round((top.talk_time_pct ?? 0) * 100);
  observations.push(
    `${top.speaker_name} 的发言时间占比最高 (${topPct}%)，发言 ${top.turns} 次` +
    (sorted.length > 1 ? `，显著领先其他参与者` : "")
  );

  // 2. Lowest speaker (if more than 1)
  if (sorted.length > 1) {
    const bottom = sorted[sorted.length - 1];
    const bottomPct = Math.round((bottom.talk_time_pct ?? 0) * 100);
    const avgTurnMs = bottom.turns > 0 ? Math.round(bottom.talk_time_ms / bottom.turns / 1000) : 0;
    observations.push(
      `${bottom.speaker_name} 发言次数最少 (${bottom.turns} 次，占比 ${bottomPct}%)` +
      (avgTurnMs > 0 ? `，但每次发言平均时长 ${avgTurnMs}s` : "")
    );
  }

  // 3. Interruption patterns
  const interrupters = named.filter((s) => s.interruptions > 0);
  if (interrupters.length > 0) {
    const top = interrupters.sort((a, b) => b.interruptions - a.interruptions)[0];
    observations.push(
      `${top.speaker_name} 打断他人 ${top.interruptions} 次` +
      (top.interrupted_by_others > 0 ? `，自身也被打断 ${top.interrupted_by_others} 次` : "")
    );
  }

  // 4. Total duration context
  const totalSec = Math.round(audioDurationMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const remainSec = totalSec % 60;
  observations.push(
    `整体讨论时长约 ${totalMin}分${remainSec}秒，共 ${named.length} 位参与者`
  );

  return observations;
}
```

**Step 4: Update `buildSynthesizePayload` to include `stats_observations`**

In `buildSynthesizePayload` (line 984), add parameter and pass through:

```typescript
export function buildSynthesizePayload(params: {
  // ... existing params ...
  statsObservations?: string[];  // NEW
}): SynthesizeRequestPayload {
  return {
    // ... existing fields ...
    stats_observations: params.statsObservations,  // NEW
  };
}
```

**Step 5: Wire enrichment into finalization pipeline (index.ts)**

In the finalization pipeline (around line 4930-5100), after `computeSpeakerStats` and before `buildSynthesizePayload`:

```typescript
// After stats computation (~line 4935):
const stats = this.mergeStatsWithRoster(computeSpeakerStats(transcript), state);

// NEW: Enrich evidence pack
const enrichedEvidence = [
  ...evidence,
  ...enrichEvidencePack(transcript, stats),
];

// NEW: Generate stats observations
const audioDurationMs = transcript.length > 0 ? Math.max(...transcript.map(u => u.end_ms)) : 0;
const statsObservations = generateStatsObservations(stats, audioDurationMs);

// Update synthPayload to use enrichedEvidence and statsObservations
const synthPayload = buildSynthesizePayload({
  // ... existing params ...
  evidence: enrichedEvidence,  // CHANGED: was `evidence`
  statsObservations,           // NEW
});
```

Add imports at top of index.ts if not already present:

```typescript
import { enrichEvidencePack, generateStatsObservations, memoAssistedBinding } from "./finalize_v2";
```

**Step 6: Wire memo-assisted binding into finalization pipeline**

In the finalization pipeline, after `reconcile` stage (~line 4928) and before stats:

```typescript
// NEW: Attempt memo-assisted binding for unresolved clusters
const rosterNames = (state.roster ?? []).map(r => typeof r === "string" ? r : r.display_name ?? r.name ?? "").filter(Boolean);
const memoBindResult = memoAssistedBinding({
  clusters: state.clusters,
  bindings: state.bindings,
  bindingMeta: state.cluster_binding_meta,
  transcript,
  memos,
  roster: rosterNames,
});

// Apply new bindings to state
for (const [clusterId, name] of Object.entries(memoBindResult.newBindings)) {
  state.bindings[clusterId] = name;
  state.cluster_binding_meta[clusterId] = {
    participant_name: name,
    source: "name_extract",
    confidence: 0.7,
    locked: false,
    updated_at: new Date().toISOString(),
  };
}

// Re-count unresolved after memo-assisted binding
const unresolvedClusterCount = state.clusters.filter((cluster) => {
  const bound = state.bindings[cluster.cluster_id];
  const meta = state.cluster_binding_meta[cluster.cluster_id];
  return !bound || !meta || !meta.locked;
}).length;
```

**Step 7: Run all tests**

Run: `cd edge/worker && npx vitest run 2>&1 | tail -10`
Expected: All tests PASS

Run: `cd edge/worker && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

**Step 8: Commit**

```bash
git add edge/worker/src/finalize_v2.ts edge/worker/src/index.ts edge/worker/tests/reconcile.test.ts
git commit -m "feat(pipeline): wire evidence enrichment, stats observations, and memo-assisted binding"
```

---

### Task 8: LLM backfill of supporting_utterances (finalize_v2.ts)

**Files:**
- Modify: `edge/worker/src/finalize_v2.ts` (add backfill logic)
- Modify: `edge/worker/src/index.ts` (call backfill after LLM response)

**Step 1: Write failing test**

```typescript
import { backfillSupportingUtterances } from "../src/finalize_v2";

describe("backfillSupportingUtterances", () => {
  it("should merge supporting_utterances into evidence utterance_ids", () => {
    const evidence = [
      { evidence_id: "e_000001", type: "quote" as const, time_range_ms: [0, 10000] as [number, number], utterance_ids: [], speaker: {}, quote: "test", confidence: 0.42, source: "memo_text" as const },
    ];
    const perPerson = [{
      person_key: "Tina",
      display_name: "Tina",
      dimensions: [{
        dimension: "leadership" as const,
        strengths: [{ claim_id: "c1", text: "test", evidence_refs: ["e_000001"], confidence: 0.7, supporting_utterances: ["u1", "u2"] }],
        risks: [],
        actions: [],
      }],
      summary: { strengths: [], risks: [], actions: [] },
    }];

    const result = backfillSupportingUtterances(evidence, perPerson);
    const updated = result.find(e => e.evidence_id === "e_000001");
    expect(updated!.utterance_ids).toContain("u1");
    expect(updated!.utterance_ids).toContain("u2");
    // Confidence should get bonus
    expect(updated!.confidence).toBeGreaterThan(0.42);
    expect(updated!.source).toBe("llm_backfill");
  });
});
```

**Step 2: Run test to verify fails**

Run: `cd edge/worker && npx vitest run tests/reconcile.test.ts -t "backfillSupportingUtterances" 2>&1 | tail -5`
Expected: FAIL

**Step 3: Implement backfill**

```typescript
export function backfillSupportingUtterances(
  evidence: EvidenceItem[],
  perPerson: PersonFeedbackItem[]
): EvidenceItem[] {
  const evidenceById = new Map(evidence.map((e) => [e.evidence_id, { ...e }]));

  for (const person of perPerson) {
    for (const dim of person.dimensions) {
      const allClaims = [...dim.strengths, ...dim.risks, ...dim.actions];
      for (const claim of allClaims) {
        const supp = (claim as unknown as { supporting_utterances?: string[] }).supporting_utterances;
        if (!supp || supp.length === 0) continue;

        for (const ref of claim.evidence_refs) {
          const ev = evidenceById.get(ref);
          if (!ev) continue;
          // Only backfill if evidence has empty utterance_ids
          if (ev.utterance_ids.length === 0) {
            ev.utterance_ids = [...new Set([...ev.utterance_ids, ...supp])];
            ev.confidence = Math.min(0.95, ev.confidence + 0.10);
            ev.source = "llm_backfill";
          }
        }
      }
    }
  }

  return [...evidenceById.values()];
}
```

**Step 4: Wire into index.ts after LLM response**

After `_parse_llm_output` returns in the finalization pipeline (~line 5150):

```typescript
// After LLM synthesis succeeds and we have finalPerPerson:
evidence = backfillSupportingUtterances(enrichedEvidence, finalPerPerson);
```

Add import for `backfillSupportingUtterances`.

**Step 5: Run all tests**

Run: `cd edge/worker && npx vitest run 2>&1 | tail -10`
Expected: All tests PASS

Run: `cd edge/worker && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

**Step 6: Commit**

```bash
git add edge/worker/src/finalize_v2.ts edge/worker/src/index.ts edge/worker/tests/reconcile.test.ts
git commit -m "feat(evidence): backfill supporting_utterances from LLM into evidence utterance_ids"
```

---

### Task 9: Update DimensionClaim type + buildResultV2 for confidence_level

**Files:**
- Modify: `edge/worker/src/types_v2.ts:131-136`
- Modify: `edge/worker/src/finalize_v2.ts:1054-1131` (buildResultV2)

**Step 1: Add supporting_utterances to DimensionClaim type**

```typescript
export interface DimensionClaim {
  claim_id: string;
  text: string;
  evidence_refs: string[];
  confidence: number;
  supporting_utterances?: string[];  // NEW
}
```

**Step 2: Update buildResultV2 to include confidence_level**

Add `confidenceLevel` param to `buildResultV2` and include in session:

```typescript
export function buildResultV2(params: {
  // ... existing params ...
  confidenceLevel: "high" | "medium" | "low";  // NEW
}): ResultV2 {
  return {
    session: {
      session_id: params.sessionId,
      finalized_at: params.finalizedAt,
      tentative: params.tentative,
      confidence_level: params.confidenceLevel,  // NEW
      unresolved_cluster_count: params.unresolvedClusterCount,
      diarization_backend: params.diarizationBackend,
    },
    // ... rest unchanged
  };
}
```

**Step 3: Run type check + tests**

Run: `cd edge/worker && npx tsc --noEmit 2>&1 | tail -10`
Expected: Errors at call sites — fix each `buildResultV2` call to pass `confidenceLevel`

Fix each call site by adding: `confidenceLevel,` using the local variable computed in Task 5.

Run: `cd edge/worker && npx vitest run 2>&1 | tail -5`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add edge/worker/src/types_v2.ts edge/worker/src/finalize_v2.ts edge/worker/src/index.ts
git commit -m "feat(types): add supporting_utterances to DimensionClaim, confidence_level to ResultV2"
```

---

### Task 10: Full integration verification

**Step 1: TypeScript check**

Run: `cd edge/worker && npx tsc --noEmit`
Expected: 0 errors

**Step 2: Worker tests**

Run: `cd edge/worker && npx vitest run`
Expected: 240+ tests PASS

**Step 3: Inference tests**

Run: `cd inference && python -m pytest tests/ -v`
Expected: 95+ tests PASS

**Step 4: Desktop build**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: Build succeeds

**Step 5: Commit final state**

```bash
git add -A
git commit -m "chore: integration verification — all tests passing"
```
