# SelectiveRecomputeASR 真实接线设计

> Status: Ready for Implementation
> Date: 2026-03-02
> Depends on: B-Prime 接线修复 (completed)

## 问题

`SelectiveRecomputeASR` 类已存在 (`inference/app/services/backends/asr_recompute.py`)，但：
1. **未接入主流程** — finalize 不调用它
2. **接口设计缺陷** — 接受单个 `audio_path`，对整个文件做 Whisper 转录，无法按 utterance 切片重算
3. **Worker 不存储 utterances** — `runIncrementalJob()` 只持久化 `speakerProfiles` + `checkpoint`，丢弃 `parsed.utterances`
4. **Worker 无法筛选低置信 utterance** — 因为没有数据

## 决策

- **音频获取**: Worker 代理下载（inference 不接触 R2）
- **筛选数据源**: Worker 本地累积 utterances（零额外请求）
- **不做**: 两阶段 finalize、inference 直连 R2

---

## 架构概览

```
Recording Phase:
  Worker DO ──→ /v1/incremental/process-chunk ──→ Inference
                                                     │
  Worker DO ◄── response (utterances + profiles) ◄───┘
       │
       ├─ ctx.storage.put(SPEAKER_PROFILES, ...)  ← 已有
       ├─ ctx.storage.put(CHECKPOINT, ...)         ← 已有
       └─ ctx.storage.put(UTTERANCES, ...)         ← 新增

Finalize Phase:
  Worker DO:
    1. 读取累积 utterances
    2. 筛选 confidence < 0.7 且 duration ∈ [500ms, 30s]
    3. 对每个低置信 utterance：从 R2 拉对应时间区间的 PCM chunks
    4. 拼接 → WAV → base64
    5. 构建 recompute_segments 字段 → 随 finalize 请求发送

  Inference:
    1. 正常 finalize 流程（Redis merge → transcript → report）
    2. 新增步骤：对 recompute_segments 调用 SelectiveRecomputeASR
    3. 用重算结果替换 transcript 中对应 utterance 的 text/confidence
    4. recompute 失败 → 降级（保持原文本，不阻塞报告）
```

---

## 组件变更清单

### 1. Worker: TS 接口补齐 + DO Storage 累积

**文件: `edge/worker/src/incremental.ts`**

`ParsedProcessChunkResponse.utterances` 补齐字段：

```typescript
utterances: Array<{
  utterance_id: string;       // 已有（对应 MergedUtteranceOut.id）
  stream_role: "mixed" | "teacher" | "students";
  speaker_name?: string | null;
  cluster_id?: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  confidence: number;         // 新增
  increment_index: number;    // 新增：用于去重键
}>;
```

`parseProcessChunkResponse()` 补齐解析：
```typescript
// 在 utterance 映射中增加 confidence 和 increment_index
const utterances = Array.isArray(json.utterances)
  ? (json.utterances as any[]).map((u, i) => ({
      ...u,
      confidence: typeof u.confidence === "number" ? u.confidence : 1.0,
      increment_index: typeof json.increment_index === "number"
        ? json.increment_index : 0,
    }))
  : [];
```

**文件: `edge/worker/src/index.ts`**

新增常量：
```typescript
const STORAGE_KEY_INCREMENTAL_UTTERANCES = "incremental_utterances";
const MAX_STORED_UTTERANCES = 2000;  // 防 DO 膨胀上限
```

`runIncrementalJob()` 新增存储（在 `speakerProfiles` 存储之后）：
```typescript
// 追加 utterances 到 DO Storage（去重键: increment_index + utterance_id）
const existing = await this.ctx.storage.get<StoredUtterance[]>(
  STORAGE_KEY_INCREMENTAL_UTTERANCES
) ?? [];

const newUtts = parsed.utterances.map(u => ({
  utterance_id: u.utterance_id,
  increment_index: decision.incrementIndex,
  text: u.text,
  start_ms: u.start_ms,
  end_ms: u.end_ms,
  confidence: u.confidence ?? 1.0,
  speaker: u.cluster_id ?? u.speaker_name ?? "unknown",
  stream_role: u.stream_role ?? "mixed",  // 硬点 1
}));

// 去重 + 截断
const dedupKey = (u: StoredUtterance) => `${u.increment_index}:${u.utterance_id}`;
const seen = new Set(existing.map(dedupKey));
const merged = [...existing];
for (const u of newUtts) {
  if (!seen.has(dedupKey(u))) {
    merged.push(u);
    seen.add(dedupKey(u));
  }
}
// 保留最新 MAX_STORED_UTTERANCES 条
const trimmed = merged.length > MAX_STORED_UTTERANCES
  ? merged.slice(-MAX_STORED_UTTERANCES)
  : merged;

await this.ctx.storage.put(STORAGE_KEY_INCREMENTAL_UTTERANCES, trimmed);
```

