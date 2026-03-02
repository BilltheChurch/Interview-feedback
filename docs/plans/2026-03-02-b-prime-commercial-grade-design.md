# B-Prime: 增量管道商业级交付设计

> 方案 B-Prime = 方案 B (HTTP-Stable) + 强制模型换血 + Redis 真源 merge-only finalize
>
> 日期: 2026-03-02
> 状态: 待审批
> 前置: 0302 增量管道 v2 设计 + 质量门禁实施完成

---

## 1. 概述

将增量管道从"能跑"推进到"商用级"。三层交付，每层 100% 闭环后才进入下一层。

| Tier | 目标 | 天数 | 门槛 |
|------|------|------|------|
| Tier 0 | 崩溃修复 + 隔离 | 2d | WS 不崩、body 不拒、finalize 从 Redis 读 |
| Tier 1 | 模型换血 + 组件接入 | 5-6d | Parakeet 主力、CAM++ 在线、LLM Adapter 全量 |
| Tier 2 | 1x 实时 E2E 验收 | 2d | p95 < 60s、成功率 > 99%、质量门禁全过 |

---

## 2. Tier 0: 崩溃修复（2 天，100% 闭环）

### 2.1 硬隔离 WS 路由

**问题**: `ws_incremental.py:166` 调用 `process_increment_v2()` 该方法不存在，WS 连接即崩。

**方案**: Feature flag 硬隔离 + 显式 close。

**文件**: `inference/app/routes/ws_incremental.py`

```python
def register_ws_routes(app, runtime):
    """Register WS routes — gated by INCREMENTAL_V1_ENABLED."""
    settings = runtime.settings
    if not settings.incremental_v1_enabled:
        logger.info("WS incremental routes disabled (INCREMENTAL_V1_ENABLED=false)")
        return

    @app.websocket("/ws/v1/increment")
    async def ws_increment(websocket):
        # 二次防护: 即使路由注册了，也在连接时检查
        if not runtime.settings.incremental_v1_enabled:
            await websocket.close(code=4001, reason="WS incremental disabled")
            return
        # ... existing handler ...
```

**验收**: 启动服务后 `wscat -c ws://localhost:8001/ws/v1/increment` 不崩溃，返回 4001。

### 2.2 Body 限制修复：窗口硬上限 + 超窗切片

**问题**:
- 180s PCM16@16kHz = 5.49MB raw → 7.3MB base64
- 累积模式第 2 个 increment (0..360s) = 10.98MB → 14.6MB base64
- `MAX_REQUEST_BODY_BYTES = 6MB` → 拒绝请求

**方案（三层防护）**:

#### 2.2a: Inference 侧提高上限到 15MB

**文件**: `inference/app/config.py`

```python
max_request_body_bytes: int = Field(default=15 * 1024 * 1024, alias="MAX_REQUEST_BODY_BYTES")
```

**文件**: `inference/app/main.py` — middleware body limit 同步。

#### 2.2b: Inference 侧 process-chunk 加窗口硬上限校验

**文件**: `inference/app/routes/incremental_v1.py` — process_chunk_v1 开头

```python
# 窗口硬上限: 单次 increment 不超过 360s (累积模式最大)
MAX_WINDOW_MS = 360_000
window_ms = req.audio_end_ms - req.audio_start_ms
if window_ms > MAX_WINDOW_MS:
    return JSONResponse(
        status_code=413,
        content={
            "error": f"Window {window_ms}ms exceeds max {MAX_WINDOW_MS}ms. Use sliced sending.",
            "v": SCHEMA_VERSION,
        },
    )
```

#### 2.2c: Worker 侧超窗切片发送

**文件**: `edge/worker/src/index.ts` — runIncrementalProcessing()

当 window > 180s（累积模式）时，Worker 切片为多次 process-chunk 调用：

