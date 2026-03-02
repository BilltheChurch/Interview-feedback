# Incremental Pipeline V2 — 方案 B+ 设计文档

> **Status**: Approved
> **Date**: 2026-03-02
> **Branch**: `feature/incremental-pipeline-v2`
> **Author**: Claude Opus 4.6 + User Review
> **Preceded by**: `feature/incremental-audio-pipeline` (8e83210)

## 1. 背景与动机

### 1.1 现状评估

当前增量音频处理管道（`feature/incremental-audio-pipeline`）存在多个阻塞性工程缺陷：

**P0 — 阻塞运行：**
- Worker→Inference 字段不兼容：Worker 发 `start_ms`/`end_ms`/`speaker_profiles`，Inference 要 `audio_start_ms`/`audio_end_ms`/`previous_speaker_profiles`
- 3分钟增量音频 base64 后 ≈7.68MB，超过 Inference 默认 `MAX_REQUEST_BODY_BYTES=6MB` 限制

**P1 — 影响可靠性：**
- Finalize 只检查 HTTP 200，不校验响应内容，可能错误跳过 Tier2
- 实时 ASR 发送队列无上限，网络抖动时有内存膨胀风险
- 会话状态仅进程内存，无并发保护，不支持多实例

**P2 — 影响质量：**
- CAM++ 未接入增量管道（只在 `/speaker/resolve` 路径使用）
- 无跨服务契约测试，CI 只跑 Worker typecheck
- 缺乏真实标注数据集的 WER/DER/EER 基准

### 1.2 改造目标

- **模型可微调**：全链路可本地部署、可自训练（LLM 暂用 DashScope qwen-plus）
- **1 分钟报告**：30 分钟面试会话，final report p95 < 60s
- **高准确度**：面向 99% 英文面试/群面场景优化
- **可扩展**：支持多实例水平扩展，会话可恢复
- **可测试**：A/B 基准框架 + 跨服务契约测试 + 灰度上线

## 2. 方案选择

### 2.1 已评估方案

| 方案 | 核心思路 | 结论 |
|------|---------|------|
| A: 修补优先 | 先修 P0/P1，保持 HTTP+JSON，逐步演进 | 前期 patch 在后续重构中被覆盖，总时间最长 |
| B: Clean-Room | 重建增量管道：gRPC + Redis + 可插拔后端 | 方向正确，但 CF Worker gRPC 约束需修正 |
| **B+: 修正版** | B 的基础上修正传输协议 + 加 8 条硬约束 | **选定** |
| C: 模型优先 | 先测模型再改架构 | P0 问题导致长音频测不了 |

### 2.2 B+ 相比 B 的 5 项修正

1. **传输协议**：CF Worker 不直接 gRPC → WebSocket binary + 分帧协议
2. **LLM 暂用在线 API**：保持 DashScope qwen-plus，但固定 6 条工程约束
3. **状态单写者**：只有 Inference 写 Redis，Worker 只读/发事件
4. **Schema 版本化**：显式版本号 `v1`，防止字段漂移
5. **CAM++ 角色**：裁决层（仅低置信时介入），不是每段全量 SV

## 3. 整体架构

