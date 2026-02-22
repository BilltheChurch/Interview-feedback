# Speaker Diarization Upgrade — Implementation Plan

**Date:** 2026-02-18
**Design Doc:** `2026-02-18-speaker-diarization-upgrade-design.md`
**Status:** In Progress

---

## Phase 1: Provider Interfaces + Embedding Cache + Global Clustering

**Goal:** Enable Tier 1 embedding-based speaker identification. Finalization <30s with globally consistent speaker IDs.

### Task 1.1: Define Provider Interface Types

**Files:** `edge/worker/src/providers/types.ts` (NEW)

Create TypeScript interfaces for all four provider types:
- `ASRProvider` (streaming + batch modes)
- `DiarizationProvider` (streaming + batch modes)
- `SpeakerVerificationProvider` (embedding extraction + scoring)
- `LLMProvider` (report synthesis)
- Supporting types: `Utterance`, `WordTimestamp`, `SpeakerSegment`, `DiarizeResult`, `AudioInput`, `AudioChunk`, `ProviderConfig`
- `ProviderRegistry` class that manages provider instances by config

Reference: Section 4 of design doc for full interface definitions.

### Task 1.2: Extract Existing Code into Provider Implementations

**Files:**
- `edge/worker/src/providers/asr-funASR.ts` (NEW) — Extract FunASR WebSocket logic from `index.ts`
- `edge/worker/src/providers/diarize-pyannote-rs.ts` (NEW) — Extract pyannote-rs sidecar calls from `index.ts`
- `edge/worker/src/providers/speaker-verify-campp.ts` (NEW) — Extract CAM++ calls from `inference_client.ts`
- `edge/worker/src/providers/llm-dashscope.ts` (NEW) — Extract DashScope LLM calls from `finalize_v2.ts`

Each provider implements the corresponding interface from Task 1.1. Existing behavior must be preserved exactly — this is a pure refactor.

**Verification:** All 59 existing worker tests must pass. E2E test must still pass.

### Task 1.3: Implement Embedding Cache

**Files:** `edge/worker/src/embedding-cache.ts` (NEW)

```typescript
class EmbeddingCache {
  // Store embedding for a diarization segment
  addEmbedding(entry: CachedEmbedding): void;

  // Get all cached embeddings for a session
  getAllEmbeddings(): CachedEmbedding[];

  // Get embeddings by stream role
  getByStreamRole(role: 'students' | 'teacher'): CachedEmbedding[];

  // Memory usage tracking
  getMemoryUsageBytes(): number;

  // Clear cache
  clear(): void;
}
```

- Backed by a `Map<string, CachedEmbedding>` in Durable Object memory
- Memory limit: 2MB (configurable) — ~1000 segments max
- Serialization support for Durable Object hibernation

**Tests:** `embedding-cache.test.ts` — add/get/clear/memory limit/serialization

### Task 1.4: Implement Global Clustering Algorithm

**Files:** `edge/worker/src/global-cluster.ts` (NEW)

Agglomerative clustering in pure TypeScript (no external dependencies, must run in Cloudflare Worker):

```typescript
function globalCluster(
  embeddings: CachedEmbedding[],
  options: ClusterOptions
): GlobalClusterResult;

interface ClusterOptions {
  distance_threshold: number;    // default 0.3
  linkage: 'average' | 'complete' | 'single';  // default 'average'
  min_cluster_size: number;      // default 1
  max_clusters?: number;         // optional hint
}

interface GlobalClusterResult {
  clusters: Map<string, string[]>;  // global_speaker_id → [segment_ids]
  centroids: Map<string, Float32Array>;  // global_speaker_id → centroid embedding
  confidence: number;  // overall clustering confidence
}
```

Key functions:
- `cosineSimilarity(a: Float32Array, b: Float32Array): number`
- `computeDistanceMatrix(embeddings: Float32Array[]): Float32Array`
- `agglomerativeClustering(distMatrix: Float32Array, n: number, threshold: number): number[]`
- `mapClustersToRoster(clusters: GlobalClusterResult, roster: Participant[], enrollments: Map<string, Float32Array>): Map<string, string>`