```typescript
const MAX_SLICE_MS = 180_000;  // 180s per slice

async function sendIncrementSliced(
  sessionId: string,
  startMs: number,
  endMs: number,
  incrementIndex: number,
  // ...
): Promise<ProcessChunkResponseV1> {
  const windowMs = endMs - startMs;

  if (windowMs <= MAX_SLICE_MS) {
    // 单次发送
    return sendProcessChunk(sessionId, startMs, endMs, incrementIndex, ...);
  }

  // 切片发送: [startMs, startMs+180s), [startMs+180s, startMs+360s), ...
  let lastResponse: ProcessChunkResponseV1 | null = null;
  for (let sliceStart = startMs; sliceStart < endMs; sliceStart += MAX_SLICE_MS) {
    const sliceEnd = Math.min(sliceStart + MAX_SLICE_MS, endMs);
    const sliceId = `${incrementIndex}_slice_${Math.floor(sliceStart / 1000)}`;
    lastResponse = await sendProcessChunk(
      sessionId, sliceStart, sliceEnd, incrementIndex, sliceId, ...
    );
  }
  return lastResponse!;
}
```

**验收**: 累积模式 360s 窗口不被 413 拒绝，切片后每片 ≤ 180s ≤ 7.3MB base64 < 15MB。

### 2.3 Finalize 重写为 Redis 真源 Merge-Only

**问题**: `incremental_v1.py:226-228` 调用 `processor.finalize()` 读取**内存中** session state，而 Redis 才是真源。如果服务重启，内存丢失但 Redis 保留。

**方案**: finalize 路由直接从 Redis 读取并合并，不走 `processor.finalize()`。

**文件**: `inference/app/routes/incremental_v1.py` — `finalize_v1()` 重写

```python
@v1_router.post("/finalize")
async def finalize_v1(req: FinalizeRequestV1, request: Request):
    """V1 finalize — Redis-true-source merge-only.

    不调用 processor.finalize()。所有数据从 Redis 读取并合并。
    Redis 中已有所有 increment 的 utterances, checkpoints, profiles。
    """
    runtime = request.app.state.runtime
    settings = runtime.settings

    if not settings.incremental_v1_enabled:
        return _v1_disabled_response()

    redis_state = runtime.redis_state
    if redis_state is None:
        return _redis_unavailable_response()

    t0 = time.monotonic()

    # 1. Read ALL pre-computed state from Redis (真源)
    meta = redis_state.get_meta(req.session_id)
    all_utterances = redis_state.get_all_utterances(req.session_id)
    all_checkpoints = redis_state.get_all_checkpoints(req.session_id)
    all_profiles = redis_state.get_all_speaker_profiles(req.session_id)

    if not all_utterances:
        return JSONResponse(
            status_code=404,
            content={"error": "No increments found in Redis for this session", "v": SCHEMA_VERSION},
        )

    # 2. Merge speaker profiles (cosine dedup)
    merged_profiles = _merge_redis_profiles(all_profiles, settings)

    # 3. Remap utterances to merged speaker IDs
    remapped_utterances = _remap_utterances(all_utterances, merged_profiles)

    # 4. Merge checkpoints for final report context
    merged_checkpoint_text = _merge_checkpoints(all_checkpoints)

    # 5. Build transcript + speaker stats
    transcript = _build_transcript(remapped_utterances)
    speaker_stats = _compute_stats(remapped_utterances, req.total_audio_ms)

    # 6. Generate final report (via LLM adapter if available)
    report = await _generate_report(
        runtime, transcript, speaker_stats,
        merged_checkpoint_text, req.memos, req.stats,
        req.evidence, req.name_aliases, req.locale,
    )

    finalize_ms = int((time.monotonic() - t0) * 1000)

    # 7. Cleanup Redis
    try:
        redis_state.cleanup_session(req.session_id)
    except Exception as exc:
        logger.warning("V1 finalize: Redis cleanup failed: %s", exc)

    return FinalizeResponseV1(
        session_id=req.session_id,
        transcript=transcript,
        speaker_stats=speaker_stats,
        report=report,
        total_increments=int(meta.get("last_increment", "0")) + 1,
        total_audio_ms=req.total_audio_ms,
        finalize_time_ms=finalize_ms,
        metrics={
            "redis_utterances": len(all_utterances),
            "redis_checkpoints": len(all_checkpoints),
            "redis_profiles": len(all_profiles),
            "merged_speaker_count": len(merged_profiles),
            "finalize_ms": finalize_ms,
        },
    )
```