```
┌── Desktop (Electron) ────────────────────────────────────────────┐
│  AudioService → PCM chunks (16kHz/mono) via WebSocket            │
│  SidecarView → 增量状态展示 + 置信度徽章                           │
│  FeedbackView → 最终报告展示（目标 <60s 出现）                     │
└──────────────────────────────────────────────────────────────────┘
        │ WebSocket (PCM binary frames)
        ▼
┌── Edge Worker (CF DO + R2) ──────────────────────────────────────┐
│  实时音频接收 → R2 chunk 存储                                      │
│  增量调度器 → 每 N 秒检查是否触发增量处理                            │
│  WebSocket Client → 发送二进制 PCM 流到 Inference                  │
│  Redis Client → 读会话状态 + speaker profiles (只读)               │
│  Finalize 编排 → 发 session_id + R2 refs (不传 PCM body)          │
└──────────────────────────────────────────────────────────────────┘
        │ WebSocket binary (增量) / HTTP POST (finalize)
        ▼
┌── Inference Service (FastAPI + WS + Redis) ──────────────────────┐
│                                                                   │
│  ┌─ WebSocket Server ─────────────────────────────────────────┐  │
│  │  /ws/v1/increment — 接收 PCM 流，返回增量结果               │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌─ HTTP Endpoints ───────────────────────────────────────────┐  │
│  │  POST /v1/incremental/finalize — session_id + R2 refs      │  │
│  │  GET  /v1/session/{id}/status — 会话状态查询                │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ 可插拔后端层 ─────────────────────────────────────────────┐  │
│  │  ASRBackend (protocol)                                     │  │
│  │    ├─ ParakeetTDTBackend (NeMo/CUDA)                      │  │
│  │    ├─ FasterWhisperBackend (CTranslate2)                   │  │
│  │    ├─ SenseVoiceONNXBackend (sherpa-onnx)                 │  │
│  │    ├─ DistilWhisperBackend (终局复算)                       │  │
│  │    └─ MoonshineONNXBackend (边缘/低延迟)                   │  │
│  │                                                             │  │
│  │  DiarizationBackend (protocol)                              │  │
│  │    ├─ PyannoteFullBackend (community-1 / precision-2)      │  │
│  │    └─ NeMoSortformerBackend (流式, 未来)                    │  │
│  │                                                             │  │
│  │  SVBackend (protocol) — CAM++ 裁决层                        │  │
│  │    └─ CAMPlusONNXBackend (仅低置信时介入)                   │  │
│  │                                                             │  │
│  │  LLMBackend (protocol) — 抽象层                             │  │
│  │    └─ DashScopeLLM (qwen-plus, 在线 API)                   │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Redis 会话状态层 (唯一写者: Inference) ────────────────────┐  │
│  │  session:{id}:meta     → Hash (状态元数据)                 │  │
│  │  session:{id}:profiles → Hash (field=spk_id, val=JSON)    │  │
│  │  session:{id}:chkpts   → List (append-only checkpoints)   │  │
│  │  session:{id}:utts:{N} → List (increment N 的 utterances) │  │
│  │  session:{id}:idem     → Hash (幂等去重)                   │  │
│  │  TTL: 7200s (2h), 写入时刷新                               │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ IncrementalProcessor (核心编排) ──────────────────────────┐  │
│  │  process_increment():                                       │  │
│  │    1. 从 WS stream 接收 PCM → 校验 frame_seq/crc           │  │
│  │    2. 幂等去重 (increment_id + chunk_seq)                   │  │
│  │    3. 获取 per-session lock (串行处理)                       │  │
│  │    4. Diarize → speaker segments                            │  │
│  │    5. pyannote 初步匹配 + CAM++ 低置信裁决                   │  │
│  │    6. Per-segment ASR (可插拔后端)                           │  │
│  │    7. LLM checkpoint 分析 (条件触发)                         │  │
│  │    8. Redis 增量写入状态                                     │  │
│  │                                                             │  │
│  │  finalize():                                                │  │
│  │    1. 从 R2 拉取 segment refs (不重传 PCM)                   │  │
│  │    2. 选择性复算 (低置信片段 only, <20%)                      │  │
│  │    3. CAM++ 全局身份归并                                     │  │
│  │    4. 转录校正 + 名字提取                                    │  │
│  │    5. Checkpoint 合并 → 最终报告 (LLM)                       │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

## 4. 传输协议设计

### 4.1 增量处理：WebSocket Binary + 分帧协议

**连接**: Worker → `ws://inference:8001/ws/v1/increment`

**协议帧定义**：