**Tests:** `global-cluster.test.ts`
- Synthetic embeddings: 4 distinct speakers, verify correct grouping
- Edge cases: single speaker, all same speaker, empty input
- Threshold sensitivity: verify threshold=0.3 separates speakers correctly
- Roster mapping: verify enrollment embeddings correctly name clusters

### Task 1.5: Wire Embedding Extraction into Recording Pipeline

**Files:**
- `edge/worker/src/index.ts` — Modify the pyannote-rs segment callback

When pyannote-rs returns segments for a window:
1. For each segment with duration > 500ms (skip very short segments)
2. Extract corresponding PCM audio from buffered chunks
3. Call `SpeakerVerificationProvider.extractEmbedding(audio)`
4. Store result in `EmbeddingCache`

This must be **async and non-blocking** — embedding extraction should not delay the main audio pipeline.

Error handling: If embedding extraction fails for a segment, log warning and continue. Missing embeddings are acceptable — clustering works with partial data.

### Task 1.6: Add Global Clustering to Finalization Pipeline

**Files:**
- `edge/worker/src/finalize_v2.ts` — Add clustering step before reconciliation

In the finalization pipeline, after `freeze` and `drain` stages, add new `cluster` stage:

```
freeze → drain → replay → CLUSTER → reconcile → stats → events → report → persist
```

The `cluster` stage:
1. Load all embeddings from `EmbeddingCache`
2. Run `globalCluster()` with configured threshold
3. Map clusters to roster names using enrollment embeddings + name extraction
4. Pass `GlobalClusterResult` to reconciliation

### Task 1.7: Enhance Reconciliation with Global Clusters

**Files:** `edge/worker/src/reconcile.ts`

Update `buildReconciledTranscript` to accept `GlobalClusterResult` as an additional parameter.

New resolution logic:
1. For each utterance, find the segment from `EmbeddingCache` that best overlaps in time
2. Look up that segment's global cluster assignment
3. Use the cluster→roster mapping for speaker name
4. This becomes Priority 2 (after manual binding) — higher than name extraction alone

Update `resolveStudentBinding` to accept and use global cluster data.

### Task 1.8: Update Type Definitions

**Files:** `edge/worker/src/types_v2.ts`

Add types:
- `CachedEmbedding`
- `GlobalClusterResult`, `ClusterOptions`
- `ProviderConfig`
- `EmbeddingCacheState` (for DO serialization)
- Update `SessionState` to include `embedding_cache_size`, `global_clusters`

### Task 1.9: Phase 1 Integration Tests

Run full E2E test with embedding cache + global clustering enabled:
- Verify 0% unknown speakers
- Verify speaker assignments match ground truth
- Verify finalization time < 30s
- Verify all existing unit tests still pass
- Compare Tier 1 result quality vs. current name-extraction-only result

---

## Phase 2: Tier 2 Batch Processor

**Goal:** Build batch re-processing pipeline using Whisper + pyannote full pipeline. Runs as background task after Tier 1 completes.

### Task 2.1: Whisper Batch Transcription Service

**Files:** `inference/app/services/whisper_batch.py` (NEW)

Wrapper around faster-whisper (NVIDIA), whisper.cpp (CPU/Metal/Vulkan), or MLX-Whisper (Apple Silicon):

```python
class WhisperBatchTranscriber:
    def __init__(self, model_size: str = "large-v3", device: str = "auto"):
        # Auto-detect: CUDA → faster-whisper, MPS → MLX, CPU → whisper.cpp
        pass

    def transcribe(self, audio_path: str, language: str = "auto") -> TranscriptResult:
        # Returns utterances with word-level timestamps
        pass
```

Must handle:
- Automatic device detection (CUDA, ROCm, MPS, CPU)
- Model download and caching
- Language detection (Chinese + English mixed)
- Word-level timestamp extraction

**Tests:** `tests/test_whisper_batch.py` — transcription accuracy on test audio

### Task 2.2: pyannote Full Pipeline Diarization Service

**Files:** `inference/app/services/diarize_full.py` (NEW)

Wrapper around pyannote.audio complete pipeline:

```python
class PyannoteFullDiarizer:
    def __init__(self, device: str = "auto", hf_token: str = None):
        # Loads pyannote/speaker-diarization-3.1
        pass

    def diarize(self, audio_path: str, num_speakers: int = None) -> DiarizeResult:
        # Returns globally consistent speaker segments + embeddings
        pass
```

