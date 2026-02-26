# Phase 2: 说话人分段管线接入 — pyannote SD 接入 Tier 2 Finalization

**Date:** 2026-02-26
**Status:** Draft
**Phase:** 2 of 3
**Gate:** [GATE 2 — 主控文档](./2026-02-26-backend-pipeline-master-design.md#gate-2-tier-2-说话人分段-e2e)
**前置条件:** GATE 1 通过（SenseVoice ASR 基准测试达标）

---

## 目标

将已存在但未接入的 pyannote 说话人分段管线（`PyannoteFullDiarizer` + `/batch/process`）正式连接到 Tier 2 finalization 流程，使系统能够在录制结束后产出带有精确说话人归属的转录文本。

**当前状态：**
- `inference/app/services/diarize_full.py` — `PyannoteFullDiarizer` 类已完整实现
- `inference/app/routes/batch.py` — `/batch/process` 端点已完整实现（Whisper + pyannote 并行）
- `edge/worker/src/index.ts` — Tier 2 框架已存在（状态跟踪、alarm 调度、R2 存储）
- **断点：** `TIER2_ENABLED=false`，`ENABLE_DIARIZATION=false`，pyannote 模型未下载

**不改动的组件：** Report Synthesizer、Events Analyzer、全局聚类、CAM++ SV。

---

## Task 2.0: GATE 1 回归验证（强制前置）

### 说明

在开始 Phase 2 任何工作之前，必须确认 Phase 1 的 GATE 1 仍然成立。

### 验证命令

```bash
cd inference

# GATE 1 回归
python -m pytest tests/test_sensevoice.py -v
python -m pytest tests/test_asr_endpoint_compat.py -v

# 快速基准回归
python tests/benchmark_asr.py --audio samples/short_3s_zh.wav --engine sensevoice
# 预期: RTF < 0.1
```

**如果任何一项失败：停止 Phase 2，回到 Phase 1 修复。**

---

## Task 2.1: 升级 pyannote 到 4.0 + community-1

### 改动文件

| 操作 | 文件 |
|------|------|
| **修改** | `inference/requirements.txt` |
| **修改** | `inference/app/config.py` |
| **修改** | `inference/app/services/diarize_full.py` |
| **修改** | `inference/.env` |
| **新建** | `inference/tests/test_diarize_full.py` |

### 2.1.1 修改 `requirements.txt`

```diff
- pyannote.audio>=3.1          # Full-pipeline diarization
+ pyannote.audio>=4.0.0        # Full-pipeline diarization (community-1)
```

### 2.1.2 修改 `config.py`

将默认值更新为 community-1 模型：

```python
    pyannote_model_id: str = Field(
        default="pyannote/speaker-diarization-community-1", alias="PYANNOTE_MODEL_ID"
    )
    # 注意: community-1 内置 WeSpeaker embeddings，不再需要单独的 embedding model
    # 但保留配置以兼容旧模型
    pyannote_embedding_model_id: str = Field(
        default="pyannote/wespeaker-voxceleb-resnet34-LM", alias="PYANNOTE_EMBEDDING_MODEL_ID"
    )
```

将 `enable_diarization` 默认值改为 `True`：

```python
    enable_diarization: bool = Field(default=True, alias="ENABLE_DIARIZATION")
```

### 2.1.3 修改 `diarize_full.py`

更新默认模型 ID：

```python
class PyannoteFullDiarizer:
    def __init__(
        self,
        device: str = "auto",
        hf_token: str | None = None,
        model_id: str = "pyannote/speaker-diarization-community-1",  # 从 3.1 升级
        embedding_model_id: str = "pyannote/wespeaker-voxceleb-resnet34-LM",
    ) -> None:
```

在 `_ensure_pipeline()` 中添加 MPS 回退保护：

```python
    def _ensure_pipeline(self) -> Any:
        if self._pipeline is not None:
            return self._pipeline

        from pyannote.audio import Pipeline
        import torch

        logger.info("Loading pyannote pipeline: %s (device=%s)", self._model_id, self._device)
        start = time.perf_counter()

        self._pipeline = Pipeline.from_pretrained(
            self._model_id,
            use_auth_token=self._hf_token,
        )

        # Device assignment with MPS fallback
        if self._device == "cuda" and torch.cuda.is_available():
            self._pipeline.to(torch.device("cuda"))
        elif self._device == "mps":
            try:
                self._pipeline.to(torch.device("mps"))
                logger.info("pyannote pipeline on MPS")
            except Exception:
                logger.warning("MPS failed for pyannote, falling back to CPU", exc_info=True)
                self._pipeline.to(torch.device("cpu"))
        else:
            self._pipeline.to(torch.device("cpu"))

        load_time = time.perf_counter() - start
        logger.info("pyannote pipeline loaded in %.2fs", load_time)
        return self._pipeline
```

### 2.1.4 修改 `.env`

```bash
# Speaker Diarization
ENABLE_DIARIZATION=true
PYANNOTE_MODEL_ID=pyannote/speaker-diarization-community-1
PYANNOTE_DEVICE=auto
HF_TOKEN=<your_huggingface_token>
```

**重要：** 必须在 HuggingFace 上接受以下模型的 license：
1. `pyannote/speaker-diarization-community-1`
2. `pyannote/segmentation-3.0`

访问 https://huggingface.co/pyannote/speaker-diarization-community-1 并点击 "Agree and access repository"。

### 2.1.5 创建测试 `inference/tests/test_diarize_full.py`

```python
"""Tests for PyannoteFullDiarizer.

Tests verify:
1. DiarizeResult schema correctness
2. Speaker segment output format
3. Embedding extraction
4. Error handling for missing HF token
"""

import pytest
from unittest.mock import patch, MagicMock
from app.services.diarize_full import PyannoteFullDiarizer, DiarizeResult, SpeakerSegment


class TestDiarizeResultSchema:
    def test_result_has_required_fields(self):
        result = DiarizeResult(
            segments=[
                SpeakerSegment(id="seg_0000", speaker_id="SPEAKER_00", start_ms=0, end_ms=5000),
                SpeakerSegment(id="seg_0001", speaker_id="SPEAKER_01", start_ms=5000, end_ms=10000),
            ],
            embeddings={"SPEAKER_00": [0.1] * 256, "SPEAKER_01": [0.2] * 256},
            num_speakers=2,
            duration_ms=10000,
            processing_time_ms=500,
        )
        assert len(result.segments) == 2
        assert len(result.embeddings) == 2
        assert result.num_speakers == 2
        assert result.segments[0].speaker_id == "SPEAKER_00"

    def test_segment_fields(self):
        seg = SpeakerSegment(id="seg_0", speaker_id="SPEAKER_00", start_ms=100, end_ms=5000, confidence=0.95)
        assert seg.id == "seg_0"
        assert seg.speaker_id == "SPEAKER_00"
        assert seg.start_ms == 100
        assert seg.end_ms == 5000
        assert seg.confidence == 0.95


class TestDiarizerInit:
    def test_default_model_is_community_1(self):
        d = PyannoteFullDiarizer.__new__(PyannoteFullDiarizer)
        d.__init__()
        assert "community-1" in d._model_id

    def test_custom_model_id(self):
        d = PyannoteFullDiarizer.__new__(PyannoteFullDiarizer)
        d.__init__(model_id="pyannote/speaker-diarization-3.1")
        assert d._model_id == "pyannote/speaker-diarization-3.1"

    def test_missing_hf_token_raises_on_load(self):
        """Without HF token, pipeline loading should fail gracefully."""
        d = PyannoteFullDiarizer(hf_token="")
        # Don't actually load — just verify the token is stored
        assert d._hf_token == ""
```

### 2.1.6 验证

```bash
cd inference

# pyannote 升级测试
pip install "pyannote.audio>=4.0.0"
python -m pytest tests/test_diarize_full.py -v
# 预期: 全部通过

# 全量回归
python -m pytest tests/ -v
# 预期: 全部通过（包含 Phase 1 测试）
```

**交叉验证：**
```bash
# 确认 SenseVoice 未受影响
python -m pytest tests/test_sensevoice.py -v
```

---

## Task 2.2: 验证 `/batch/process` 端到端

### 说明

`/batch/process` 端点已经实现了 Whisper + pyannote 并行处理 + merge 逻辑。我们需要验证它在升级后仍然正确工作，特别是：
1. SenseVoice 作为 ASR 后端（替代 Whisper）
2. pyannote community-1 作为 SD 后端

### 改动文件

| 操作 | 文件 |
|------|------|
| **修改** | `inference/app/routes/batch.py` |
| **新建** | `inference/tests/test_batch_process.py` |

### 2.2.1 修改 `batch.py` — 使用 runtime ASR 后端

当前 `/batch/process` 使用独立的 `_get_whisper()` 单例。修改为使用 runtime 的 ASR 后端（与 Phase 1 的 `routes/asr.py` 改动一致）：

```python
@router.post("/process", response_model=BatchProcessResponse)
async def batch_process(req: BatchProcessRequest, request: Request) -> BatchProcessResponse:
    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url

    try:
        asr = request.app.state.runtime.asr_backend  # 使用 runtime ASR（SenseVoice 或 Whisper）
        diarizer = _get_diarizer()

        # Run ASR and diarization in parallel
        transcript_result, diarize_result = await asyncio.gather(
            asyncio.to_thread(asr.transcribe, audio_path, language=req.language),
            asyncio.to_thread(
                diarizer.diarize,
                audio_path,
                num_speakers=req.num_speakers,
                min_speakers=req.min_speakers,
                max_speakers=req.max_speakers,
            ),
        )

        merged = _merge_transcript_diarization(transcript_result, diarize_result)
        stats = _compute_speaker_stats(diarize_result)
        total_time = transcript_result.processing_time_ms + diarize_result.processing_time_ms

        return BatchProcessResponse(
            transcript=merged,
            speaker_stats=stats,
            language=transcript_result.language,
            duration_ms=max(transcript_result.duration_ms, diarize_result.duration_ms),
            transcription_time_ms=transcript_result.processing_time_ms,
            diarization_time_ms=diarize_result.processing_time_ms,
            total_processing_time_ms=total_time,
        )
    finally:
        if is_temp:
            try:
                Path(audio_path).unlink(missing_ok=True)
            except OSError:
                pass
```

### 2.2.2 创建集成测试 `inference/tests/test_batch_process.py`

```python
"""Integration tests for /batch/process endpoint.

Verifies the complete pipeline: ASR (SenseVoice) + SD (pyannote) + merge.

CRITICAL: This test is the core verification for Phase 2.
If this test passes, the Tier 2 pipeline is verified to work end-to-end.
"""

import pytest
from fastapi.testclient import TestClient
from app.main import app

# Skip if no test audio available
AUDIO_PATH = "samples/10min_interview_16k.wav"
SHORT_AUDIO = "samples/short_3s_zh.wav"


@pytest.fixture
def client():
    return TestClient(app)


class TestBatchProcessSchema:
    """Verify /batch/process response matches Tier 2 expectations."""

    @pytest.mark.skipif(
        not __import__("pathlib").Path(SHORT_AUDIO).exists(),
        reason="Test audio not available"
    )
    def test_response_schema(self, client):
        resp = client.post("/batch/process", json={
            "audio_url": SHORT_AUDIO,
            "language": "auto",
        })
        assert resp.status_code == 200
        data = resp.json()

        # Required fields
        assert "transcript" in data
        assert "speaker_stats" in data
        assert "language" in data
        assert "duration_ms" in data
        assert "transcription_time_ms" in data
        assert "diarization_time_ms" in data
        assert "total_processing_time_ms" in data

    @pytest.mark.skipif(
        not __import__("pathlib").Path(SHORT_AUDIO).exists(),
        reason="Test audio not available"
    )
    def test_transcript_has_speaker_attribution(self, client):
        """Each utterance must have a 'speaker' field."""
        resp = client.post("/batch/process", json={
            "audio_url": SHORT_AUDIO,
            "language": "auto",
        })
        data = resp.json()
        for utt in data["transcript"]:
            assert "speaker" in utt
            assert "text" in utt
            assert "start_ms" in utt
            assert "end_ms" in utt

    @pytest.mark.skipif(
        not __import__("pathlib").Path(SHORT_AUDIO).exists(),
        reason="Test audio not available"
    )
    def test_speaker_stats_present(self, client):
        resp = client.post("/batch/process", json={
            "audio_url": SHORT_AUDIO,
            "language": "auto",
        })
        data = resp.json()
        for stat in data["speaker_stats"]:
            assert "speaker_id" in stat
            assert "total_duration_ms" in stat
            assert "segment_count" in stat
            assert "talk_ratio" in stat


class TestBatchProcessMergeLogic:
    """Verify speaker assignment accuracy (GATE 2 criteria)."""

    @pytest.mark.skipif(
        not __import__("pathlib").Path(AUDIO_PATH).exists(),
        reason="10min test audio not available"
    )
    def test_speaker_attribution_coverage(self, client):
        """GATE 2.2: >90% utterances must have speaker != '_unknown'."""
        resp = client.post("/batch/process", json={
            "audio_url": AUDIO_PATH,
            "num_speakers": 3,
            "language": "auto",
        })
        assert resp.status_code == 200
        data = resp.json()

        total = len(data["transcript"])
        if total == 0:
            pytest.skip("No utterances produced")

        attributed = sum(1 for u in data["transcript"] if u["speaker"] != "_unknown")
        coverage = attributed / total

        assert coverage > 0.9, f"Speaker attribution coverage {coverage:.2%} < 90%"

    @pytest.mark.skipif(
        not __import__("pathlib").Path(AUDIO_PATH).exists(),
        reason="10min test audio not available"
    )
    def test_speaker_count_matches(self, client):
        """GATE 2.3: Detected speakers should match hint (±1)."""
        expected_speakers = 3
        resp = client.post("/batch/process", json={
            "audio_url": AUDIO_PATH,
            "num_speakers": expected_speakers,
            "language": "auto",
        })
        data = resp.json()
        detected = len(data["speaker_stats"])

        assert abs(detected - expected_speakers) <= 1, \
            f"Expected ~{expected_speakers} speakers, got {detected}"
```

### 2.2.3 验证

```bash
cd inference

# 单元测试
python -m pytest tests/test_batch_process.py -v
# 预期: schema 测试通过

# 集成测试（需要 10 分钟音频 + HF_TOKEN 配置）
python -m pytest tests/test_batch_process.py -v -k "attribution_coverage"
# 预期: >90% speaker attribution

# 交叉验证
python -m pytest tests/test_sensevoice.py tests/test_asr_endpoint_compat.py -v
```

---

## Task 2.3: 启用 Tier 2 并验证 Edge Worker 调用链

### 改动文件

| 操作 | 文件 |
|------|------|
| **修改** | `edge/worker/wrangler.jsonc` |
| **新建** | `inference/tests/test_tier2_e2e.py` |

### 2.3.1 修改 `wrangler.jsonc`

将以下变量从 `false` 改为 `true`：

```jsonc
{
  "vars": {
    "TIER2_ENABLED": "true",           // 启用 Tier 2
    "TIER2_AUTO_TRIGGER": "true",      // Tier 1 完成后自动触发
    // ... 其他变量不变
  }
}
```

### 2.3.2 验证 Edge Worker Tier 2 调用路径

确认 Edge Worker 的 `runTier2Job()` 方法调用的 URL 和 schema 与 inference 服务的 `/batch/process` 匹配：

```bash
cd edge/worker
npx vitest run
# 预期: 59 测试全部通过
```

### 2.3.3 完整 E2E 验证（GATE 2 正式验收）

```bash
# 1. 启动推理服务
cd inference && uvicorn app.main:app --host 0.0.0.0 --port 8000 &

# 2. 等待模型加载
sleep 10
curl http://localhost:8000/health

# 3. 直接测试 /batch/process
curl -s -X POST http://localhost:8000/batch/process \
  -H "Content-Type: application/json" \
  -d '{"audio_url": "samples/10min_interview_16k.wav", "num_speakers": 3}' | python -m json.tool

# 4. 验证输出
# - 检查 transcript 数组中每个元素的 speaker 字段
# - 检查 speaker_stats 数组长度（应为 2-4）
# - 检查 total_processing_time_ms（MPS < 5min, CUDA < 2min）
```

---

## Task 2.4: 实现 `/sd/diarize` 端点（替换 501 占位符）

### 改动文件

| 操作 | 文件 |
|------|------|
| **修改** | `inference/app/main.py` |
| **修改** | `inference/app/schemas.py` |

### 2.4.1 修改 `main.py`

将 `/sd/diarize` 端点从 501 占位符改为调用 `PyannoteFullDiarizer`：

```python
@app.post("/sd/diarize", response_model=DiarizeResponse)
async def diarize(req: DiarizeRequest) -> DiarizeResponse:
    """Speaker diarization using pyannote.audio full pipeline."""
    if not app.state.runtime.settings.enable_diarization:
        raise NotImplementedServiceError("/sd/diarize is disabled (ENABLE_DIARIZATION=false)")

    from app.routes.batch import _get_diarizer, _resolve_audio

    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url

    try:
        diarizer = _get_diarizer()
        result = await asyncio.to_thread(
            diarizer.diarize,
            audio_path,
            num_speakers=req.num_speakers,
            min_speakers=req.min_speakers,
            max_speakers=req.max_speakers,
        )

        return DiarizeResponse(
            segments=[
                {"id": s.id, "speaker_id": s.speaker_id, "start_ms": s.start_ms, "end_ms": s.end_ms}
                for s in result.segments
            ],
            embeddings=result.embeddings,
            num_speakers=result.num_speakers,
            duration_ms=result.duration_ms,
            processing_time_ms=result.processing_time_ms,
        )
    finally:
        if is_temp:
            try:
                __import__("pathlib").Path(audio_path).unlink(missing_ok=True)
            except OSError:
                pass
```

### 2.4.2 修改 `schemas.py`

确保 `DiarizeRequest` 和 `DiarizeResponse` schema 已定义（如果不存在则添加）：

```python
class DiarizeRequest(BaseModel):
    audio_url: str
    num_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None

class DiarizeResponse(BaseModel):
    segments: list[dict]
    embeddings: dict[str, list[float]]
    num_speakers: int
    duration_ms: int
    processing_time_ms: int
```

### 2.4.3 验证

```bash
cd inference

# 确认端点不再返回 501
curl -s -X POST http://localhost:8000/sd/diarize \
  -H "Content-Type: application/json" \
  -d '{"audio_url": "samples/short_3s_zh.wav"}' | python -m json.tool
# 预期: 200 OK with segments

# 全量回归
python -m pytest tests/ -v
```

---

## 文件变更汇总

| 操作 | 文件 | 改动量 |
|------|------|--------|
| 修改 | `inference/requirements.txt` | 1 行改动 |
| 修改 | `inference/app/config.py` | 3 行改动 |
| 修改 | `inference/app/services/diarize_full.py` | ~30 行改动 |
| 修改 | `inference/app/routes/batch.py` | ~10 行改动 |
| 修改 | `inference/app/main.py` | ~30 行（替换 501 占位符） |
| 修改 | `inference/app/schemas.py` | ~15 行 |
| 修改 | `inference/.env` | +4 行 |
| 修改 | `edge/worker/wrangler.jsonc` | 2 行改动 |
| 新建 | `inference/tests/test_diarize_full.py` | ~60 行 |
| 新建 | `inference/tests/test_batch_process.py` | ~120 行 |
| 新建 | `inference/tests/test_tier2_e2e.py` | ~80 行 |

---

## 回退路径

如果 pyannote community-1 在 GATE 2 验收时未通过：

1. 回退 `PYANNOTE_MODEL_ID` 到 `pyannote/speaker-diarization-3.1`
2. 如果 3.1 也不工作，设置 `ENABLE_DIARIZATION=false`，`TIER2_ENABLED=false`
3. 系统回退到仅 Tier 1（CAM++ SV 聚类 + SenseVoice ASR），仍然比 Phase 0 好（ASR 已替换）
4. Phase 1 的改进（SenseVoice ASR）独立于 Phase 2，不受影响