```
Frame Types:
  1. StartFrame (JSON text)
     {
       "v": 1,
       "type": "start",
       "session_id": string,
       "increment_id": string,       // UUID, 用于幂等去重
       "increment_index": int,
       "audio_start_ms": int,
       "audio_end_ms": int,
       "language": string,
       "run_analysis": bool,
       "total_frames": int,          // 预期 PCM 帧总数
       "sample_rate": 16000,
       "channels": 1,
       "bit_depth": 16
     }

  2. PCMFrame (binary)
     Header (12 bytes):
       frame_seq:     uint32 (4 bytes) — 序号，从 0 开始
       payload_size:  uint32 (4 bytes) — PCM 数据字节数
       crc32:         uint32 (4 bytes) — PCM 数据的 CRC32
     Payload:
       raw PCM s16le data (≤ 64KB per frame)

  3. EndFrame (JSON text)
     {
       "type": "end",
       "total_frames_sent": int,     // 实际发送帧数
       "total_bytes_sent": int       // 实际发送字节数
     }

  4. ResultFrame (JSON text) — Inference 返回
     {
       "v": 1,
       "type": "result",
       "session_id": string,
       "increment_index": int,
       "utterances": MergedUtteranceOut[],
       "speaker_profiles": SpeakerProfileOut[],
       "checkpoint": CheckpointResponse | null,
       "metrics": {
         "diarization_ms": int,
         "transcription_ms": int,
         "total_ms": int,
         "speakers_detected": int,
         "stable_speaker_map": bool,
         "frames_received": int,
         "frames_expected": int
       }
     }

  5. ErrorFrame (JSON text) — Inference 返回
     {
       "type": "error",
       "code": string,
       "message": string
     }
```

**帧校验规则**：
- `frame_seq` 必须连续递增，缺帧即报错
- `crc32` 校验失败即报错
- `total_frames_sent` 必须等于 `total_frames`（StartFrame 声明）

### 4.2 Finalize：HTTP POST + R2 引用

```
POST /v1/incremental/finalize
Content-Type: application/json
X-Schema-Version: 1

{
  "v": 1,
  "session_id": string,
  "r2_audio_refs": [              // R2 key 列表，Inference 自行拉取
    { "key": "chunks/session-123/000.pcm", "start_ms": 0, "end_ms": 10000 },
    { "key": "chunks/session-123/001.pcm", "start_ms": 10000, "end_ms": 20000 },
    ...
  ],
  "total_audio_ms": int,
  "locale": string,
  "memos": Memo[],
  "stats": SpeakerStat[],
  "evidence": EvidenceRef[],
  "session_context": SessionContext | null,
  "name_aliases": Record<string, string[]>
}

Response:
{
  "v": 1,
  "session_id": string,
  "transcript": MergedUtteranceOut[],
  "speaker_stats": SpeakerStat[],
  "report": AnalysisReportResponse | null,
  "total_increments": int,
  "total_audio_ms": int,
  "finalize_time_ms": int,
  "metrics": {
    "segments_recomputed": int,      // 重算片段数
    "segments_total": int,           // 总片段数
    "recompute_ratio": float,        // 重算比例 (目标 <0.20)
    "llm_latency_ms": int
  }
}
```

### 4.3 Schema 版本化规则

```
所有请求/响应必须携带 schema version:
- WebSocket StartFrame:  "v": 1
- HTTP Header:           X-Schema-Version: 1
- HTTP Body:             "v": 1
- Response:              "v": 1

版本兼容策略:
- v1       = 初始稳定版
- v1 + 新增 optional 字段 = 向后兼容，不升版本
- 删除/重命名字段 = v2 (必须双版本并行至少 1 个发布周期)
```

## 5. Redis 会话状态

### 5.1 数据结构（增量写入，非覆盖）