Must handle:
- HuggingFace authentication (pyannote requires license acceptance)
- Device auto-detection
- Optional num_speakers hint
- Returns both segments AND embeddings (for speaker verification matching)

**Tests:** `tests/test_diarize_full.py` — speaker count accuracy, segment timing

### Task 2.3: Batch Processing API Endpoints

**Files:** `inference/app/routes/batch.py` (NEW)

```python
# POST /batch/transcribe
# Input: { audio_url: str, language: str, model: str }
# Output: { utterances: [...], words: [...], language: str }

# POST /batch/diarize
# Input: { audio_url: str, num_speakers: int? }
# Output: { segments: [...], embeddings: {...}, clusters: {...} }

# POST /batch/process
# Combined: transcribe + diarize + align + merge
# Input: { audio_url: str, num_speakers: int?, language: str }
# Output: { transcript: [...], speaker_stats: {...} }
```

### Task 2.4: Tier 2 Trigger in Finalization Pipeline

**Files:** `edge/worker/src/finalize_v2.ts`

After Tier 1 finalization completes successfully:
1. Check if `tier2.enabled && tier2.auto_trigger`
2. If yes, spawn background Tier 2 processing:
   a. Download raw PCM from R2
   b. Send to batch processor (`/batch/process`)
   c. Receive full transcript with global speaker IDs
   d. Re-reconcile with manual bindings preserved
   e. Re-generate LLM report
   f. Store as `report_version: 'tier2_refined'`
   g. Update session state

Tier 2 must NOT block Tier 1 response. Use Durable Object alarm or async processing.

### Task 2.5: Tier 2 Status Tracking

**Files:** `edge/worker/src/types_v2.ts`, `edge/worker/src/index.ts`

Add Tier 2 status to session state:
```typescript
interface Tier2Status {
  enabled: boolean;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  started_at?: number;
  completed_at?: number;
  error?: string;
  report_version: 'tier1_instant' | 'tier2_refined';
}
```

Add API endpoint: `GET /v1/sessions/:id/tier2-status`

### Task 2.6: Update Dependencies

**Files:** `inference/requirements.txt`, `inference/Dockerfile`

Add:
- `pyannote.audio>=3.1` (requires HF token + license acceptance)
- `faster-whisper>=1.0` (for NVIDIA)
- `whisperx>=3.1` (for word-level alignment)

Optional (detected at runtime):
- `mlx-whisper` (Apple Silicon only)

Update Dockerfile to include these dependencies.

### Task 2.7: Phase 2 Integration Tests

- E2E test with Tier 2 enabled
- Verify Tier 1 completes in <30s
- Verify Tier 2 completes in <3 min (background)
- Verify Tier 2 result replaces Tier 1
- Verify report_version transitions: `tier1_instant` → `tier2_refined`
- Compare Tier 1 vs Tier 2 speaker accuracy

---

## Phase 3: Desktop UI Updates

**Goal:** Show Tier 2 status in UI, handle report version updates, add provider configuration.

### Task 3.1: Update useDraftFeedback Hook

**Files:** `desktop/src/hooks/useDraftFeedback.ts`

Current behavior: polls for report until finalized.
New behavior:
1. Poll until Tier 1 report arrives → show immediately
2. Continue polling for Tier 2 status
3. When Tier 2 completes, fetch updated report and update state
4. Smooth transition (no flash/reload)

### Task 3.2: Update FeedbackView for Two-Tier Display

**Files:** `desktop/src/views/FeedbackView.tsx`

- Show small "Refining report..." indicator after Tier 1 loads
- When Tier 2 completes, smooth-update all sections (transcript, stats, claims)
- Add subtle "Enhanced" badge when viewing Tier 2 report
- Show version info in report metadata

### Task 3.3: Provider Configuration in Settings

**Files:** `desktop/src/views/SettingsView.tsx`

Add configuration section for:
- ASR provider selection (streaming + batch)
- Diarization provider selection
- Tier 2 enable/disable toggle
- Batch processor endpoint (local vs remote)

Store in Electron settings (via `desktopAPI.storeSet`).

### Task 3.4: Phase 3 Verification

