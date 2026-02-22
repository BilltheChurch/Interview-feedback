# Speaker Diarization Upgrade — Production-Grade Pluggable Architecture

**Date:** 2026-02-18
**Status:** Approved
**Author:** Claude Code + Bill

---

## 1. Problem Statement

The current speaker diarization system has five critical limitations preventing production-grade accuracy:

1. **No global speaker clustering** — pyannote-rs sidecar runs per-window (10s) segmentation, producing local IDs (`SPEAKER_00`, `SPEAKER_01`) that are NOT consistent across windows.
2. **Name extraction dependency** — Without self-introduction text (e.g. "my name is Tina"), speaker identification breaks entirely.
3. **ASR quality ceiling** — Aliyun FunASR produces long consolidation artifacts (200s+ utterances) and only ~2 clusters for 4 speakers.
4. **No streaming diarization** — All processing is post-hoc; users see no speaker activity during recording.
5. **pyannote-rs instability** — ~10/245 window failures (500 errors) per session.

### Current E2E Status

After recent fixes (cloud ASR fallback + artifact deduplication), E2E tests pass with 0% unknown speakers. However, this relies entirely on name extraction heuristics — a fragile foundation that breaks for sessions without self-introductions.

---

## 2. User Personas & Requirements

### Persona A: Mock Interview Trainer (Primary — Bill)

- Conducts 1-2 mock interviews per month on MacBook Pro M1 Pro
- Has a Windows desktop with AMD 7900 XTX (24GB VRAM)
- **Critical requirement: <60 second finalization** — needs to give feedback immediately after mock session ends
- Willing to run local processing (no cloud GPU budget for low volume)
- Needs both group (4 speakers) and 1:1 interview modes

### Persona B: University Interviewer (Commercial — e.g. Imperial College)

- Conducts real interviews; doesn't need immediate feedback
- Wants accurate, detailed performance reports
- May not have local GPU; needs cloud API or hosted option
- Report accuracy > speed

### Persona C: Open-Source Self-Deployer

- Deploys on own hardware (NVIDIA/AMD/Apple Silicon) or cloud
- Needs pluggable providers — chooses own ASR, diarization, LLM
- No hosted API provided by us

---

## 3. Architecture Overview

### 3.1 Two-Tier Processing Model

```
Tier 1 (Instant, <30s):
  Uses streaming data collected during recording
  + fast global clustering on cached embeddings
  + LLM report synthesis
  → Immediate feedback for trainers

Tier 2 (Refined, 2-3min background):
  Full batch re-processing with Whisper large-v3
  + pyannote.audio complete pipeline (seg→embed→global cluster)
  + word-level alignment
  + re-generated LLM report
  → Silently replaces Tier 1 result for archival
```

### 3.2 System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Desktop (Electron)                            │
│  Capture: Mic + System Audio → dual WebSocket streams                │
│  UI: Shows Tier 1 immediately, smooth-updates to Tier 2              │
└──────────┬───────────────────────────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────────────────────────┐
│                     Edge Worker (Cloudflare)                          │
│                                                                       │
│  ┌─────────────┐  ┌──────────────────┐  ┌────────────────────────┐  │
│  │ Audio Ingest │  │ ASR Provider     │  │ Diarization Provider   │  │
│  │ (unchanged)  │  │ (pluggable)      │  │ (pluggable)            │  │
│  │              │→ │                  │  │                        │  │
│  │  R2 storage  │  │ Default:         │  │ Default:               │  │
│  │  (raw PCM)   │  │  FunASR stream   │  │  pyannote-rs sidecar   │  │
│  └──────────────┘  └────────┬─────────┘  └──────────┬─────────────┘  │
│                             │                        │                │
│  ┌──────────────────────────▼────────────────────────▼─────────────┐  │
│  │              Embedding Cache (Durable Object memory)             │  │
│  │  Per segment: { embedding, start_ms, end_ms, window_cluster_id } │  │
│  └──────────────────────────┬──────────────────────────────────────┘  │
│                             │                                         │
│  ┌──────────────────────────▼──────────────────────────────────────┐  │
│  │  Finalization Pipeline                                           │  │
│  │  Tier 1: global_cluster → reconcile → stats → LLM (~27s)        │  │
│  │  Tier 2: whisper_batch → pyannote_full → reconcile → LLM (bg)   │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
           │                              │