```
# 会话元数据 (Hash)
session:{id}:meta
  status:           "recording" | "processing" | "finalizing" | "done"
  created_at:       float (monotonic)
  last_activity:    float
  increments_done:  int
  stable_map:       "0" | "1"
  total_audio_ms:   int

# 说话人资料 (Hash, field=speaker_id)
session:{id}:profiles
  spk_00: {"centroid": [...], "total_speech_ms": N, "first_seen": M, "display_name": "..."}
  spk_01: ...

# Checkpoints (List, append-only)
session:{id}:chkpts
  [0]: {"checkpoint_index": 0, "summary": "...", ...}
  [1]: {"checkpoint_index": 1, ...}

# 话语 (List per increment, append-only)
session:{id}:utts:0
  [0]: {"speaker": "spk_00", "text": "...", "start_ms": M, "end_ms": K, "confidence": 0.85}
  [1]: ...
session:{id}:utts:1
  ...

# 幂等去重 (Hash)
session:{id}:idem
  {increment_id}: "processed"   # TTL 与 session 同步

# Per-session 分布式锁
session:{id}:lock
  value: "{worker_id}:{timestamp}"
  TTL: 300s (锁超时)
```

### 5.2 单写者原则

| 操作 | Worker | Inference |
|------|--------|-----------|
| `session:*:meta` | READ | WRITE |
| `session:*:profiles` | READ | WRITE (HSET per field) |
| `session:*:chkpts` | READ (LRANGE) | WRITE (RPUSH) |
| `session:*:utts:N` | READ (LRANGE) | WRITE (RPUSH) |
| `session:*:idem` | — | WRITE (HSETNX) |
| `session:*:lock` | — | SET NX EX 300 |

### 5.3 Inference 写入原子性

```python
# 每次 increment 处理完毕后，原子写入
pipe = redis.pipeline(transaction=True)
pipe.hset(f"session:{sid}:meta", mapping={"increments_done": N, "last_activity": now})
pipe.hset(f"session:{sid}:profiles", spk_id, profile_json)
pipe.rpush(f"session:{sid}:utts:{N}", *utterance_jsons)
if checkpoint:
    pipe.rpush(f"session:{sid}:chkpts", checkpoint_json)
pipe.hsetnx(f"session:{sid}:idem", increment_id, "processed")
pipe.expire(f"session:{sid}:meta", 7200)  # 刷新 TTL
pipe.execute()
```

## 6. 可插拔后端层

### 6.1 ASR Backend Protocol

```python
class ASRBackend(Protocol):
    """可插拔 ASR 后端接口"""

    @property
    def name(self) -> str: ...

    @property
    def supports_streaming(self) -> bool: ...

    @property
    def supports_word_timestamps(self) -> bool: ...

    def transcribe(
        self,
        wav_path: str,
        language: str = "auto",
        *,
        word_timestamps: bool = False,
    ) -> TranscriptResult: ...

    def transcribe_segment(
        self,
        wav_path: str,
        start_ms: int,
        end_ms: int,
        language: str = "auto",
    ) -> TranscriptResult: ...
```

### 6.2 候选 ASR 后端

| 后端 | 模型 | 部署 | 可微调 | WER 参考 | 适用场景 |
|------|------|------|--------|---------|---------|
| ParakeetTDTBackend | nvidia/parakeet-tdt-0.6b-v2 | NeMo + CUDA | NeMo recipes | Avg 6.05 | 实时英文主力 |
| FasterWhisperBackend | openai/whisper-large-v3 | CTranslate2 | HF→CT2 转换 | ~3-5 (LS) | 终局高精复算 |
| DistilWhisperBackend | distil-large-v3-openai | CTranslate2 | HF LoRA | ~5-7 (LS) | 终局快速复算 |
| SenseVoiceONNXBackend | SenseVoice-Small | sherpa-onnx | FunASR recipes | ~6 EN | 中英混合 |
| MoonshineONNXBackend | moonshine-base | sherpa-onnx | 有限 | ~3.3 (LS) | 边缘/低延迟 |

### 6.3 A/B 基准测试框架