**辅助函数（同文件内新增）**:

- `_merge_redis_profiles(all_profiles, settings)` — 将 Redis 中所有 speaker profiles 按 cosine 相似度合并（阈值 `incremental_finalize_merge_threshold=0.55`）
- `_remap_utterances(utterances, merged_profiles)` — 将所有 utterances 的 speaker_id 重映射到合并后的 ID
- `_merge_checkpoints(checkpoints)` — 合并所有 checkpoint 的 summary 文本
- `_build_transcript(utterances)` — 按时间排序、去重、格式化
- `_compute_stats(utterances, total_ms)` — 计算每个 speaker 的 talk_time, turns 等
- `_generate_report(...)` — 调用 LLM（通过 Adapter）生成最终报告

**关键原则**:
1. **零内存依赖** — 不访问 `processor._sessions`，只读 Redis
2. **幂等** — 重复调用 finalize（cleanup 前）返回相同结果
3. **Worker 负责尾部音频** — 在调用 finalize 前，Worker 必须先发送尾部 process-chunk

**验收**:
- 服务重启后调用 finalize 仍然成功（Redis 保留数据）
- 不再有 `processor.finalize()` 调用
- `r2_audio_refs` 字段保留在 schema 但 Tier 0 不消费（Tier 1+ 再评估）

### 2.4 Worker 尾部音频闭环

**文件**: `edge/worker/src/index.ts` — `runIncrementalFinalize()`

```typescript
async function runIncrementalFinalize(): Promise<boolean> {
  // 1. Check for unprocessed tail audio
  const tailStartMs = incrementalStatus.last_processed_ms;
  const tailEndMs = totalAudioMs;
  const tailDurationMs = tailEndMs - tailStartMs;

  if (tailDurationMs > 5000) {  // > 5s 未处理尾部
    // 先发一次 process-chunk 处理尾部
    const tailIndex = incrementalStatus.increments_completed;
    await sendProcessChunk(
      sessionId, tailStartMs, tailEndMs, tailIndex,
      crypto.randomUUID(), false /* no analysis for tail */,
    );
  }

  // 2. Now finalize — Redis has ALL data including tail
  const payload = buildFinalizePayloadV1({ ... });
  const resp = await fetch(`${INFERENCE_BASE}/v1/incremental/finalize`, { ... });
  // ...
}
```

**验收**: 尾部 50s 音频通过 process-chunk 持久化到 Redis，finalize 读到完整数据。

---

## 3. Tier 1: 模型换血 + 组件接入（5-6 天，必交付）

### 3.1 Parakeet TDT — 生产英文 ASR 主力

**模型**: `nvidia/parakeet-tdt-0.6b-v2` (600M 参数, WER 6.05%)
**依赖**: NeMo Toolkit + CUDA GPU
**macOS 不可用**: 自动降级到 SenseVoice ONNX

#### 3.1a 新建 ASR 后端

**文件**: `inference/app/services/backends/asr_parakeet.py` (新建)

