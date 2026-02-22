# Provider Architecture

This document describes the pluggable provider system that abstracts the AI pipeline into swappable components.

## Overview

The system uses four provider types:

| Provider Type | Interface | Purpose |
|---|---|---|
| **ASR** | `ASRProvider` | Speech-to-text (streaming and/or batch) |
| **Diarization** | `DiarizationProvider` | Speaker segmentation (per-window or full-file) |
| **Speaker Verification** | `SpeakerVerificationProvider` | Embedding extraction + similarity scoring |
| **LLM** | `LLMProvider` | Report synthesis + claim regeneration |

All interfaces are defined in `edge/worker/src/providers/types.ts`.

Providers are managed by the `ProviderRegistry` class, which lazily holds one instance of each type. Session-level configuration (`ProviderConfig`) determines which provider is active.

---

## ASR Providers

### FunASR (Default Streaming)

- **File:** `edge/worker/src/providers/asr-funASR.ts`
- **Mode:** `streaming`
- **Engine:** Aliyun DashScope FunASR
- **Cost:** Pay-per-use (Aliyun pricing)
- **Languages:** Chinese, English, auto-detect
- **Config key:** `asr.streaming: "funASR"`

The existing FunASR provider connects via WebSocket to Aliyun's real-time ASR service. It produces utterances as they are recognized during recording.

**Setup:** Requires `ALIYUN_DASHSCOPE_API_KEY` wrangler secret.

### Groq Whisper

- **File:** `edge/worker/src/providers/asr-groq.ts`
- **Mode:** `both` (streaming placeholder + batch)
- **Engine:** Groq API (Whisper models)
- **Cost:** Free tier (28,800 audio-seconds/day)
- **Languages:** All Whisper-supported languages
- **Config key:** `asr.streaming: "groq"` or `asr.batch: "groq"`

Uses Groq's fast Whisper inference API. The free tier is generous for low-volume use cases. Batch transcription returns segment-level and word-level timestamps via `verbose_json` response format.