```python
class ASRBenchmark:
    """在真实面试数据集上对比 ASR 后端"""

    def __init__(self, backends: list[ASRBackend], dataset_path: str):
        self.backends = backends
        self.dataset = load_benchmark_dataset(dataset_path)

    def run(self) -> BenchmarkReport:
        """返回每个后端的 WER/CER/RTF/p95 延迟"""
        results = {}
        for backend in self.backends:
            results[backend.name] = self._evaluate(backend)
        return BenchmarkReport(results)

    def _evaluate(self, backend: ASRBackend) -> BackendMetrics:
        wer_scores, rtf_scores, latencies = [], [], []
        for sample in self.dataset:
            t0 = time.monotonic()
            result = backend.transcribe(sample.wav_path, language=sample.language)
            latency = time.monotonic() - t0
            wer = compute_wer(result.text, sample.reference)
            rtf = latency / sample.duration_s
            wer_scores.append(wer)
            rtf_scores.append(rtf)
            latencies.append(latency)
        return BackendMetrics(
            wer_mean=np.mean(wer_scores),
            wer_p95=np.percentile(wer_scores, 95),
            rtf_mean=np.mean(rtf_scores),
            latency_p95=np.percentile(latencies, 95),
        )
```

### 6.4 CAM++ 裁决层

CAM++ 作为裁决层，仅在 pyannote 匹配置信度低于阈值时介入：

```python
class SpeakerArbiter:
    """CAM++ 仅在冲突/低置信时介入，保护 60s SLA"""

    CONFIDENCE_THRESHOLD = 0.50

    def __init__(self, sv_backend: SVBackend):
        self.sv = sv_backend

    def arbitrate(
        self,
        pyannote_mapping: dict[str, str],        # local → global
        pyannote_confidences: dict[str, float],  # 置信度
        audio_segments: dict[str, str],          # local_id → wav_path
        global_profiles: dict[str, SpeakerProfile],
    ) -> dict[str, str]:
        corrections = {}
        for local_id, confidence in pyannote_confidences.items():
            if confidence >= self.CONFIDENCE_THRESHOLD:
                continue  # 高置信 → 跳过 CAM++
            # 低置信 → CAM++ 二次裁决
            emb = self.sv.extract_embedding(audio_segments[local_id])
            best_global, best_sim = self._cosine_match(emb, global_profiles)
            if best_sim > 0.55:
                corrections[local_id] = best_global
        return {**pyannote_mapping, **corrections}
```

## 7. LLM 6 约束

保持 DashScope qwen-plus，但固定以下工程约束以便未来迁移本地 LLM：

### 7.1 抽象层

```python
class LLMBackend(Protocol):
    """业务代码不直接依赖 DashScope SDK"""

    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        json_schema: dict | None = None,
        timeout_ms: int = 45000,
        idempotency_key: str | None = None,
        pool: str = "default",
    ) -> dict: ...
```

### 7.2 分池超时

```python
# checkpoint 分析: 并发上限 3, 超时 30s
# finalize 合并:   独占 (并发 1), 超时 60s
POOL_CONFIG = {
    "checkpoint": {"semaphore": 3, "timeout_ms": 30000},
    "finalize":   {"semaphore": 1, "timeout_ms": 60000},
}
```

### 7.3 JSON Schema 强制校验

- 每次 LLM 调用必须传入 `json_schema`
- 校验失败 → 重试 1 次 → 仍失败则 raise（不做静默降级）

### 7.4 幂等键

```python
# 格式: session_id:checkpoint_index 或 session_id:finalize
idempotency_key = f"{session_id}:checkpoint:{checkpoint_index}"
# 存储在 Redis: session:{id}:idem Hash
# 防止重复计费和重复写入
```

### 7.5 PII 脱敏 + 审计

- 出站前：正则替换电话、邮箱、身份证号等 PII
- 审计日志：记录脱敏后的 prompt hash + token count + latency

### 7.6 指标记录

```python
# 每次 LLM 调用记录:
metrics = {
    "latency_ms": int,
    "input_tokens": int,
    "output_tokens": int,
    "success": bool,
    "model": "qwen-plus",
    "pool": "checkpoint" | "finalize",
    "cost_estimate_cny": float,
}
# 用于决策：是否迁移本地 LLM
```

## 8. 1 分钟报告 SLA 时延预算