新增 TypeScript 类型：
```typescript
interface StoredUtterance {
  utterance_id: string;
  increment_index: number;
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  speaker: string;
  stream_role: "mixed" | "teacher" | "students";  // 硬点 1: R2 拉取必须按流区分
}
```

> **硬点 1**: `stream_role` 必须携带。R2 key 格式为 `sessions/{id}/chunks/{role}/{seq}.pcm`（mixed 无子目录，teacher/students 有子目录）。Worker 拉取时必须用 `chunkObjectKey(sessionId, utt.stream_role, seq)` 而非写死 `"mixed"`。

### 2. Worker: Finalize 音频拉取

**文件: `edge/worker/src/index.ts` — `runIncrementalFinalize()`**

在构建 `v1Payload` 之前插入 recompute 逻辑：

```typescript
// ── Recompute: 筛选低置信 utterances，拉取音频 ──
const RECOMPUTE_CONFIDENCE_THRESHOLD = 0.7;
const RECOMPUTE_MAX_SEGMENTS = 10;
const RECOMPUTE_MIN_DURATION_MS = 500;
const RECOMPUTE_MAX_DURATION_MS = 30_000;
const RECOMPUTE_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8MB 最终请求体上限（硬点 2）
const BASE64_OVERHEAD = 4 / 3;
const JSON_FIELD_OVERHEAD = 200; // 每段 JSON 字段开销

const storedUtterances = await this.ctx.storage.get<StoredUtterance[]>(
  STORAGE_KEY_INCREMENTAL_UTTERANCES
) ?? [];

const lowConfUtterances = storedUtterances
  .filter(u =>
    u.confidence < RECOMPUTE_CONFIDENCE_THRESHOLD &&
    (u.end_ms - u.start_ms) >= RECOMPUTE_MIN_DURATION_MS &&
    (u.end_ms - u.start_ms) <= RECOMPUTE_MAX_DURATION_MS
  )
  .sort((a, b) => a.confidence - b.confidence)  // 最低置信优先
  .slice(0, RECOMPUTE_MAX_SEGMENTS);

const recomputeSegments: RecomputeSegment[] = [];
let estimatedPayloadBytes = 0;  // 硬点 2: 按最终 payload 大小限流

for (const utt of lowConfUtterances) {
  if (estimatedPayloadBytes >= RECOMPUTE_MAX_PAYLOAD_BYTES) break;

  // 计算对应的 R2 chunk 序列号（每个 chunk = 1s）
  const startSeq = Math.floor(utt.start_ms / 1000);
  const endSeq = Math.ceil(utt.end_ms / 1000);

  // 从 R2 拉取对应 chunks（硬点 1: 按 stream_role 取正确的流）
  const pcmBuffers: ArrayBuffer[] = [];
  let fetchFailed = false;
  for (let seq = startSeq; seq < endSeq; seq++) {
    const key = chunkObjectKey(sessionId, utt.stream_role, seq);
    const obj = await this.env.RESULT_BUCKET.get(key);
    if (!obj) {
      fetchFailed = true;
      break;
    }
    pcmBuffers.push(await obj.arrayBuffer());
  }

  if (fetchFailed || pcmBuffers.length === 0) continue;

  // 拼接 PCM → WAV → base64
  const totalPcmBytes = pcmBuffers.reduce((s, b) => s + b.byteLength, 0);
  // 硬点 2: 按 base64 + JSON 开销估算最终 payload 大小
  const segPayload = Math.ceil(totalPcmBytes * BASE64_OVERHEAD) + JSON_FIELD_OVERHEAD;
  if (estimatedPayloadBytes + segPayload > RECOMPUTE_MAX_PAYLOAD_BYTES) continue;

  const wavBuffer = pcmToWav(pcmBuffers, 16000, 1, 16);
  const audioB64 = arrayBufferToBase64(wavBuffer);

  recomputeSegments.push({
    utterance_id: utt.utterance_id,
    increment_index: utt.increment_index,
    start_ms: utt.start_ms,
    end_ms: utt.end_ms,
    original_confidence: utt.confidence,
    stream_role: utt.stream_role,  // 硬点 1
    audio_b64: audioB64,
    audio_format: "wav",
  });

  estimatedPayloadBytes += segPayload;
}
```

