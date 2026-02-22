# Report Quality Improvements Design

**Date**: 2026-02-18
**Status**: Approved
**Scope**: edge/worker (finalize_v2.ts, index.ts), inference (report_synthesizer.py, schemas.py)

## Problem Statement

The E2E test report (edge diarization, unknown_ratio=0) reveals 4 quality issues:

1. **Evidence mapping rate 25%** — 12/16 evidence items have empty `utterance_ids`, using memo text as pseudo-quotes
2. **Perpetual tentative status** — `unresolved_cluster_count > 0` triggers tentative even with 1 minor unresolved cluster
3. **Talk time inflation** — `sum(talk_time) = 763s` exceeds `audio_duration = 490s` due to cross-speaker overlap
4. **Sparse report content** — 22 claims, 1 summary section, 1 risk (target: 40+ claims, 2+ sections)

**Audience**: Interviewers (full report) and students (per-person section). Both need accurate, evidence-backed, actionable feedback. Student transcript quotes are the primary evidence source; teacher memos supplement.

## Design

### 1. Evidence Dual-Stage Matching

Replace the broken time-based matching (memo wallclock vs utterance audio-relative timestamps) with semantic + LLM matching.

#### Stage 1 — Worker-side semantic pre-matching (`buildMultiEvidence` rewrite)

For each memo:
1. Extract mentioned person names -> `speaker_keys`
2. Filter utterance candidates: all utterances from matching `speaker_key`
3. Score text similarity:
   - **Keyword overlap (50%)** — existing tokenize logic (EN words + ZH bigrams)
   - **Name co-occurrence (30%)** — does memo mention this utterance's speaker?
   - **Content semantic association (20%)** — does memo-described behavior appear in utterance text? (e.g., memo="proposed biocompatibility" matches utterance containing "biocompat")
4. Select top-3 candidates, `confidence = actual_match_score`, clamped to [0.45, 0.90]
5. No match fallback: use memo text as evidence, `confidence = 0.35`

#### Stage 2 — LLM fine-matching (synthesize prompt enhancement)

Add instruction to `report_synthesizer.py` system prompt:

> For each claim, in addition to evidence_refs, select 1-3 transcript segments that best support the claim. Output as `supporting_utterances: [utterance_id, ...]`. Prefer segments containing key arguments, specific examples, or behavioral evidence.

In `_parse_llm_output`, backfill LLM's `supporting_utterances` into the corresponding evidence's `utterance_ids`.

#### Dynamic confidence scores

Remove hardcoded 0.42/0.52/0.56/0.74/0.82. New scheme:

| Source | Confidence |
|--------|-----------|
| Explicit anchor | 0.90 fixed |
| Semantic match hit | match_score * 0.95, clamp [0.45, 0.90] |
| Speaker-only fallback | 0.40 |
| Memo text fallback | 0.35 |
| LLM backfill bonus | original + 0.10, cap 0.95 |

Claim confidence: `avg(evidence confidence scores)` instead of fixed 0.42 penalty.

### 2. Tentative Status Optimization

#### A. Soft threshold

Replace binary tentative with ratio-based confidence level:

```
totalClusters = state.clusters.length
unresolvedRatio = unresolvedClusterCount / totalClusters (or 0 if no clusters)

confidenceLevel:
  "high"   — unresolvedRatio === 0
  "medium" — unresolvedRatio <= 0.25
  "low"    — unresolvedRatio > 0.25

tentative = (confidenceLevel === "low")
```

Add `confidence_level` to session output for frontend display differentiation.

#### B. Memo-assisted binding (conservative)

After reconcile, before stats, attempt to bind unresolved clusters using teacher memos.

**All 5 safety checks must pass** to bind:

1. **Uniqueness**: Only 1 candidate name from nearby memos (ambiguous = skip)
2. **Multi-source corroboration**: At least 2 independent memos point to same name
3. **Content corroboration**: Cluster utterance text contains keywords from memo description
4. **No conflict**: The candidate name is not already bound to another cluster
5. **Minimum volume**: Cluster has >= 2 utterances (single-utterance clusters too noisy)

All pass -> bind with `binding_source: "memo_assisted"`, `locked: false`
Any fail -> keep unresolved, do not bind

Frontend can distinguish: `voice` binding shown normally, `memo_assisted` shown with indicator badge.