```python
"""Parakeet TDT ASR backend — NVIDIA NeMo, CUDA-only.

Production English primary. Falls back to SenseVoice ONNX on non-CUDA.
"""
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

class ParakeetTDTTranscriber:
    """NVIDIA Parakeet TDT 0.6B v2 — English real-time ASR.

    Requirements:
    - nemo_toolkit[asr] >= 2.0.0
    - CUDA GPU (will NOT work on MPS or CPU efficiently)
    """

    def __init__(self, model_name: str = "nvidia/parakeet-tdt-0.6b-v2", device: str = "cuda"):
        import nemo.collections.asr as nemo_asr
        self.model = nemo_asr.models.ASRModel.from_pretrained(model_name)
        self.model.to(device)
        self.model.eval()
        self._device = device
        logger.info("Parakeet TDT loaded on %s", device)

    def transcribe(self, wav_path: str, language: str = "en") -> list[dict]:
        """Transcribe WAV file, return list of utterance dicts."""
        results = self.model.transcribe([wav_path])
        # NeMo returns list of hypotheses
        text = results[0] if isinstance(results[0], str) else results[0].text
        return [{"text": text, "language": "en", "confidence": 0.95}]

    def transcribe_with_timestamps(self, wav_path: str, language: str = "en") -> list[dict]:
        """Transcribe with word-level timestamps (TDT alignment)."""
        results = self.model.transcribe([wav_path], return_hypotheses=True)
        hyp = results[0]
        segments = []
        if hasattr(hyp, 'timestep') and hyp.timestep:
            for word_info in hyp.timestep.get('word', []):
                segments.append({
                    "text": word_info.get("word", ""),
                    "start_ms": int(word_info.get("start_offset", 0) * 1000),
                    "end_ms": int(word_info.get("end_offset", 0) * 1000),
                    "confidence": word_info.get("score", 0.95),
                })
        else:
            segments.append({"text": hyp.text, "confidence": 0.95})
        return segments
```

#### 3.1b 扩展配置和 runtime

**文件**: `inference/app/config.py`

```python
asr_backend: Literal["sensevoice", "sensevoice-onnx", "whisper", "whisper-cpp", "parakeet"] = Field(
    default="sensevoice", alias="ASR_BACKEND"
)
parakeet_model_name: str = Field(
    default="nvidia/parakeet-tdt-0.6b-v2", alias="PARAKEET_MODEL_NAME"
)
parakeet_device: str = Field(default="cuda", alias="PARAKEET_DEVICE")
```

**文件**: `inference/app/runtime.py` — `build_asr_backend()`

```python
elif settings.asr_backend == "parakeet":
    try:
        from app.services.backends.asr_parakeet import ParakeetTDTTranscriber
        return ParakeetTDTTranscriber(
            model_name=settings.parakeet_model_name,
            device=settings.parakeet_device,
        )
    except (ImportError, RuntimeError) as exc:
        logger.warning("Parakeet unavailable (%s), falling back to sensevoice-onnx", exc)
        # Graceful fallback to ONNX
        return _build_sensevoice_onnx(settings)
```

#### 3.1c 依赖管理

**文件**: `inference/requirements.txt`

```
# Tier 3 Parakeet ASR (production CUDA primary — optional on macOS)
# nemo_toolkit[asr]>=2.0.0  # Uncomment on CUDA deployment
```

**部署约定**:
- 生产 (Linux + CUDA): `ASR_BACKEND=parakeet`, `pip install nemo_toolkit[asr]`
- 开发 (macOS): `ASR_BACKEND=sensevoice-onnx`（默认，无需 nemo）

### 3.2 Distil-Whisper / Faster-Whisper — Finalize 低置信复算

**用途**: finalize 阶段对低置信度 utterances 重新 ASR（仅 < 20% 音频）。

**文件**: `inference/app/services/backends/asr_recompute.py` (新建)