```
录制结束 → 最终报告: 目标 p95 < 60s

[0-5s]    冻结流 + 收尾落盘
           Worker 停止接收音频，最后 chunks 写入 R2
           通知 Inference: POST /v1/incremental/finalize

[5-20s]   选择性复算 (只重跑低置信片段)
           Inference 从 Redis 读所有 increment 结果
           识别低置信 utterances (confidence < threshold)
           从 R2 拉取对应音频片段
           只对这些片段重新 ASR + diarization
           预期重算比例: <20% 音频量

[20-35s]  CAM++ 身份裁决 + 全局 speaker reconciliation
           合并所有 increment 的 speaker profiles
           CAM++ 只处理冲突/低置信映射
           计算最终 speaker stats + evidence refs

[35-50s]  LLM 结构化报告合成
           输入: checkpoint 汇总 + 少量增量文本 (非全量转录)
           DashScope qwen-plus: ~15s 生成时间
           强制 JSON Schema 校验

[50-60s]  渲染 + 持久化 + 返回
           写最终报告到 Redis
           返回给 Worker
           Worker 推送给 Desktop
```

**关键**：60s 可达的前提是录制期间已预计算 checkpoint（每 2 个增量一次 LLM 分析），finalize 只做合并而非从零开始。

## 9. 8 条硬约束（用户评审补充）

| # | 约束 | 实现方式 |
|---|------|---------|
| 1 | Finalize 不传整段 PCM，用 R2 refs | `POST /v1/incremental/finalize` body 只含 `r2_audio_refs[]` |
| 2 | 增量请求幂等去重 | `increment_id` + Redis `HSETNX session:{id}:idem` |
| 3 | Per-session 串行处理 | Redis 分布式锁 `SET session:{id}:lock NX EX 300` |
| 4 | 幂等缓存在 Redis 不在进程 | `session:{id}:idem` Hash，含 LLM 幂等键 |
| 5 | WebSocket 分帧校验 | `total_frames` / `frame_seq` / `crc32` / `payload_size` |
| 6 | Redis 增量写入（非覆盖） | Hash (HSET) / List (RPUSH) / append-only |
| 7 | CI 跨服务契约测试 | Worker↔Inference schema 一致性 + finalize 完整性测试 |
| 8 | 灰度上线策略 | shadow → canary 5% → 25% → 100%，绑定回滚门槛 |

## 10. 验收门槛

| 指标 | 阈值 | 测量方式 |
|------|------|---------|
| 增量处理 p95 | < 1.5s (10s 音频窗) | A/B benchmark 框架 |
| Final report p95 | < 60s (30min 面试) | E2E benchmark |
| 英文 WER | 先定 benchmark 再定阈值 | LibriSpeech + 真实面试集 |
| DER | 先定 benchmark 再定阈值 | AMI + 真实面试集 |
| 实例重启恢复 | 会话可恢复，零数据丢失 | Redis 持久化测试 |
| 跨服务契约 | CI 全通过 | Worker↔Inference schema + finalize 完整性 |

## 11. 硬件规划

| 组件 | 开发 (Mac) | 生产 (Linux GPU) |
|------|-----------|-----------------|
| ASR | SenseVoice ONNX / Moonshine (MPS/CoreML) | Parakeet/Whisper (CUDA) |
| Diarization | pyannote community-1 (CPU) | pyannote precision-2 (CUDA) |
| SV | CAM++ ONNX (CoreML) | CAM++ ONNX (CUDA) |
| LLM | DashScope qwen-plus (API) | DashScope qwen-plus (API) |
| Redis | local redis-server | managed Redis (Upstash/ElastiCache) |

## 12. 灰度上线策略

```
Phase 0: Shadow (并行运行新旧管道，不影响用户)
  → 对比延迟、准确率、错误率
  → 回滚门槛: N/A (shadow mode)

Phase 1: Canary 5%
  → 5% 会话走新管道
  → 回滚门槛: p95 latency > 90s OR error_rate > 5% OR WER regression > 10%

Phase 2: 25%
  → 回滚门槛: p95 latency > 75s OR error_rate > 2%

Phase 3: 100%
  → 回滚门槛: p95 latency > 60s OR error_rate > 1%
  → 旧管道下线
```