#### C. Quality gate adjustment

Relax `unknown_ratio` gate from `<= 10%` to `<= 25%` for non-enrollment scenarios.

### 3. Global Talk Time Deduplication

After existing per-speaker segment merging in `computeSpeakerStats()`, add global timeline correction:

#### Algorithm

```
Step 1: Build global occupancy timeline
  - Sort all utterances by start_ms
  - For each time point, record which speakers are active
  - Result: Array<{ start, end, speakers: string[] }>

Step 2: Allocate overlapping time
  - 1 speaker active: 100% to that speaker
  - N speakers active: each gets (end - start) / N

Step 3: Upper-bound clamp
  - audioDurationMs = max(transcript[].end_ms)
  - if sum(talk_times) > audioDurationMs:
      scale = audioDurationMs / sum(talk_times)
      each speaker.talk_time *= scale

Step 4: Compute percentage
  - talk_time_pct = talk_time / audioDurationMs
```

New output field: `talk_time_pct: number` added to stats. `turns` and `interruptions` unchanged.

### 4. Report Content Enrichment

#### A. Evidence pack enrichment

Before calling `synthesize`, auto-generate additional evidence:

1. **Transcript quote evidence** (per speaker): Select top-5 longest/most substantive utterances. `type: "transcript_quote"`, `confidence: 0.85`

2. **Stats summary evidence** (per speaker): Generate 1 statistical summary per speaker (e.g., "Tina spoke 9 times, 42% of total, interrupted once"). `type: "stats_summary"`, `confidence: 0.95`

3. **Interaction pattern evidence** (cross-speaker): Scan adjacent utterance pairs for collaboration signals ("agree"), interruption patterns, summarization behavior. `type: "interaction_pattern"`, `confidence: 0.70`

Target: evidence_pack from ~16 to ~40-60 items covering all 5 dimensions.

#### B. Increase transcript context

Increase transcript truncation from 3000 to 6000 tokens. Group by speaker for better LLM comprehension:

```
[Tina] "I think biocompatibility is most important because..."
[Rice] "I agree, without it patients may need secondary surgery..."
```

#### C. Summary/dynamics minimums

Add to prompt output_contract:

- `summary_sections`: minimum 2 topic segments
- `team_dynamics.highlights`: minimum 2
- `team_dynamics.risks`: minimum 2

#### D. Pre-generated stats observations

Add `stats_observations` field to user prompt with auto-generated insights:

```json
[
  "Tina's talk time is highest (42%), significantly ahead of others",
  "Rice spoke fewest times (5) but with longest average duration",
  "Daisy and Rice had 3 rapid responses (<1s gap), high collaboration frequency",
  "Discussion entered ranking phase at 260s but did not complete full ranking"
]
```

LLM can incorporate these data insights into the report but is not forced to cite them.

## Files Affected

| File | Changes |
|------|---------|
| `edge/worker/src/finalize_v2.ts` | Rewrite `buildMultiEvidence`, add `enrichEvidencePack`, add `memoAssistedBinding`, add `globalTimelineDedup` |
| `edge/worker/src/index.ts` | Update tentative logic (soft threshold + confidence_level), update quality gate threshold, wire new finalize stages |
| `edge/worker/src/types_v2.ts` | Add `confidence_level`, `binding_source`, `talk_time_pct`, `stats_observations` types |
| `inference/app/services/report_synthesizer.py` | Add `supporting_utterances` instruction to prompt, add stats_observations to user prompt, add summary/dynamics minimums |
| `inference/app/schemas.py` | Add `supporting_utterances` to DimensionClaim, add `talk_time_pct` to stats |

## Success Criteria

- Evidence mapping rate >= 75% (from 25%)
- Average evidence confidence >= 0.65 (from 0.46)
- Tentative rate < 30% of sessions (from ~100%)
- `sum(talk_time)` within 5% of `audio_duration`
- Claims per report >= 35 (from 22)
- Summary sections >= 2, team_dynamics risks >= 2

## Non-Goals

- Changing the LLM model or adding multi-round LLM calls
- Modifying the upstream diarization/ASR pipeline
- Changing the 5-dimension evaluation framework
- Enforcing per-dimension minimum claim counts (let LLM decide naturally)