新增 TypeScript 接口：
```typescript
interface RecomputeSegment {
  utterance_id: string;
  increment_index: number;
  start_ms: number;
  end_ms: number;
  original_confidence: number;
  stream_role: "mixed" | "teacher" | "students";  // 硬点 1
  audio_b64: string;
  audio_format: "wav";
}
```

### 2.5. Worker: Finalize 后清理 DO Storage（硬点 5）

**文件: `edge/worker/src/index.ts` — `runIncrementalFinalize()`**

在 finalize 成功后（`updateIncrementalStatus({ status: "succeeded" })` 之前）清理累积数据：

```typescript
// 硬点 5: finalize 后清理 utterance 缓存，防止会话残留膨胀
await this.ctx.storage.delete(STORAGE_KEY_INCREMENTAL_UTTERANCES);
```

> **硬点 5**: `incremental_utterances` 仅在 recording → finalize 期间有意义。finalize 完成后必须清理。即使 finalize 失败（catch 分支），也应清理——因为数据已不可用于重试（下次 finalize 会从 Redis 重新读取 utterances）。
>
> 双重保险：DO 的 `alarm()` 处理中如果检测到 `status === "succeeded" || status === "failed"` 且 `incremental_utterances` 仍存在，也应清理（防止 finalize 异常退出遗漏）。

### 3. Schema 变更

**文件: `inference/app/schemas_v1.py`**

新增：
```python
class RecomputeSegment(BaseModel):
    """Audio segment for low-confidence utterance recomputation."""
    utterance_id: str
    increment_index: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    original_confidence: float = Field(ge=0.0, le=1.0)
    stream_role: Literal["mixed", "teacher", "students"] = "mixed"  # 硬点 1
    audio_b64: str
    audio_format: Literal["wav", "pcm_s16le"] = "wav"

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms
```

`FinalizeRequestV1` 新增字段：
```python
class FinalizeRequestV1(BaseModel):
    # ... 已有字段 ...
    recompute_segments: list[RecomputeSegment] = Field(
        default_factory=list,
        description="Low-confidence audio segments for ASR recomputation",
    )
```

**文件: `edge/worker/src/incremental_v1.ts`**

`FinalizePayloadV1` 新增字段：
```typescript
export interface FinalizePayloadV1 {
  // ... 已有字段 ...
  recompute_segments: RecomputeSegment[];
}
```

`buildFinalizePayloadV1` 新增参数：
```typescript
recomputeSegments?: RecomputeSegment[];
// → recompute_segments: opts.recomputeSegments ?? [],
```

### 4. Inference: SelectiveRecomputeASR 接口重构

**文件: `inference/app/services/backends/asr_recompute.py`**

重写 `recompute_low_confidence()` 为 per-utterance 接口：

```python
def recompute_utterance(
    self,
    audio_path: str,
    language: str = "en",
    start_ms: int = 0,
    end_ms: int = 0,
) -> dict:
    """Re-transcribe a single audio segment with high-precision model.

    Returns: {"text": str, "confidence": float, "recomputed": True}
    """
    self._ensure_model()
    segments, info = self._model.transcribe(
        audio_path,
        language=language,
    )
    new_text = " ".join(s.text for s in segments).strip()
    return {
        "text": new_text,
        "confidence": 0.90,
        "recomputed": True,
    }
```

保留 `recompute_low_confidence()` 作为批量入口（向后兼容）。

### 5. Inference: Finalize 端点接入 recompute

**文件: `inference/app/routes/incremental_v1.py` — `finalize_v1()`**

在步骤 4 (`_build_transcript`) 和步骤 5 (`_compute_stats`) 之间插入：

```python
    # 4.5. Recompute low-confidence utterances (best-effort)
    recompute_requested = len(req.recompute_segments) if req.recompute_segments else 0
    recompute_succeeded = 0
    recompute_skipped = 0
    recompute_failed = 0
    if req.recompute_segments and runtime.recompute_asr is not None:
        # 硬点 3: 双保险对齐 — 主键 utterance_id, 兜底 (increment_index, start_ms, end_ms)
        utt_by_id = {u.get("id", ""): u for u in transcript}
        utt_by_coords = {
            (u.get("increment_index", -1), u.get("start_ms", -1), u.get("end_ms", -1)): u
            for u in transcript
        }

        for seg in req.recompute_segments:
            target = utt_by_id.get(seg.utterance_id)
            if target is None:
                # 兜底: 按坐标匹配
                target = utt_by_coords.get(
                    (seg.increment_index, seg.start_ms, seg.end_ms)
                )
            if target is None:
                recompute_skipped += 1
                continue
            try:
                wav_path = _decode_recompute_audio(seg.audio_b64, seg.audio_format)
                try:
                    result = runtime.recompute_asr.recompute_utterance(
                        wav_path,
                        language=target.get("language", "en"),
                        start_ms=seg.start_ms,
                        end_ms=seg.end_ms,
                    )
                    if result.get("text"):
                        target["text"] = result["text"]
                        target["confidence"] = result["confidence"]
                        target["recomputed"] = True
                        recompute_succeeded += 1  # 硬点 4
                    else:
                        recompute_skipped += 1
                finally:
                    Path(wav_path).unlink(missing_ok=True)
            except Exception:
                recompute_failed += 1  # 硬点 4
                logger.warning(
                    "Recompute failed for utterance %s, keeping original",
                    seg.utterance_id, exc_info=True,
                )
```