┌──────────▼────────────┐    ┌────────────▼──────────────────────────┐
│  Speaker Verification  │    │  Batch Processor                      │
│  Provider (pluggable)  │    │  (local GPU or cloud API, pluggable)  │
│  Default: CAM++        │    │  Default: whisper.cpp + pyannote.audio │
└────────────────────────┘    └────────────────────────────────────────┘
```

---

## 4. Provider Interfaces

### 4.1 ASR Provider

```typescript
interface ASRProvider {
  readonly name: string;
  readonly mode: 'streaming' | 'batch' | 'both';

  // Streaming: real-time transcription during recording
  startStreaming?(config: ASRStreamConfig): AsyncIterable<Utterance>;

  // Batch: full-file transcription for Tier 2
  transcribeBatch?(audio: AudioInput): Promise<Utterance[]>;
}

interface Utterance {
  id: string;
  text: string;
  start_ms: number;
  end_ms: number;
  words?: WordTimestamp[];   // word-level alignment (Tier 2)
  language?: string;
  confidence?: number;
}

interface WordTimestamp {
  word: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
}
```

**Built-in implementations:**

| Provider | Mode | Engine | Notes |
|----------|------|--------|-------|
| `FunASRProvider` | streaming | Aliyun DashScope | Existing, backward compatible |
| `GroqWhisperProvider` | both | Groq API | Free tier, fast |
| `OpenAIWhisperProvider` | batch | OpenAI API | $0.006/min |
| `LocalWhisperProvider` | batch | whisper.cpp/MLX/faster-whisper | Local GPU/CPU |
| `StreamingWhisperProvider` | streaming | whisper.cpp streaming | Local GPU |

### 4.2 Diarization Provider

```typescript
interface DiarizationProvider {
  readonly name: string;
  readonly mode: 'streaming' | 'batch' | 'both';

  // Streaming: per-window segmentation + optional embedding extraction
  processWindow?(window: AudioWindow): Promise<DiarizeResult>;

  // Batch: full-file diarization with global clustering
  diarizeBatch?(audio: AudioInput, opts?: DiarizeOptions): Promise<DiarizeResult>;
}

interface DiarizeResult {
  segments: SpeakerSegment[];
  embeddings?: Map<string, Float32Array>;  // segment_id → embedding vector
  global_clustering_done: boolean;
}

interface SpeakerSegment {
  id: string;
  speaker_id: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
}

interface DiarizeOptions {
  num_speakers?: number;      // hint: known number of speakers
  min_speakers?: number;
  max_speakers?: number;
  embedding_model?: string;   // 'wespeaker' | 'cam++' | 'ecapa'
}
```

**Built-in implementations:**

| Provider | Mode | Global Clustering | Notes |
|----------|------|-------------------|-------|
| `PyannoteRsSidecar` | streaming | No (per-window) | Existing sidecar |
| `PyannoteFullPipeline` | batch | Yes | Full pyannote.audio pipeline |
| `DiartStreaming` | streaming | Yes (cross-window) | Future Phase 5 |

### 4.3 Speaker Verification Provider

```typescript
interface SpeakerVerificationProvider {
  readonly name: string;
  extractEmbedding(audio: AudioChunk): Promise<Float32Array>;
  scoreEmbeddings(a: Float32Array, b: Float32Array): number;
  extractBatch?(segments: AudioChunk[]): Promise<Map<string, Float32Array>>;
}
```

**Built-in:** `CAMPPInference` (existing remote), `CAMPPLocal` (ONNX), `WespeakerLocal` (ONNX).

### 4.4 LLM Provider

```typescript
interface LLMProvider {
  readonly name: string;
  synthesizeReport(context: ReportContext): Promise<Report>;
  regenerateClaim?(claim: Claim, context: ReportContext): Promise<Claim>;
}
```

**Built-in:** `DashScopeProvider` (existing), `OpenAIProvider`, `OllamaProvider`.

---

## 5. Incremental Embedding Pipeline

### 5.1 During Recording

Each time pyannote-rs sidecar returns segments for a 10-second window:

1. Extract the corresponding PCM audio slice from buffered chunks
2. Call `SpeakerVerificationProvider.extractEmbedding()` for each segment
3. Store in `EmbeddingCache` (Durable Object memory):

```typescript
interface CachedEmbedding {
  segment_id: string;
  embedding: Float32Array;       // 512-dim vector
  start_ms: number;
  end_ms: number;
  window_cluster_id: string;     // per-window ID (not globally consistent)
  stream_role: 'students' | 'teacher';
}
```

Memory footprint: ~512 floats × 4 bytes × ~60 segments = ~120KB for 10 min audio.

### 5.2 At Finalization (Tier 1)

```
Step 1: Load all cached embeddings (~60 for 10min audio)
Step 2: Compute 60×60 cosine similarity matrix              → <0.1s
Step 3: Agglomerative clustering (distance_threshold=0.3)    → <0.1s
Step 4: Map clusters to roster names via:
        a. Enrollment embedding similarity (CAM++)           → <0.5s
        b. Name extraction from transcript (existing)        → <0.1s
