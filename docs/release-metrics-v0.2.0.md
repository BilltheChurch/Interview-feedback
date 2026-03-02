# Release Metrics: v0.2.0 — Incremental Audio Pipeline

**Date**: 2026-03-02
**Branch**: main (post-merge of PR #8 + PR #7)
**Commits**: 82 files changed, +19,271 / -184

---

## E2E Smoke Test Results

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Audio source | qingnian_test.wav (8.3 min, zh) | — | — |
| Processing RTF | 0.125 | < 1.0 | PASS |
| Speakers detected | 4 (stable after increment 1) | >= 2 | PASS |
| Speaker consistency | pre-merge=4, post-merge=4 | match | PASS |
| Increments | 2/2 succeeded (0 failed) | 0 failures | PASS |
| Final utterances | 61 | > 0 | PASS |
| Avg increment time | 31.4s | — | — |
| Max increment time | 34.4s | — | — |
| Avg diarization | 20.4s | — | — |
| Avg ASR | 7.2s | — | — |
| Total processing | 62.7s for 8.3min audio | — | — |
| Finalize time | 33.3s | < 30s (soft) | WARN |
| Finalize p95 | 33.3s (single run) | — | — |

### Per-Increment Detail

| Index | Mode | Range | Elapsed | Diar | ASR | Speakers | Utterances | Stable |
|-------|------|-------|---------|------|-----|----------|------------|--------|
| 0 | CUMUL | 0-180s | 28.3s | 13.4s | 7.8s | 4 | 15 | no |
| 1 | CUMUL | 0-360s | 34.4s | 27.5s | 6.7s | 4 | 37 | yes |
| fin | FINAL | 330-500s | 33.3s | — | — | 4 | 61 | — |

---

## Recompute Metrics (Unit Test Verified)

Recompute counters are only available through V1 finalize endpoint (`/v1/incremental/finalize`).
These were verified by 5 dedicated unit tests in `test_finalize_recompute.py`:

| Metric | Test | Status |
|--------|------|--------|
| recompute_requested | AC10: response metrics contain counter | PASS |
| recompute_succeeded | AC1: low-confidence text replaced | PASS |
| recompute_skipped | AC: no recompute_asr → silently skipped | PASS |
| recompute_failed | AC2: failure doesn't block report | PASS |
| dual-key alignment | AC9: utterance_id primary, coords fallback | PASS |

---

## Test Suite Health

| Suite | Tests | Time | Status |
|-------|-------|------|--------|
| Inference (Python) | 484 | 2.62s | ALL PASS |
| Worker (TypeScript) | 336 | 756ms | ALL PASS |
| **Total** | **820** | **3.4s** | **ALL PASS** |

---

## Report Success Rate

LLM analysis was not enabled during E2E smoke (`--run-analysis` not set) to avoid
DashScope API dependency. Report generation is covered by:
- `test_report_synthesizer.py`: 6 tests covering synthesis pipeline
- `test_llm_adapter_wiring.py`: adapter wiring verification

---

## PR Merge History

| PR | Title | Merged | Commit |
|----|-------|--------|--------|
| #8 | L1: V2 Incremental Pipeline | 2026-03-02 | `0cf035f` |
| #7 | L2+L3: B-Prime + SelectiveRecomputeASR | 2026-03-02 | `4d007d3` |

---

## Components Delivered

### L1: V2 Pipeline Foundation (17 commits, 53 files)
- Versioned schemas (v1) with explicit `"v": 1`
- IncrementalProcessor: diarization + ASR + speaker mapping
- Redis state management (IncrementalSessionState)
- LLM protocol adapter (DashScope qwen-flash)
- V1 finalize with transcript merge + speaker stats
- CI: unit + integration split with Redis service

### L2: B-Prime Quality Wiring (16 commits, 22 files)
- CAM++ Pass 3 arbiter: real audio slicing for low-confidence speakers
- Parakeet TDT ASR: TranscriptResult interface + NeMo fallback
- WS route fix: asyncio.to_thread + dual-format speaker_profiles
- E2E gate verification tests

### L3: SelectiveRecomputeASR (12 commits, 37 files)
- RecomputeSegment schema with R2 audio refs
- V1 finalize recompute step (4.5): dual-key utterance alignment
- 8MB payload guard with priority queue
- 4-counter metrics (requested/succeeded/skipped/failed)
- Graceful degradation on recompute failure