finalize response metrics 中追加 recompute 计数（**硬点 4**）：
```python
    # 在构建 FinalizeResponseV1 的 metrics dict 中追加:
    metrics={
        # ... 已有字段 ...
        "recompute_requested": recompute_requested,
        "recompute_succeeded": recompute_succeeded,
        "recompute_skipped": recompute_skipped,
        "recompute_failed": recompute_failed,
    },
```

> **硬点 4**: 这 4 个计数器是 SLA 可观测性的基础。告警条件示例：`recompute_failed / recompute_requested > 0.5` 触发降级告警。Worker 侧可以把这些 metrics 写入 DO status 或日志，供 dashboard 汇总。

`_decode_recompute_audio()` 辅助函数：
```python
def _decode_recompute_audio(audio_b64: str, audio_format: str) -> str:
    """Decode base64 audio to temp WAV file."""
    raw = base64.b64decode(audio_b64)
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.write(raw)
    tmp.close()
    return tmp.name
```

### 6. Runtime: 注册 recompute_asr

**文件: `inference/app/runtime.py`**

`AppRuntime` 新增字段：
```python
@dataclass(slots=True)
class AppRuntime:
    # ... 已有字段 ...
    recompute_asr: SelectiveRecomputeASR | None
```

`build_runtime()` 新增构建：
```python
# Recompute ASR for finalize-time low-confidence correction (lazy-loaded)
recompute_asr: SelectiveRecomputeASR | None = None
if settings.recompute_asr_enabled:
    from app.services.backends.asr_recompute import SelectiveRecomputeASR
    recompute_asr = SelectiveRecomputeASR(
        model_size=settings.recompute_asr_model_size,
        device=settings.recompute_asr_device,
    )
```

**文件: `inference/app/config.py`**

新增配置：
```python
recompute_asr_enabled: bool = Field(default=False, alias="RECOMPUTE_ASR_ENABLED")
recompute_asr_model_size: str = Field(default="large-v3", alias="RECOMPUTE_ASR_MODEL_SIZE")
recompute_asr_device: str = Field(default="auto", alias="RECOMPUTE_ASR_DEVICE")
```

---

## 限流保护

| 参数 | 值 | 说明 |
|------|------|------|
| `RECOMPUTE_CONFIDENCE_THRESHOLD` | 0.7 | 低于此阈值才重算 |
| `RECOMPUTE_MAX_SEGMENTS` | 10 | 单次 finalize 最多重算片段数 |
| `RECOMPUTE_MIN_DURATION_MS` | 500 | 太短的 utterance 不值得重算 |
| `RECOMPUTE_MAX_DURATION_MS` | 30,000 | 太长的片段风险高 |
| `RECOMPUTE_MAX_PAYLOAD_BYTES` | 8MB | **最终请求体**上限（见硬点 2）|
| `MAX_STORED_UTTERANCES` | 2000 | DO Storage 累积上限 |

超限策略：**降级跳过**（不阻塞 finalize）。

> **硬点 2**: 限流必须按**最终请求体大小**计算，不能只算 PCM 原始字节。base64 编码膨胀 ~33%，加上 JSON 字段开销，实际 payload 远大于原始 PCM。Worker 端计算方式：
>
> ```typescript
> // base64 膨胀: ceil(pcmBytes / 3) * 4，加 JSON 字段固定开销 ~200 bytes/segment
> const BASE64_OVERHEAD = 4 / 3;
> const JSON_FIELD_OVERHEAD = 200;
>
> function estimateSegmentPayloadBytes(pcmBytes: number): number {
>   return Math.ceil(pcmBytes * BASE64_OVERHEAD) + JSON_FIELD_OVERHEAD;
> }
>
> // 在循环中用 estimatedPayloadBytes 替代 totalRecomputeBytes
> let estimatedPayloadBytes = 0;
> // ...
> const segPayload = estimateSegmentPayloadBytes(totalPcmBytes);
> if (estimatedPayloadBytes + segPayload > RECOMPUTE_MAX_PAYLOAD_BYTES) continue;
> estimatedPayloadBytes += segPayload;
> ```