Step 5: Remap all utterances to globally consistent names    → <0.1s
Total: ~5s
```

### 5.3 Global Clustering Algorithm

Implemented in TypeScript (runs in Cloudflare Worker):

```typescript
function globalCluster(
  embeddings: CachedEmbedding[],
  threshold: number = 0.3
): Map<string, string[]> {
  // 1. Compute pairwise cosine distance matrix
  const n = embeddings.length;
  const dist = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - cosineSimilarity(embeddings[i].embedding, embeddings[j].embedding);
      dist[i * n + j] = d;
      dist[j * n + i] = d;
    }
  }

  // 2. Agglomerative clustering (average linkage)
  const clusters = agglomerativeClustering(dist, n, threshold);

  // 3. Return cluster_id → [segment_ids]
  return clusters;
}
```

---

## 6. Reconciliation Enhancement

### 6.1 Updated Resolution Priority

```
Priority 1: Manual binding (user correction)              → auto
Priority 2: Global cluster + enrollment embedding match    → auto     [NEW]
Priority 3: Global cluster + name extraction match         → confirm  [NEW]
Priority 4: Edge turn + enrollment match                   → confirm  [existing]
Priority 5: Edge turn + name extraction                    → confirm  [existing]
Priority 6: Cloud ASR event fallback                       → unknown  [existing]
Priority 7: Unresolved                                     → _unknown
```

### 6.2 Tier 2 Silent Replacement

When Tier 2 batch processing completes:

1. Completely replace `reconciled_transcript` with batch-processed version
2. Recompute `speaker_stats` from new transcript
3. Re-synthesize LLM report using improved transcript
4. Update `report_version` to `'tier2_refined'`
5. Notify Desktop via existing polling mechanism or push
6. Desktop `useDraftFeedback` hook detects version change and smooth-updates UI

---

## 7. Configuration

### 7.1 Session-Level Config

```typescript
interface ProviderConfig {
  asr: {
    streaming: 'funASR' | 'groq' | 'openai' | 'local-whisper' | 'streaming-whisper';
    batch: 'local-whisper' | 'groq' | 'openai' | 'funASR';
    model?: string;                // e.g. 'large-v3', 'turbo'
    language?: string;             // e.g. 'zh', 'en', 'auto'
  };
  diarization: {
    streaming: 'pyannote-rs' | 'diart' | 'none';
    batch: 'pyannote-full' | 'none';
    max_speakers?: number;
  };
  speaker_verification: 'cam-pp-inference' | 'cam-pp-local' | 'wespeaker-local';
  llm: 'dashscope' | 'openai' | 'ollama';
  tier2: {
    enabled: boolean;
    auto_trigger: boolean;         // auto-start after Tier 1
    processor: 'local' | 'remote'; // where batch runs
    endpoint?: string;             // if remote
  };
}
```

### 7.2 Default Configs by Persona

**Mock Interview Trainer (Bill's setup):**
```yaml
asr:
  streaming: funASR
  batch: local-whisper
  model: large-v3
diarization:
  streaming: pyannote-rs
  batch: pyannote-full
speaker_verification: cam-pp-inference
llm: dashscope
tier2:
  enabled: true
  auto_trigger: true
  processor: local
```

**University Interviewer (no local GPU):**
```yaml
asr:
  streaming: groq
  batch: groq
  model: whisper-large-v3-turbo
diarization:
  streaming: none
  batch: pyannote-full   # runs on their cloud instance
speaker_verification: cam-pp-local
llm: openai
tier2:
  enabled: true
  auto_trigger: true
  processor: remote
  endpoint: https://their-gpu-server/batch