```python
"""Selective recomputation ASR — runs only on low-confidence segments.

Uses Faster-Whisper (large-v3) or Distil-Whisper for highest accuracy.
Only invoked during finalize, not during real-time increments.
"""
class SelectiveRecomputeASR:
    """Recompute low-confidence utterances with high-precision model."""

    def __init__(self, model_size: str = "large-v3", device: str = "auto"):
        from faster_whisper import WhisperModel
        compute_type = "float16" if device == "cuda" else "int8"
        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)

    def recompute_low_confidence(
        self,
        utterances: list[dict],
        audio_path: str,
        confidence_threshold: float = 0.7,
    ) -> list[dict]:
        """Re-transcribe utterances below confidence threshold.

        Returns updated utterances with higher-confidence transcriptions.
        Only processes segments that need it (< 20% of total audio typically).
        """
        recomputed = []
        for utt in utterances:
            if utt.get("confidence", 1.0) >= confidence_threshold:
                recomputed.append(utt)
                continue
            # Re-transcribe this segment
            segments, _ = self.model.transcribe(
                audio_path,
                language=utt.get("language", "en"),
                # Clip to utterance time range
                # (requires audio slicing — handled by caller)
            )
            new_text = " ".join(s.text for s in segments)
            utt_copy = {**utt, "text": new_text, "confidence": 0.9, "recomputed": True}
            recomputed.append(utt_copy)
        return recomputed
```

**接入点**: Tier 0 finalize 重写后的 `_generate_report()` 之前，可选执行：

```python
if runtime.recompute_asr is not None:
    remapped_utterances = runtime.recompute_asr.recompute_low_confidence(
        remapped_utterances, audio_path=None,  # Redis-only, no audio re-fetch in Tier 0
        confidence_threshold=0.7,
    )
```

> 注: Tier 0 不做 R2 fetch，所以 recompute 需要音频切片时暂时跳过。Tier 1+ 如果实现 R2 fetch 则可完全启用。

### 3.3 CAM++ SpeakerArbiter 接入增量主链路

**当前状态**: `speaker_arbiter.py` 完全实现（85 行），但未被任何代码引用。

**接入架构**:

```
IncrementalProcessor._match_speakers()
  ├─ Pass 1: Strict cosine match (threshold=0.60)
  ├─ Pass 2: Relaxed cosine match (threshold=0.40)
  └─ Pass 3 (NEW): CAM++ Arbiter (confidence < 0.50)
       ├─ Extract embedding via sv_backend
       ├─ Cosine match against global profiles
       └─ Apply correction if similarity > 0.55
```

**文件改动**:

1. **`inference/app/runtime.py`** — 构造 Arbiter 并注入

```python
# After sv_backend initialization
from app.services.speaker_arbiter import SpeakerArbiter
arbiter = SpeakerArbiter(
    sv_backend=self.sv_backend,
    confidence_threshold=0.50,
)

self.incremental_processor = IncrementalProcessor(
    asr_backend=self.asr_backend,
    diarization_backend=self.diarization_backend,
    sv_backend=self.sv_backend,
    llm=self.llm,
    settings=self.settings,
    arbiter=arbiter,  # NEW
)
```

2. **`inference/app/services/incremental_processor.py`**

```python
class IncrementalProcessor:
    def __init__(self, ..., arbiter: SpeakerArbiter | None = None):
        self._arbiter = arbiter

    def _match_speakers(self, ...):
        # ... existing two-pass matching ...

        # Pass 3: CAM++ arbitration for low-confidence mappings
        if self._arbiter is not None:
            corrections = self._arbiter.arbitrate(
                pyannote_mapping=current_mapping,
                pyannote_confidences=match_confidences,
                audio_segments=segment_audio_paths,
                global_profiles=session.speaker_profiles,
            )
            # Apply corrections
            for local_id, corrected_global in corrections.items():
                if corrected_global != current_mapping.get(local_id):
                    logger.info("CAM++ correction: %s → %s (was %s)",
                                local_id, corrected_global, current_mapping.get(local_id))
                    current_mapping[local_id] = corrected_global
```

**降级**: 无 arbiter 时跳过 Pass 3，行为与现有完全相同。测试环境不需要加载 CAM++ 模型。

### 3.4 LLM 全量走 DashScopeLLMAdapter