---

## 验收标准

| # | 标准 | 验证方式 | 硬点 |
|---|------|---------|------|
| 1 | 至少 1 条低置信 utterance 被真实改写 | 测试：mock recompute → assert text changed + confidence updated | — |
| 2 | recompute 失败不阻塞报告 | 测试：mock recompute raises → assert finalize succeeds with original text | — |
| 3 | finalize p95 不退化超 60s | 基准测试：带 recompute vs 不带 → delta < 10s | — |
| 4 | Worker 正确累积 utterances + confidence | 测试：assert DO storage contains utterances with confidence after process-chunk | — |
| 5 | Worker 按 stream_role 拉取 R2 音频 | 测试：teacher utterance → assert `chunkObjectKey(sid, "teacher", seq)` 被调用 | 硬点 1 |
| 6 | 去重键 (increment_index, utterance_id) 防重复 | 测试：同 increment 重复调用 → utterance 不翻倍 | — |
| 7 | DO Storage 不超 MAX_STORED_UTTERANCES | 测试：插入 2500 → assert trimmed to 2000 | — |
| 8 | payload 限流按 base64+JSON 估算 | 测试：6MB PCM → 估算 ~8MB payload → assert 部分 segment 被跳过 | 硬点 2 |
| 9 | utterance 对齐兜底坐标匹配 | 测试：utterance_id 缺失 → 按 (increment_index, start_ms, end_ms) 仍能命中 | 硬点 3 |
| 10 | finalize metrics 含 recompute 四计数 | 测试：assert response.metrics 含 requested/succeeded/skipped/failed | 硬点 4 |
| 11 | finalize 后 DO 清理 incremental_utterances | 测试：finalize 成功 → assert storage.delete(UTTERANCES) 被调用 | 硬点 5 |
| 12 | finalize 失败后 DO 也清理 | 测试：finalize 抛异常 → catch 分支仍清理 utterances | 硬点 5 |
| 13 | 全量测试通过 | inference + worker 全部 pass | — |

---

## 文件变更清单

| 文件 | 操作 |
|------|------|
| `edge/worker/src/incremental.ts` | 修改：utterance 类型补 confidence + increment_index |
| `edge/worker/src/incremental_v1.ts` | 修改：FinalizePayloadV1 + builder 补 recompute_segments |
| `edge/worker/src/index.ts` | 修改：DO 累积 utterances + finalize 拉取 R2 音频 |
| `edge/worker/src/types_v2.ts` | 修改：新增 StoredUtterance + RecomputeSegment 类型 |
| `inference/app/schemas_v1.py` | 修改：新增 RecomputeSegment + FinalizeRequestV1 字段 |
| `inference/app/services/backends/asr_recompute.py` | 修改：新增 recompute_utterance() 单片段接口 |
| `inference/app/routes/incremental_v1.py` | 修改：finalize 步骤 4.5 接入 recompute |
| `inference/app/runtime.py` | 修改：AppRuntime 新增 recompute_asr 字段 |
| `inference/app/config.py` | 修改：新增 RECOMPUTE_ASR_* 配置 |
| `edge/worker/tests/incremental-recompute.test.ts` | 新建：Worker 端 recompute 测试 |
| `inference/tests/test_recompute_asr.py` | 扩展：per-utterance 接口 + finalize 集成测试 |
| `inference/tests/test_incremental_v1_routes.py` | 扩展：finalize + recompute 端到端测试 |

---

## 执行顺序

1. **Worker TS 接口** — 补 confidence + stream_role 到 utterance 类型 + parseProcessChunkResponse（硬点 1）
2. **Worker DO 累积** — runIncrementalJob 存储 utterances（含 stream_role）
3. **Inference schema** — RecomputeSegment（含 stream_role）+ FinalizeRequestV1 字段
4. **Inference asr_recompute** — 新增 recompute_utterance()
5. **Inference runtime** — 注册 recompute_asr
6. **Inference finalize** — 步骤 4.5 接入（双保险对齐 + 四计数 metrics）（硬点 3, 4）
7. **Worker finalize** — 筛选 + 按 stream_role 拉 R2 + payload 限流（硬点 1, 2）+ 清理 DO（硬点 5）
8. **测试** — 两端全量 pass + 13 条验收标准