**Setup:**
1. Get API key from [console.groq.com](https://console.groq.com)
2. Set wrangler secret: `npx wrangler secret put GROQ_API_KEY`

**Models:**
| Model | Speed | Quality | Notes |
|---|---|---|---|
| `whisper-large-v3` | Fast | Best | Recommended for accuracy |
| `whisper-large-v3-turbo` | Fastest | Good | Default; best speed/quality ratio |
| `distil-whisper-large-v3-en` | Fastest | Good | English only |

**Example config:**
```typescript
asr: {
  streaming: "groq",
  batch: "groq",
  model: "whisper-large-v3-turbo",
  language: "auto"
}
```

### OpenAI Whisper

- **File:** `edge/worker/src/providers/asr-openai.ts`
- **Mode:** `batch`
- **Engine:** OpenAI Audio Transcription API
- **Cost:** $0.006/minute
- **Languages:** All Whisper-supported languages
- **Config key:** `asr.batch: "openai"`

Uses OpenAI's hosted Whisper API for batch transcription. Returns segment and word-level timestamps. Batch-only (no streaming support).

**Setup:**
1. Get API key from [platform.openai.com](https://platform.openai.com)
2. Set wrangler secret: `npx wrangler secret put OPENAI_API_KEY`

**Models:**
| Model | Cost | Notes |
|---|---|---|
| `whisper-1` | $0.006/min | Default; original Whisper |
| `gpt-4o-transcribe` | Varies | GPT-4o backed transcription |
| `gpt-4o-mini-transcribe` | Varies | Smaller, cheaper |

### Local Whisper (Batch Processor)

- **File:** `inference/app/services/whisper_batch.py`
- **Mode:** `batch`
- **Engine:** faster-whisper / whisper.cpp / MLX-Whisper (auto-detected)
- **Cost:** Free (runs on local hardware)
- **Config key:** `asr.batch: "local-whisper"`

Auto-detects available hardware and selects the best Whisper backend:

| Hardware | Backend | Speed |
|---|---|---|
| NVIDIA GPU (CUDA) | faster-whisper (CTranslate2) | ~10x realtime |
| AMD GPU (ROCm/Vulkan) | whisper.cpp | ~5x realtime |
| Apple Silicon (MPS) | MLX-Whisper or whisper.cpp | ~8x realtime |
| CPU only | whisper.cpp | ~1x realtime |

**Setup:** Install dependencies in the inference service environment. Models are downloaded on first use (~3GB for large-v3).

---

## Diarization Providers

### pyannote-rs Sidecar (Default Streaming)

- **Mode:** `streaming` (per-window)
- **Engine:** pyannote-rs sidecar process
- **Global clustering:** No (local IDs per 10s window)
- **Config key:** `diarization.streaming: "pyannote-rs"`

Existing provider that runs pyannote-rs as a sidecar for per-window speaker segmentation. Produces local speaker IDs (`SPEAKER_00`, `SPEAKER_01`) that are NOT globally consistent across windows. Global consistency is achieved post-hoc via the embedding cache + global clustering step.

### pyannote Full Pipeline (Batch)

- **Mode:** `batch`
- **Engine:** pyannote.audio Python library
- **Global clustering:** Yes
- **Config key:** `diarization.batch: "pyannote-full"`

Full pyannote.audio pipeline for Tier 2 batch processing. Runs segmentation, embedding extraction, and global clustering in one pass. Requires HuggingFace token for model access.

**Setup:**
1. Accept pyannote model license on HuggingFace
2. Set `HF_TOKEN` environment variable in inference service

---

## Speaker Verification Providers

### CAM++ (Default)

- **Engine:** ModelScope CAM++ model
- **Embedding dim:** 512
- **Config key:** `speaker_verification: "cam-pp-inference"`

Existing provider that calls the inference service for speaker embedding extraction and similarity scoring. Used for enrollment matching and embedding cache population.

---

## LLM Providers

### DashScope (Default)

- **Engine:** Aliyun DashScope (qwen-plus)
- **Cost:** Pay-per-use (Aliyun pricing)
- **Languages:** Chinese + English
- **Config key:** `llm: "dashscope"`

Existing LLM provider using Aliyun's DashScope API. Default for the primary persona (Chinese interview feedback).

### OpenAI

- **File:** `edge/worker/src/providers/llm-openai.ts`
- **Engine:** OpenAI Chat Completions API
- **Cost:** Varies by model
- **Languages:** All
- **Config key:** `llm: "openai"`

Uses OpenAI's chat API with structured JSON output (`response_format: json_object`). Supports GPT-4o, GPT-4o-mini, and other chat models. Also supports Azure OpenAI and proxy endpoints via `baseUrl` config.

**Setup:**
1. Get API key from [platform.openai.com](https://platform.openai.com)
2. Set wrangler secret: `npx wrangler secret put OPENAI_API_KEY`

**Models:**
| Model | Cost (input/output per 1M tokens) | Quality | Speed |
|---|---|---|---|
| `gpt-4o` | $2.50/$10.00 | Best | Fast |
| `gpt-4o-mini` | $0.15/$0.60 | Good | Fastest |
| `gpt-4-turbo` | $10.00/$30.00 | Great | Medium |

**Features:**
- JSON mode for structured output
- Claim regeneration support
- Custom base URL for Azure OpenAI or proxy servers

### Ollama

- **File:** `edge/worker/src/providers/llm-ollama.ts`
- **Engine:** Ollama local inference
- **Cost:** Free (runs on local hardware)
- **Languages:** Depends on model
- **Config key:** `llm: "ollama"`

Connects to a local Ollama instance for fully offline LLM inference. Works with any Ollama-compatible model. Ideal for privacy-sensitive deployments or when cloud API access is unavailable.

**Setup:**
1. Install Ollama: `curl -fsSL https://ollama.com/install.sh | sh`
2. Pull a model: `ollama pull llama3` or `ollama pull qwen2.5:14b`
3. Ollama server starts automatically on port 11434

**Recommended models:**
| Model | VRAM | Quality | Speed | Notes |
|---|---|---|---|---|
| `llama3` (8B) | ~5GB | Good | Fast | Default; good balance |
| `qwen2.5:14b` | ~10GB | Great | Medium | Best for Chinese+English |
| `mistral` (7B) | ~5GB | Good | Fast | Strong reasoning |
| `qwen2.5:72b` | ~48GB | Excellent | Slow | Best quality, needs high-end GPU |

**Features:**
- JSON format mode for structured output
- Claim regeneration support
- Configurable timeout (default 120s for large models)
- No authentication required (local server)

---

## Configuration

### Session-Level Config

```typescript
interface ProviderConfig {
  asr: {
    streaming: "funASR" | "groq" | "openai" | "local-whisper" | "streaming-whisper";
    batch: "local-whisper" | "groq" | "openai" | "funASR";
    model?: string;
    language?: string;
  };
  diarization: {
    streaming: "pyannote-rs" | "diart" | "none";
    batch: "pyannote-full" | "none";
    max_speakers?: number;
  };
  speaker_verification: "cam-pp-inference" | "cam-pp-local" | "wespeaker-local";
  llm: "dashscope" | "openai" | "ollama";
  tier2: {
    enabled: boolean;
    auto_trigger: boolean;
    processor: "local" | "remote";
    endpoint?: string;
  };
}
```

### Preset Configurations

**Mock Interview Trainer** (local GPU, fast feedback):
```typescript
{
  asr: { streaming: "funASR", batch: "local-whisper", model: "large-v3", language: "auto" },
  diarization: { streaming: "pyannote-rs", batch: "pyannote-full", max_speakers: 6 },
  speaker_verification: "cam-pp-inference",
  llm: "dashscope",
  tier2: { enabled: true, auto_trigger: true, processor: "local" }
}
```

**University Interviewer** (cloud APIs, no local GPU):
```typescript
{
  asr: { streaming: "groq", batch: "groq", model: "whisper-large-v3-turbo" },
  diarization: { streaming: "none", batch: "pyannote-full" },
  speaker_verification: "cam-pp-inference",
  llm: "openai",
  tier2: { enabled: true, auto_trigger: true, processor: "remote", endpoint: "https://..." }
}
```

**Fully Offline** (all local processing):
```typescript
{
  asr: { streaming: "funASR", batch: "local-whisper", model: "large-v3" },
  diarization: { streaming: "pyannote-rs", batch: "pyannote-full" },
  speaker_verification: "cam-pp-inference",
  llm: "ollama",
  tier2: { enabled: true, auto_trigger: true, processor: "local" }
}
```

---

## Cost Comparison

| Setup | ASR Cost | LLM Cost | Monthly (10 sessions x 30min) |
|---|---|---|---|
| FunASR + DashScope | ~$0.50 | ~$0.30 | ~$8 |
| Groq + OpenAI GPT-4o-mini | Free | ~$0.10 | ~$1 |
| Local Whisper + Ollama | Free | Free | $0 (electricity only) |
| OpenAI Whisper + GPT-4o | ~$1.80 | ~$1.50 | ~$33 |

---

## Batch Processing API

The inference service exposes three HTTP endpoints for Tier 2 batch processing at `/batch/*`. These are called by the edge worker during background refinement. All endpoints require the same `x-api-key` header as other inference endpoints.

**Source:** `inference/app/routes/batch.py`

### POST /batch/transcribe

Batch transcribe an audio file using local Whisper. `audio_url` accepts HTTP(S) URLs (downloaded to a temp file, max 500MB) or local file paths.

**Request:**
```json
{
  "audio_url": "https://r2.example.com/session/audio.wav",
  "language": "auto",
  "model": "large-v3"
}
```

**Response:**
```json
{
  "utterances": [
    {
      "id": "u_0000",
      "text": "Hello everyone, let's begin.",
      "start_ms": 0,
      "end_ms": 3200,
      "words": [
        { "word": "Hello", "start_ms": 0, "end_ms": 400, "confidence": 0.97 },
        { "word": "everyone", "start_ms": 420, "end_ms": 1100, "confidence": 0.95 }
      ],
      "language": "en",
      "confidence": 0.92
    }
  ],
  "language": "en",
  "duration_ms": 600000,
  "processing_time_ms": 45000,
  "backend": "faster-whisper",
  "model": "large-v3"
}
```

### POST /batch/diarize

Full-pipeline speaker diarization using pyannote.audio. Returns globally consistent speaker segments and per-speaker embedding centroids.

**Request:**
```json
{
  "audio_url": "/data/sessions/abc123/audio.wav",
  "num_speakers": 4,
  "min_speakers": null,
  "max_speakers": null
}
```

**Response:**
```json
{
  "segments": [
    { "id": "seg_0000", "speaker_id": "SPEAKER_00", "start_ms": 0, "end_ms": 5200, "confidence": 1.0 }
  ],
  "embeddings": {
    "SPEAKER_00": [0.12, -0.34, "...512 floats"],
    "SPEAKER_01": [0.45, 0.67, "...512 floats"]
  },
  "num_speakers": 4,
  "duration_ms": 600000,
  "processing_time_ms": 120000,
  "global_clustering_done": true
}
```

### POST /batch/process

Combined endpoint: transcribe + diarize + merge. Runs Whisper and pyannote **in parallel** (`asyncio.gather`), then aligns utterances to speaker segments by maximum time overlap.

**Request:**
```json
{
  "audio_url": "https://r2.example.com/session/audio.wav",
  "num_speakers": 4,
  "language": "auto",
  "model": "large-v3"
}
```

**Response:**
```json
{
  "transcript": [
    {
      "id": "u_0000",
      "speaker": "SPEAKER_00",
      "text": "Hello everyone, let's begin.",
      "start_ms": 0,
      "end_ms": 3200,
      "words": [],
      "language": "en",
      "confidence": 0.92
    }
  ],
  "speaker_stats": [
    { "speaker_id": "SPEAKER_00", "total_duration_ms": 180000, "segment_count": 42, "talk_ratio": 0.30 }
  ],
  "language": "en",
  "duration_ms": 600000,
  "transcription_time_ms": 45000,
  "diarization_time_ms": 120000,
  "total_processing_time_ms": 165000
}
```

---

## Deployment Guides

### Apple Silicon (Mac M1/M2/M3/M4)

Best for local Tier 2 processing on MacBook Pro or Mac Studio.

```bash
cd inference
pip install -r requirements.txt

export HF_TOKEN=hf_xxxxx
export WHISPER_DEVICE=auto    # Detects MPS
export PYANNOTE_DEVICE=auto   # Partial MPS support, some ops fall back to CPU
```

**Expected Tier 2 performance (10-min audio, M1 Pro):**
- Whisper large-v3: ~60-90s (openai-whisper backend on MPS)
- pyannote diarization: ~30-60s
- Total: ~2-3 minutes

For local LLM: `brew install ollama && ollama pull qwen2.5:14b`

### Windows AMD GPU (7900 XTX / ROCm)

```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm6.0
pip install faster-whisper pyannote.audio

export HF_TOKEN=hf_xxxxx
export WHISPER_DEVICE=auto    # Detects ROCm via torch.cuda
export PYANNOTE_DEVICE=auto
```

**Expected Tier 2 performance (10-min audio, 7900 XTX):**
- Whisper large-v3: ~20-40s
- pyannote diarization: ~15-30s
- Total: ~1-2 minutes

### NVIDIA GPU (Cloud or Local)

The fastest path. `faster-whisper` uses CTranslate2 with float16 quantization.

```bash
pip install faster-whisper pyannote.audio
export HF_TOKEN=hf_xxxxx
```

**Expected Tier 2 performance (10-min audio, RTX 4090):**
- Whisper large-v3: ~10-15s (faster-whisper, float16)
- pyannote diarization: ~10-20s
- Total: ~30-60s

### CPU Only

For CI/CD, testing, or lightweight deployments. Consider using Groq API (free tier) instead of local CPU Whisper.

```bash
pip install faster-whisper pyannote.audio
export WHISPER_DEVICE=cpu
export WHISPER_MODEL_SIZE=base    # Smaller model for CPU
export PYANNOTE_DEVICE=cpu
```

### Docker

```bash
cd inference
docker build -t chorus-inference .

# With GPU
docker run -p 8000:8000 --gpus all \
  -e INFERENCE_API_KEY=your-key \
  -e HF_TOKEN=hf_xxxxx \
  -e DASHSCOPE_API_KEY=sk-xxxxx \
  chorus-inference

# CPU only
docker run -p 8000:8000 \
  -e INFERENCE_API_KEY=your-key \
  -e HF_TOKEN=hf_xxxxx \
  -e WHISPER_DEVICE=cpu \
  -e WHISPER_MODEL_SIZE=base \
  chorus-inference
```

### Inference Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_MODEL_SIZE` | `large-v3` | Whisper model size (tiny/base/small/medium/large-v3) |
| `WHISPER_DEVICE` | `auto` | Device: auto, cuda, mps, cpu |
| `PYANNOTE_MODEL_ID` | `pyannote/speaker-diarization-3.1` | pyannote pipeline model |
| `PYANNOTE_EMBEDDING_MODEL_ID` | `pyannote/wespeaker-voxceleb-resnet34-LM` | Embedding model |
| `PYANNOTE_DEVICE` | `auto` | Device: auto, cuda, mps, cpu |
| `HF_TOKEN` | (empty) | HuggingFace token (required for pyannote) |
| `WHISPER_CPP_BIN` | `whisper-cpp` | Path to whisper.cpp binary (fallback) |
| `WHISPER_CPP_MODEL` | `~/.cache/whisper-cpp/ggml-large-v3.bin` | whisper.cpp model path |

---

## Adding a New Provider

1. Create a new file in `edge/worker/src/providers/` implementing the relevant interface
2. Add the provider key to the `ProviderConfig` type in `types.ts`
3. Write tests in `edge/worker/tests/`
4. Register the provider in the `ProviderRegistry` during session initialization
5. Update this documentation