```

---

## 8. File Change Manifest

### New Files

| File | Purpose |
|------|---------|
| `edge/worker/src/providers/types.ts` | Shared provider interface types |
| `edge/worker/src/providers/asr-funASR.ts` | FunASR streaming provider (extract from index.ts) |
| `edge/worker/src/providers/asr-groq.ts` | Groq Whisper API provider |
| `edge/worker/src/providers/diarize-pyannote-rs.ts` | pyannote-rs sidecar provider (extract) |
| `edge/worker/src/providers/speaker-verify-campp.ts` | CAM++ verification provider (extract) |
| `edge/worker/src/providers/llm-dashscope.ts` | DashScope LLM provider (extract) |
| `edge/worker/src/embedding-cache.ts` | Incremental embedding cache manager |
| `edge/worker/src/global-cluster.ts` | Agglomerative clustering in TypeScript |
| `inference/app/routes/batch.py` | Tier 2 batch processing API endpoints |
| `inference/app/services/diarize_full.py` | pyannote.audio full pipeline wrapper |
| `inference/app/services/whisper_batch.py` | Whisper batch transcription wrapper |

### Modified Files

| File | Changes |
|------|---------|
| `edge/worker/src/index.ts` | Add embedding extraction in segment callback; provider registry |
| `edge/worker/src/reconcile.ts` | Add globalClusters data source; updated resolution priority |
| `edge/worker/src/finalize_v2.ts` | Add Tier 1 global clustering step; Tier 2 background trigger |
| `edge/worker/src/types_v2.ts` | Add EmbeddingCache, GlobalClusterMap, ProviderConfig types |
| `inference/app/config.py` | Add Whisper/pyannote model configuration |
| `inference/requirements.txt` | Add pyannote.audio, faster-whisper, whisperx dependencies |
| `desktop/src/hooks/useDraftFeedback.ts` | Handle Tier 2 report replacement notification |
| `desktop/src/views/FeedbackView.tsx` | Show "refining" status; smooth Tier 2 update |

### Unchanged Files

| File | Reason |
|------|--------|
| `desktop/src/services/AudioService.ts` | Audio capture unchanged |
| `desktop/src/services/WebSocketService.ts` | WebSocket protocol unchanged |
| `edge/worker/src/auth.ts` | Auth unchanged |
| `edge/worker/src/audio-utils.ts` | PCM utilities unchanged |

---

## 9. Performance Targets

| Metric | Current | Tier 1 Target | Tier 2 Target |
|--------|---------|---------------|---------------|
| Unknown speaker ratio | 0% (name extraction) | 0% (embedding clustering) | 0% |
| Speaker ID accuracy | ~85% (name-dependent) | >90% (embedding-based) | >98% |
| Finalization time | ~30s | <30s | +2-3min (background) |
| ASR word error rate | ~15% (FunASR) | ~15% (same streaming) | <5% (Whisper large-v3) |
| Transcript artifacts | Filtered post-hoc | Filtered post-hoc | None (clean Whisper) |

---

## 10. Migration Path

### Phase 1 → Existing system still works
- All new code is additive (new files, not replacing existing)
- Provider interfaces wrap existing implementations
- Global clustering is a NEW step added to finalization (doesn't replace name extraction)
- If clustering fails, falls back to existing name extraction pipeline

### Backward Compatibility
- `diarization_backend: 'edge'` continues to work as-is
- New config `diarization_backend: 'edge+clustering'` enables embedding cache + global clustering
- Tier 2 is opt-in via `tier2.enabled: true`

---

## 11. Testing Strategy

### Unit Tests
- `global-cluster.test.ts` — clustering algorithm correctness with synthetic embeddings
- `embedding-cache.test.ts` — cache operations, memory limits
- `reconcile.test.ts` — new resolution priority with global clusters
- `diarize_full.test.py` — pyannote pipeline wrapper
- `whisper_batch.test.py` — Whisper transcription wrapper

### Integration Tests
- Existing E2E test (`e2e_group_interview_test.mjs`) with `diarization_backend: 'edge+clustering'`
- Quality gate: unknown_ratio < 5%, speaker_accuracy > 90%
- Tier 2 completion test: verify silent replacement works

### Accuracy Benchmarks
- Use existing 4-speaker group interview audio (499s PCM)
- Compare speaker assignment against ground truth (manual labels)
- Track: precision, recall, F1 per speaker
- Run before/after to quantify improvement

---

## 12. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Embedding extraction adds latency during recording | Medium | Async extraction; doesn't block audio pipeline |
| Global clustering in Worker JS is slow | Low | Matrix is small (60×60); can offload to inference if needed |
| pyannote.audio GPU requirements for Tier 2 | Medium | CPU fallback works (slower); Apple MPS supported |
| Whisper large-v3 download size (~3GB) | Low | One-time download; cached locally |
| ROCm compatibility for 7900 XTX | Medium | Fallback to whisper.cpp Vulkan backend |
| Tier 2 fails silently | Low | Desktop polls for completion; timeout + retry UI |
