# Phase 1: ASR 引擎升级 — SenseVoice-Small 替换 faster-whisper

**Date:** 2026-02-26
**Status:** Completed
**Phase:** 1 of 3
**Gate:** [GATE 1 — 主控文档](./2026-02-26-backend-pipeline-master-design.md#gate-1-asr-引擎基准测试)
**前置条件:** Task 0（测试音频准备）完成

---

## 目标

将 inference 服务的 ASR 引擎从 `faster-whisper`（CTranslate2，Apple Silicon 上 CPU 回退，RTF ≈ 1.0）替换为 `SenseVoice-Small`（FunASR，Apple Silicon 上 ONNX/MPS 加速，RTF < 0.1），同时保留 Whisper 作为可配置回退。

**不改动的组件：** Edge Worker、报告管线、SV 模型、聚类逻辑。

---

## Task 1.1: 新增 SenseVoice 转录后端

### 改动文件

| 操作 | 文件 |
|------|------|
| **新建** | `inference/app/services/sensevoice_transcriber.py` |
| **修改** | `inference/requirements.txt` |
| **新建** | `inference/tests/test_sensevoice.py` |

### 1.1.1 创建 `sensevoice_transcriber.py`

```python
"""SenseVoice-Small ASR backend via FunASR.

Replaces faster-whisper for Tier 1 windowed transcription.
SenseVoice-Small: 234M params, non-autoregressive, EN+ZH bilingual.
- EN WER: 1.82% (LibriSpeech test-clean)
- ZH WER: 5.14% (AISHELL-1 test)
- Speed: 70ms for 10s audio (15x faster than Whisper Large-v3)
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
import wave
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from app.services.device import DeviceType, detect_device
from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp

logger = logging.getLogger(__name__)

# Module-level singleton cache
_sv_model: Any | None = None
_sv_model_lock = threading.Lock()


def _get_sensevoice_model(
    model_id: str,
    device: DeviceType,
    cache_dir: str,
) -> Any:
    """Lazy-load SenseVoice model (thread-safe singleton)."""
    global _sv_model
    if _sv_model is not None:
        return _sv_model

    with _sv_model_lock:
        if _sv_model is not None:
            return _sv_model

        os.environ.setdefault("MODELSCOPE_CACHE", os.path.expanduser(cache_dir))

        from funasr import AutoModel

        # Device mapping for FunASR
        device_str = "cpu"
        if device == "cuda":
            device_str = "cuda:0"
        elif device == "mps":
            # FunASR + SenseVoice supports MPS via PyTorch backend
            device_str = "mps"

        logger.info("Loading SenseVoice model=%s device=%s", model_id, device_str)
        start = time.perf_counter()

        _sv_model = AutoModel(
            model=model_id,
            trust_remote_code=True,
            device=device_str,
        )

        load_time = time.perf_counter() - start
        logger.info("SenseVoice model loaded in %.2fs", load_time)
        return _sv_model


class SenseVoiceTranscriber:
    """SenseVoice-Small ASR backend.

    Drop-in replacement for WhisperBatchTranscriber.
    Returns the same TranscriptResult dataclass.
    """

    def __init__(
        self,
        model_id: str = "iic/SenseVoiceSmall",
        device: str = "auto",
        cache_dir: str = "~/.cache/modelscope",
    ) -> None:
        self._model_id = model_id
        self._device: DeviceType = detect_device() if device == "auto" else device  # type: ignore[assignment]
        self._cache_dir = cache_dir

    @property
    def device(self) -> DeviceType:
        return self._device

    @property
    def backend(self) -> str:
        return "sensevoice"

    @property
    def model_size(self) -> str:
        return self._model_id.split("/")[-1]

    def transcribe(self, audio_path: str, language: str = "auto") -> TranscriptResult:
        """Transcribe an audio file. Returns TranscriptResult (same schema as Whisper)."""
        model = _get_sensevoice_model(self._model_id, self._device, self._cache_dir)

        start = time.perf_counter()

        # SenseVoice language mapping
        lang_map = {"zh": "zh", "en": "en", "ja": "ja", "ko": "ko", "yue": "yue"}
        sv_lang = lang_map.get(language, "auto")

        results = model.generate(
            input=audio_path,
            cache={},
            language=sv_lang,
            use_itn=True,
            batch_size_s=60,  # Process up to 60s per batch
        )

        elapsed_ms = int((time.perf_counter() - start) * 1000)

        # Parse SenseVoice output
        utterances: list[Utterance] = []
        detected_lang = language

        for i, res in enumerate(results):
            raw_text = res.get("text", "")
            # Strip SenseVoice special tokens: <|zh|><|NEUTRAL|><|Speech|><|woitn|>
            text = self._strip_special_tokens(raw_text)

            if not text.strip():
                continue

            # Extract language from special tokens if auto
            if language == "auto":
                detected_lang = self._detect_language_from_tokens(raw_text)

            # SenseVoice returns timestamps if available
            timestamp = res.get("timestamp", [])
            words: list[WordTimestamp] = []
            if timestamp:
                for ts_item in timestamp:
                    if isinstance(ts_item, (list, tuple)) and len(ts_item) >= 3:
                        words.append(WordTimestamp(
                            word=str(ts_item[2]) if len(ts_item) > 2 else "",
                            start_ms=int(ts_item[0]),
                            end_ms=int(ts_item[1]),
                            confidence=1.0,
                        ))

            utterances.append(Utterance(
                id=f"u_{i:04d}",
                text=text,
                start_ms=words[0].start_ms if words else 0,
                end_ms=words[-1].end_ms if words else 0,
                words=words,
                language=detected_lang,
                confidence=1.0,
            ))

        # Calculate audio duration from file
        duration_ms = self._get_audio_duration_ms(audio_path)

        return TranscriptResult(
            utterances=utterances,
            language=detected_lang,
            duration_ms=duration_ms,
            processing_time_ms=elapsed_ms,
            backend="sensevoice",
            model_size=self.model_size,
        )

    def transcribe_pcm(
        self,
        pcm_data: bytes,
        sample_rate: int = 16000,
        language: str = "auto",
    ) -> TranscriptResult:
        """Transcribe raw PCM16 data. Writes to temp WAV then calls transcribe()."""
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            with wave.open(tmp, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(pcm_data)
            tmp_path = tmp.name

        try:
            return self.transcribe(tmp_path, language=language)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    @staticmethod
    def _strip_special_tokens(text: str) -> str:
        """Remove SenseVoice special tokens from output."""
        import re
        # Tokens: <|zh|>, <|en|>, <|NEUTRAL|>, <|HAPPY|>, <|Speech|>, <|woitn|>, etc.
        return re.sub(r"<\|[^|]+\|>", "", text).strip()

    @staticmethod
    def _detect_language_from_tokens(text: str) -> str:
        """Extract detected language from SenseVoice special tokens."""
        import re
        match = re.search(r"<\|(zh|en|ja|ko|yue)\|>", text)
        return match.group(1) if match else "auto"

    @staticmethod
    def _get_audio_duration_ms(audio_path: str) -> int:
        """Get audio duration in milliseconds."""
        try:
            with wave.open(audio_path, "rb") as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                return int(frames / rate * 1000)
        except Exception:
            return 0
```

### 1.1.2 修改 `inference/requirements.txt`

在文件末尾添加：
```
funasr>=1.2.0                # SenseVoice ASR backend
```

**注意：** `funasr` 依赖 `torch` 和 `torchaudio`（已存在于 requirements.txt），不需要额外添加。

### 1.1.3 创建单元测试 `inference/tests/test_sensevoice.py`

```python
"""Unit tests for SenseVoice transcriber.

Tests verify:
1. Model loading (lazy singleton)
2. PCM transcription returns correct TranscriptResult schema
3. Special token stripping
4. Language detection from tokens
5. Empty audio handling
6. Schema compatibility with Whisper output
"""

import pytest
from unittest.mock import patch, MagicMock
from app.services.sensevoice_transcriber import SenseVoiceTranscriber
from app.services.whisper_batch import TranscriptResult, Utterance


class TestSpecialTokenStripping:
    def test_strips_language_token(self):
        assert SenseVoiceTranscriber._strip_special_tokens("<|zh|>你好世界") == "你好世界"

    def test_strips_multiple_tokens(self):
        raw = "<|zh|><|NEUTRAL|><|Speech|><|woitn|>你好世界"
        assert SenseVoiceTranscriber._strip_special_tokens(raw) == "你好世界"

    def test_preserves_clean_text(self):
        assert SenseVoiceTranscriber._strip_special_tokens("Hello world") == "Hello world"

    def test_strips_emotion_tokens(self):
        raw = "<|en|><|HAPPY|><|Speech|>Great job everyone"
        assert SenseVoiceTranscriber._strip_special_tokens(raw) == "Great job everyone"


class TestLanguageDetection:
    def test_detects_chinese(self):
        assert SenseVoiceTranscriber._detect_language_from_tokens("<|zh|>你好") == "zh"

    def test_detects_english(self):
        assert SenseVoiceTranscriber._detect_language_from_tokens("<|en|>Hello") == "en"

    def test_returns_auto_for_unknown(self):
        assert SenseVoiceTranscriber._detect_language_from_tokens("Hello") == "auto"


class TestTranscribeOutput:
    """Verify output schema matches WhisperBatchTranscriber exactly."""

    def test_returns_transcript_result(self):
        t = SenseVoiceTranscriber.__new__(SenseVoiceTranscriber)
        t._model_id = "iic/SenseVoiceSmall"
        t._device = "cpu"
        t._cache_dir = "~/.cache/modelscope"

        # Mock the model
        mock_model = MagicMock()
        mock_model.generate.return_value = [
            {"text": "<|zh|><|NEUTRAL|><|Speech|>你好世界", "timestamp": [[0, 1500, "你好世界"]]}
        ]

        with patch("app.services.sensevoice_transcriber._get_sensevoice_model", return_value=mock_model):
            with patch.object(SenseVoiceTranscriber, "_get_audio_duration_ms", return_value=3000):
                result = t.transcribe("/fake/path.wav", language="auto")

        # Verify schema compatibility
        assert isinstance(result, TranscriptResult)
        assert isinstance(result.utterances, list)
        assert len(result.utterances) == 1
        assert isinstance(result.utterances[0], Utterance)
        assert result.utterances[0].text == "你好世界"
        assert result.backend == "sensevoice"
        assert result.processing_time_ms >= 0
        assert result.duration_ms == 3000
        assert result.language == "zh"

    def test_empty_audio_returns_empty_utterances(self):
        t = SenseVoiceTranscriber.__new__(SenseVoiceTranscriber)
        t._model_id = "iic/SenseVoiceSmall"
        t._device = "cpu"
        t._cache_dir = "~/.cache/modelscope"

        mock_model = MagicMock()
        mock_model.generate.return_value = [{"text": "", "timestamp": []}]

        with patch("app.services.sensevoice_transcriber._get_sensevoice_model", return_value=mock_model):
            with patch.object(SenseVoiceTranscriber, "_get_audio_duration_ms", return_value=0):
                result = t.transcribe("/fake/silence.wav")

        assert isinstance(result, TranscriptResult)
        assert len(result.utterances) == 0

    def test_backend_property(self):
        t = SenseVoiceTranscriber()
        assert t.backend == "sensevoice"

    def test_model_size_property(self):
        t = SenseVoiceTranscriber(model_id="iic/SenseVoiceSmall")
        assert t.model_size == "SenseVoiceSmall"
```

### 1.1.4 验证

```bash
cd inference
python -m pytest tests/test_sensevoice.py -v
# 预期: 8 passed, 0 failed
```

**交叉验证：** 运行现有 Whisper 测试确认无回归：
```bash
python -m pytest tests/ -v --ignore=tests/test_sensevoice.py
# 预期: 所有现有测试通过（95 tests）
```

---

## Task 1.2: 添加 ASR 后端配置选择

### 改动文件

| 操作 | 文件 |
|------|------|
| **修改** | `inference/app/config.py` |
| **修改** | `inference/app/runtime.py` |
| **修改** | `inference/app/routes/asr.py` |
| **修改** | `inference/app/routes/batch.py` |
| **新建** | `inference/tests/test_asr_backend_selection.py` |

### 1.2.1 修改 `config.py` — 新增 ASR 后端配置

在 `Settings` 类中添加：

```python
    # ASR backend selection
    asr_backend: Literal["sensevoice", "whisper", "whisper-cpp"] = Field(
        default="sensevoice", alias="ASR_BACKEND"
    )
    sensevoice_model_id: str = Field(
        default="iic/SenseVoiceSmall", alias="SENSEVOICE_MODEL_ID"
    )
    sensevoice_device: str = Field(default="auto", alias="SENSEVOICE_DEVICE")
```

**位置：** 在 `whisper_model_size` 字段之前，第 57 行附近。

### 1.2.2 修改 `runtime.py` — 创建 ASR 后端工厂

添加类型和工厂方法：

```python
from app.services.sensevoice_transcriber import SenseVoiceTranscriber
from app.services.whisper_batch import WhisperBatchTranscriber

# ASR 后端的协议（duck typing — 两者都有 transcribe, transcribe_pcm, device, backend, model_size）
ASRBackend = SenseVoiceTranscriber | WhisperBatchTranscriber


def build_asr_backend(settings: Settings) -> ASRBackend:
    if settings.asr_backend == "sensevoice":
        return SenseVoiceTranscriber(
            model_id=settings.sensevoice_model_id,
            device=settings.sensevoice_device,
            cache_dir=settings.modelscope_cache,
        )
    else:
        return WhisperBatchTranscriber(
            model_size=settings.whisper_model_size,
            device=settings.whisper_device,
        )
```

在 `AppRuntime` dataclass 中添加字段：
```python
    asr_backend: ASRBackend
```

在 `build_runtime()` 中初始化：
```python
    asr = build_asr_backend(settings)
```

### 1.2.3 修改 `routes/asr.py` — 使用 runtime 中的 ASR 后端

当前代码直接使用 `runtime.sv_backend`（SV）和内部 Whisper 实例。修改为使用 `runtime.asr_backend`：

将 `/asr/transcribe-window` 端点中的 Whisper 调用替换为：
```python
    asr = request.app.state.runtime.asr_backend
    result = await asyncio.to_thread(asr.transcribe_pcm, pcm_data, sample_rate, language)
```

修改 `/asr/status` 端点返回当前后端信息：
```python
    asr = request.app.state.runtime.asr_backend
    return AsrStatusResponse(
        available=True,
        device=asr.device,
        backend=asr.backend,
        model=asr.model_size,
    )
```

### 1.2.4 修改 `routes/batch.py` — 共享 ASR 后端

将 `_get_whisper()` 替换为使用 runtime 的 ASR 后端：

```python
# 删除旧的 _whisper 全局变量和 _get_whisper() 函数

@router.post("/transcribe", response_model=BatchTranscribeResponse)
async def batch_transcribe(req: BatchTranscribeRequest, request: Request) -> BatchTranscribeResponse:
    audio_path = await _resolve_audio(req.audio_url)
    is_temp = audio_path != req.audio_url
    try:
        asr = request.app.state.runtime.asr_backend
        result = await asyncio.to_thread(asr.transcribe, audio_path, language=req.language)
        # ... (rest unchanged)
```

同样修改 `/batch/process` 中的 `whisper` 引用。

### 1.2.5 验证

```bash
cd inference

# 1. 新的后端选择测试
python -m pytest tests/test_asr_backend_selection.py -v

# 2. SenseVoice 单元测试回归
python -m pytest tests/test_sensevoice.py -v

# 3. 全量回归
python -m pytest tests/ -v

# 预期: 全部通过
```

---

## Task 1.3: 修改 `.env` 配置

### 改动文件

| 操作 | 文件 |
|------|------|
| **修改** | `inference/.env` |
| **修改** | `inference/.env.example` |

### 1.3.1 `.env` 新增

```bash
# ASR Backend Selection
ASR_BACKEND=sensevoice
SENSEVOICE_MODEL_ID=iic/SenseVoiceSmall
SENSEVOICE_DEVICE=auto
```

### 1.3.2 `.env.example` 新增（同上，但值可以为空）

```bash
# ASR Backend Selection (sensevoice | whisper | whisper-cpp)
ASR_BACKEND=sensevoice
SENSEVOICE_MODEL_ID=iic/SenseVoiceSmall
SENSEVOICE_DEVICE=auto
```

### 1.3.3 验证

```bash
cd inference

# 确认配置加载正确
python -c "from app.config import get_settings; s = get_settings(); print(f'ASR={s.asr_backend}, model={s.sensevoice_model_id}, device={s.sensevoice_device}')"
# 预期输出: ASR=sensevoice, model=iic/SenseVoiceSmall, device=auto
```

---

## Task 1.4: 创建基准测试脚本

### 改动文件

| 操作 | 文件 |
|------|------|
| **新建** | `inference/tests/benchmark_asr.py` |

### 1.4.1 基准测试脚本

```python
"""ASR benchmark: compares SenseVoice vs Whisper on the same audio.

Usage:
    python tests/benchmark_asr.py --audio samples/10min_interview_16k.wav
    python tests/benchmark_asr.py --audio samples/short_3s_zh.wav --engine sensevoice
    python tests/benchmark_asr.py --audio samples/short_3s_en.wav --engine whisper
"""

import argparse
import json
import sys
import time
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.device import detect_device


def benchmark_sensevoice(audio_path: str) -> dict:
    from app.services.sensevoice_transcriber import SenseVoiceTranscriber
    t = SenseVoiceTranscriber()
    start = time.perf_counter()
    result = t.transcribe(audio_path)
    wall_time_ms = int((time.perf_counter() - start) * 1000)
    return {
        "engine": "sensevoice",
        "backend": result.backend,
        "model": result.model_size,
        "device": t.device,
        "duration_ms": result.duration_ms,
        "processing_time_ms": result.processing_time_ms,
        "wall_time_ms": wall_time_ms,
        "rtf": round(wall_time_ms / max(result.duration_ms, 1), 4),
        "utterance_count": len(result.utterances),
        "total_chars": sum(len(u.text) for u in result.utterances),
        "language": result.language,
    }


def benchmark_whisper(audio_path: str) -> dict:
    from app.services.whisper_batch import WhisperBatchTranscriber
    t = WhisperBatchTranscriber()
    start = time.perf_counter()
    result = t.transcribe(audio_path)
    wall_time_ms = int((time.perf_counter() - start) * 1000)
    return {
        "engine": "whisper",
        "backend": result.backend,
        "model": result.model_size,
        "device": t.device,
        "duration_ms": result.duration_ms,
        "processing_time_ms": result.processing_time_ms,
        "wall_time_ms": wall_time_ms,
        "rtf": round(wall_time_ms / max(result.duration_ms, 1), 4),
        "utterance_count": len(result.utterances),
        "total_chars": sum(len(u.text) for u in result.utterances),
        "language": result.language,
    }


def main():
    parser = argparse.ArgumentParser(description="ASR benchmark")
    parser.add_argument("--audio", required=True, help="Path to test audio (WAV, 16kHz mono)")
    parser.add_argument("--engine", default="both", choices=["sensevoice", "whisper", "both"])
    args = parser.parse_args()

    print(f"Device: {detect_device()}")
    print(f"Audio: {args.audio}")
    print("=" * 60)

    results = []

    if args.engine in ("sensevoice", "both"):
        print("\n--- SenseVoice ---")
        r = benchmark_sensevoice(args.audio)
        results.append(r)
        print(json.dumps(r, indent=2, ensure_ascii=False))

    if args.engine in ("whisper", "both"):
        print("\n--- Whisper ---")
        r = benchmark_whisper(args.audio)
        results.append(r)
        print(json.dumps(r, indent=2, ensure_ascii=False))

    if len(results) == 2:
        sv, wh = results
        print("\n--- Comparison ---")
        print(f"SenseVoice RTF: {sv['rtf']} | Whisper RTF: {wh['rtf']}")
        speedup = round(wh['wall_time_ms'] / max(sv['wall_time_ms'], 1), 1)
        print(f"SenseVoice is {speedup}x faster than Whisper")

    # GATE 1 check
    for r in results:
        if r["engine"] == "sensevoice":
            if r["rtf"] >= 0.1:
                print(f"\n❌ GATE 1 FAIL: SenseVoice RTF {r['rtf']} >= 0.1")
                sys.exit(1)
            else:
                print(f"\n✓ GATE 1.2 PASS: SenseVoice RTF {r['rtf']} < 0.1")


if __name__ == "__main__":
    main()
```

### 1.4.2 验证

```bash
cd inference

# 快速测试（3 秒音频）
python tests/benchmark_asr.py --audio samples/short_3s_zh.wav --engine sensevoice

# 完整基准（10 分钟音频）— 这是 GATE 1 的正式验收
python tests/benchmark_asr.py --audio samples/10min_interview_16k.wav --engine both

# GATE 1 判定:
# ✓ RTF < 0.1 → PASS
# ❌ RTF >= 0.1 → FAIL, 停止，不进入 Phase 2
```

---

## Task 1.5: Edge Worker 兼容性验证

### 说明

Edge Worker 的 `LocalWhisperASRProvider` 调用 `POST /asr/transcribe-window`。由于我们只修改了后端实现而保持了 API 响应 schema 不变，理论上 Edge Worker 不需要任何改动。

但**必须验证**以确保没有细微差异。

### 改动文件

| 操作 | 文件 |
|------|------|
| **新建** | `inference/tests/test_asr_endpoint_compat.py` |

### 1.5.1 端点兼容性测试

```python
"""Integration test: verify /asr/transcribe-window response schema
matches what Edge Worker's LocalWhisperASRProvider expects.

Edge Worker expects:
{
    "text": str,
    "utterances": [{"id": str, "text": str, "start_ms": int, "end_ms": int, ...}],
    "language": str,
    "duration_ms": int,
    "processing_time_ms": int,
    "backend": str,
    "device": str
}
"""

import pytest
from fastapi.testclient import TestClient
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


class TestTranscribeWindowCompat:
    """Verify response schema matches Edge Worker expectations."""

    def test_response_has_required_fields(self, client):
        """Edge Worker checks: text, utterances, language, processing_time_ms, backend."""
        # 3 seconds of silence (16kHz mono PCM16 = 96000 bytes)
        pcm = b"\x00\x00" * 48000
        resp = client.post(
            "/asr/transcribe-window?sample_rate=16000&language=auto",
            content=pcm,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert resp.status_code == 200
        data = resp.json()

        # Required fields (Edge Worker reads these)
        assert "text" in data
        assert isinstance(data["text"], str)
        assert "utterances" in data
        assert isinstance(data["utterances"], list)
        assert "language" in data
        assert isinstance(data["language"], str)
        assert "processing_time_ms" in data
        assert isinstance(data["processing_time_ms"], int)
        assert "backend" in data
        assert isinstance(data["backend"], str)
        assert "device" in data
        assert isinstance(data["device"], str)

    def test_utterance_schema(self, client):
        """Each utterance must have: id, text, start_ms, end_ms."""
        # Use a short real audio sample if available
        pcm = b"\x00\x00" * 48000  # 3s silence
        resp = client.post(
            "/asr/transcribe-window?sample_rate=16000",
            content=pcm,
            headers={"Content-Type": "application/octet-stream"},
        )
        data = resp.json()
        for utt in data["utterances"]:
            assert "id" in utt
            assert "text" in utt
            assert "start_ms" in utt
            assert "end_ms" in utt

    def test_status_endpoint(self, client):
        """Edge Worker calls /asr/status to check availability."""
        resp = client.get("/asr/status")
        assert resp.status_code == 200
        data = resp.json()
        assert "available" in data
        assert "device" in data
        assert "backend" in data
        assert "model" in data
```

### 1.5.2 Edge Worker 测试

```bash
cd edge/worker
npx vitest run
# 预期: 所有 59 测试通过（Edge Worker 代码未改动）
```

### 1.5.3 交叉验证

```bash
cd inference
# 全量回归（包含新增的兼容性测试）
python -m pytest tests/ -v
# 预期: 全部通过
```

---

## 回退路径

如果 SenseVoice 在 GATE 1 验收时未通过：

1. 将 `.env` 中的 `ASR_BACKEND` 改为 `whisper`
2. 系统立即回退到 faster-whisper（所有代码路径保持兼容）
3. 调查替代方案：`whisper.cpp` + CoreML（RTF 0.08-0.30，已验证可用）
4. 如果选择 whisper.cpp，需要在 `WhisperBatchTranscriber` 中优先使用 whisper-cpp 后端

---

## 文件变更汇总

| 操作 | 文件 | 改动量 |
|------|------|--------|
| 新建 | `inference/app/services/sensevoice_transcriber.py` | ~180 行 |
| 修改 | `inference/app/config.py` | +5 行 |
| 修改 | `inference/app/runtime.py` | +15 行 |
| 修改 | `inference/app/routes/asr.py` | ~10 行改动 |
| 修改 | `inference/app/routes/batch.py` | ~15 行改动 |
| 修改 | `inference/requirements.txt` | +1 行 |
| 修改 | `inference/.env` | +3 行 |
| 修改 | `inference/.env.example` | +3 行 |
| 新建 | `inference/tests/test_sensevoice.py` | ~100 行 |
| 新建 | `inference/tests/test_asr_backend_selection.py` | ~50 行 |
| 新建 | `inference/tests/test_asr_endpoint_compat.py` | ~80 行 |
| 新建 | `inference/tests/benchmark_asr.py` | ~100 行 |