- Verify Tier 1 report displays immediately (<30s)
- Verify "Refining..." indicator appears
- Verify smooth transition to Tier 2 report
- Verify settings persist across app restarts
- Verify TypeScript check passes: `npx tsc --noEmit`
- Verify build succeeds: `npx vite build`

---

## Phase 4: Additional Provider Implementations

**Goal:** Make the framework useful for open-source users with different hardware/API preferences.

### Task 4.1: Groq Whisper Provider

**Files:** `edge/worker/src/providers/asr-groq.ts` (NEW)

Implement `ASRProvider` using Groq's Whisper API:
- Free tier: 28,800 audio-seconds/day
- Supports both streaming and batch modes
- API key configured via wrangler secrets

### Task 4.2: OpenAI Whisper Provider

**Files:** `edge/worker/src/providers/asr-openai.ts` (NEW)

Implement `ASRProvider` using OpenAI's Audio API:
- Batch mode only (no streaming)
- $0.006/minute
- Word-level timestamps available

### Task 4.3: Local Whisper Provider (Batch Processor)

**Files:** `inference/app/services/whisper_local.py` (NEW)

Unified local Whisper wrapper that auto-detects backend:
- NVIDIA GPU → faster-whisper (CTranslate2)
- AMD GPU → whisper.cpp (Vulkan) or PyTorch (ROCm)
- Apple Silicon → MLX-Whisper or whisper.cpp (Metal)
- CPU only → whisper.cpp (CPU)

### Task 4.4: OpenAI LLM Provider

**Files:** `edge/worker/src/providers/llm-openai.ts` (NEW)

Alternative LLM provider using OpenAI API for report synthesis.

### Task 4.5: Ollama LLM Provider

**Files:** `edge/worker/src/providers/llm-ollama.ts` (NEW)

Local LLM provider using Ollama for report synthesis (fully offline operation).

### Task 4.6: Provider Documentation

**Files:** `docs/providers.md` (NEW)

Document all available providers:
- Setup instructions for each
- Cost comparison table
- Performance benchmarks
- Configuration examples

---

## Phase 5: Diart Streaming Diarization (Optional Enhancement)

**Goal:** Replace pyannote-rs per-window segmentation with Diart's cross-window speaker tracking for real-time consistent speaker IDs during recording.

### Task 5.1: Diart Streaming Service

**Files:** `inference/app/services/diart_streaming.py` (NEW)

Implement Diart streaming diarization as an inference service endpoint:
- Maintains speaker embedding cache across windows
- Provides globally consistent IDs during recording (not just at finalization)
- WebSocket endpoint for real-time segment streaming

### Task 5.2: Diart Diarization Provider

**Files:** `edge/worker/src/providers/diarize-diart.ts` (NEW)

Implement `DiarizationProvider` for Diart:
- Connects to Diart streaming service via WebSocket
- Receives real-time speaker segments with consistent IDs
- Still extracts embeddings for cache (Tier 1 clustering becomes a no-op if Diart already provides global IDs)

### Task 5.3: Desktop Real-Time Speaker Display

**Files:** `desktop/src/views/SidecarView.tsx`

When Diart streaming is active:
- Show real-time speaker activity with names (not just audio levels)
- Display live talk-time percentages
- Show who is currently speaking

### Task 5.4: Phase 5 Integration Tests

- Real-time speaker ID accuracy during recording
- Verify speaker IDs are consistent across entire session
- Compare Diart streaming vs. Tier 1 post-hoc clustering accuracy
- Performance: Diart should not add >500ms latency

---

## Verification Checklist (All Phases)

After each phase, verify:

```bash
# Desktop
cd desktop && npx tsc --noEmit && npx vite build

# Edge Worker
cd edge/worker && npm run typecheck && npx vitest run

# Inference
cd inference && python -m pytest tests/ -v

# E2E
node desktop/e2e_group_interview_test.mjs 2>&1 | tee /tmp/e2e_run_latest.log
```

Quality gates:
- [ ] All existing tests pass (217 total)
- [ ] E2E test passes with 0% unknown speakers
- [ ] Finalization time < 30s (Tier 1)
- [ ] Tier 2 completes in < 3 minutes (when enabled)
- [ ] No TypeScript errors
- [ ] No Python lint errors
- [ ] Speaker accuracy > 90% (Tier 1), > 98% (Tier 2)