**当前状态**: `llm_dashscope.py` 142 行，6 个约束实现完毕，但 `runtime.py:113` 直接用 `DashScopeLLM`。

**改动**:

1. **`inference/app/runtime.py`**

```python
# Replace direct DashScopeLLM with Adapter
from app.services.backends.llm_dashscope import DashScopeLLMAdapter, LLMConfig

llm_config = LLMConfig(
    model=settings.report_model_name,
    api_key=settings.dashscope_api_key.get_secret_value(),
    timeout_ms=settings.report_timeout_ms,
    max_concurrent_checkpoint=3,
    max_concurrent_finalize=1,
)
self.llm_adapter = DashScopeLLMAdapter(
    config=llm_config,
    redis_client=self.redis,  # For idempotency cache
)
# Keep backward compat: self.llm still accessible for report_synthesizer
self.llm = self.llm_adapter
```

2. **`inference/app/services/incremental_processor.py`** — checkpoint analysis

```python
def _run_checkpoint_analysis(self, session, ...):
    # Use adapter's generate_json for forced schema + idempotency
    if hasattr(self._llm, 'generate_json'):
        result = self._llm.generate_json(
            system_prompt=checkpoint_system_prompt,
            user_prompt=checkpoint_user_prompt,
            json_schema=CHECKPOINT_SCHEMA,
            timeout_ms=30_000,
            idempotency_key=f"{session_id}:chkpt:{checkpoint_index}",
            pool="checkpoint",
        )
    else:
        # Fallback to old direct call
        result = self._llm.generate(...)
```

3. **`inference/app/services/report_synthesizer.py`** — report generation

```python
def _call_llm(self, system_prompt, user_prompt, ...):
    if hasattr(self._llm, 'generate_json'):
        return self._llm.generate_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            json_schema=REPORT_SCHEMA,
            timeout_ms=self._settings.report_timeout_ms,
            idempotency_key=f"{session_id}:report",
            pool="finalize",
        )
    else:
        return self._llm.generate(system_prompt, user_prompt)
```

**获得的 6 个约束**:
1. Pool-based concurrency — checkpoint 3 并发, finalize 1 排他
2. Forced JSON Schema — 输出校验，失败重试
3. Idempotency via Redis — 重复调用返回缓存
4. PII scrubbing — 电话/邮箱/身份证号替换
5. Metrics logging — 延迟/tokens/成功率
6. Retry logic — schema 校验失败自动重试

---

## 4. Tier 2: 1x 实时 E2E 验收（2 天）

### 4.1 E2E 测试流程

用真实录音（Qingnian Road 群面录音，~30 分钟，4-5 说话人）执行完整流程：

```
1. Worker 接收 PCM chunks → 存 R2
2. 每 180s 触发 process-chunk → Inference 处理 → 结果存 Redis
3. 累积模式（第 1 个 increment）: Worker 切片发送 ≤ 180s
4. 录音结束 → Worker 发送尾部 process-chunk → 发送 finalize
5. Finalize 从 Redis merge-only → 生成报告 → 返回
```

### 4.2 验收门槛（不可降级）

| Gate | 指标 | 阈值 | 验证方法 |
|------|------|------|----------|
| G1 | Finalize 总耗时 | p95 < 60s (30min 录音) | 计时日志 |
| G2 | Report 生成成功率 | > 99% (10 次中 ≤ 1 次失败) | 连续 E2E |
| G3 | 零发言说话人 | strengths=[], risks=[], evidence_insufficient=True | JSON 检查 |
| G4 | 未绑定身份 | 所有 claim confidence ≤ 0.5 | JSON 检查 |
| G5 | CAM++ 修正 | 低置信度映射至少 1 次修正 | 日志检查 |
| G6 | LLM Adapter | idempotency cache hit > 0 | Redis 检查 |
| G7 | Parakeet WER | < 8% on 标准英文段落 | benchmark |

### 4.3 回退测试

- `REPORT_MODEL_NAME=qwen-plus` → 报告质量不变（时延增加但可接受）
- `ASR_BACKEND=sensevoice-onnx` → macOS 开发环境正常工作
- `INCREMENTAL_V1_ENABLED=false` → 所有 V1 路由返回 404，不影响旧流程

---

## 5. 文件改动清单

### Tier 0（2 天）
| 文件 | 改动 |
|------|------|
| `inference/app/routes/ws_incremental.py` | Feature flag 硬隔离 |
| `inference/app/config.py` | body limit 15MB |
| `inference/app/main.py` | Middleware body limit 同步 |
| `inference/app/routes/incremental_v1.py` | Finalize 重写 Redis merge-only + 窗口校验 |
| `edge/worker/src/index.ts` | 超窗切片发送 + 尾部 process-chunk |

### Tier 1（5-6 天）
| 文件 | 改动 |
|------|------|
| `inference/app/services/backends/asr_parakeet.py` | 新建 — Parakeet TDT |
| `inference/app/services/backends/asr_recompute.py` | 新建 — 低置信复算 |
| `inference/app/config.py` | 新增 parakeet 配置字段 |
| `inference/app/runtime.py` | Arbiter + LLM Adapter + Parakeet 接入 |
| `inference/app/services/incremental_processor.py` | Arbiter Pass 3 + LLM adapter 调用 |
| `inference/app/services/report_synthesizer.py` | LLM adapter 调用 |
| `inference/app/services/speaker_arbiter.py` | 无改动（已实现） |
| `inference/app/services/backends/llm_dashscope.py` | 无改动（已实现） |
| `inference/requirements.txt` | nemo_toolkit optional |

### Tier 2（2 天）
| 文件 | 改动 |
|------|------|
| `inference/tests/test_finalize_v1_redis.py` | 新建 — Redis merge-only finalize 测试 |
| `inference/tests/test_parakeet_backend.py` | 新建 — Parakeet mock 测试 |
| `inference/tests/benchmark_e2e_realtime.py` | 新建 — 1x 实时 E2E |
| 现有测试文件 | 更新适配新接口 |

---

## 6. 执行顺序

```
Day 1-2: Tier 0 (串行，每个子任务闭环)
  0.1 WS 路由隔离 → 验证不崩溃
  0.2 Body 限制 + 窗口校验 + 切片发送 → 验证 360s 累积不被拒
  0.3 Finalize Redis merge-only 重写 → 验证不调用 processor.finalize()
  0.4 Worker 尾部 process-chunk → 验证尾部音频入 Redis
  全量测试: pytest + vitest + typecheck

Day 3-4: Tier 1a (可并行)
  1.3 CAM++ Arbiter 接入 → 验证低置信修正
  1.4 LLM Adapter 全量切换 → 验证 6 约束激活
  全量测试

Day 5-7: Tier 1b
  1.1 Parakeet TDT 后端 → 验证 CUDA 加载 + fallback
  1.2 Distil-Whisper 复算 → 验证低置信重算
  全量测试

Day 8-9: Tier 2
  2.1 E2E 1x 实时验证
  2.2 SLA Gate 检查
  2.3 回退测试
```

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Parakeet NeMo 版本兼容 | 中 | 阻塞 Tier 1b | SenseVoice ONNX 作为永久 fallback |
| Redis merge-only 丢数据 | 低 | 阻塞 Tier 0 | 充分单元测试 + 对比旧 processor.finalize() 结果 |
| CAM++ 模型加载慢 | 低 | 延迟增加 | Arbiter 只处理 <50% confidence，大部分 skip |
| macOS 无法测试 Parakeet | 确定 | 开发体验 | CI 用 CUDA runner，本地用 ONNX fallback |
| 超窗切片引入 Redis 一致性问题 | 低 | 数据不一致 | 每片独立 increment_id + 幂等写入 |
