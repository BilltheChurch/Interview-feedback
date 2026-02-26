# 后端管线验证 — 主控设计方案

**Date:** 2026-02-26
**Status:** Draft
**Author:** Claude Code + Bill

---

## 0. 核心问题

Chorus 的后端 ASR + SV + SD 管线从未完整跑通过。根因分析如下：

| 症状 | 根因 | 影响 |
|------|------|------|
| local_asr 阶段持续 timeout | faster-whisper 在 Apple Silicon 上只能 CPU 回退（CTranslate2 不支持 MPS），RTF ≈ 1.0 | 10 分钟面试需要 10 分钟处理 |
| 说话人分段不精确 | pyannote SD 代码存在但未接入 finalization 管线（`/sd/diarize` 返回 501） | 只有粗粒度 SV 聚类，无精确时间戳级分段 |
| Tier 2 不工作 | `TIER2_ENABLED=false`（默认关闭），且依赖 faster-whisper + pyannote 都正常 | 无法产出精调报告 |
| FunASR 实时流不稳定 | DashScope 计费阻断 + WebSocket 超时 | 录制期间实时转录经常失败 |

**本设计方案的目标：让整条管线可验证地跑通。**

---

## 1. 设计原则

### 铁轨原则

```
Phase 1 (ASR 引擎替换)
    │
    ├── GATE 1: 基准测试通过 ──────────────────────── 不通过则停止
    │
Phase 2 (pyannote SD 接入)
    │
    ├── GATE 2: Tier 2 E2E 产出说话人归属转录 ─────── 不通过则停止
    │
Phase 3 (ONNX 统一运行时)
    │
    └── GATE 3: 全模型 ONNX 推理通过 ────────────── 不通过则停止
```

**规则：**

1. **前置门禁**：Phase N 的第一个任务必须先验证 Phase N-1 的 Gate 条件仍然成立
2. **回归锁**：每个 Task 完成后，运行该 Phase 的全部已通过测试，确认无回归
3. **单点替换**：每次只替换一个组件，替换后立即验证，不允许同时改两个组件
4. **回退路径**：每个替换都保留旧实现作为 config 可选回退，直到 Gate 通过后才移除

### 不可改动的核心组件（红线）

以下组件在整个设计期间**严禁修改**，任何改动必须单独提 PR 审查：

| 组件 | 文件 | 原因 |
|------|------|------|
| Report Synthesizer | `inference/app/services/report_synthesizer.py` | 核心竞争力，450+ 行 prompt |
| Report Generator | `inference/app/services/report_generator.py` | memo-first 降级保障 |
| Events Analyzer | `inference/app/services/events_analyzer.py` | 稳定，<1ms |
| Checkpoint Analyzer | `inference/app/services/checkpoint_analyzer.py` | 增量分析 |
| DashScope LLM Client | `inference/app/services/dashscope_llm.py` | 连接池 + 重试 |
| Global Clustering (TS) | `edge/worker/src/global-cluster.ts` | 数学正确 |
| finalize_v2 helpers | `edge/worker/src/finalize_v2.ts` | evidence + stats |
| Circuit Breaker | `edge/worker/src/inference_client.ts` | 故障转移 |

---

## 2. 阶段概览

| Phase | 名称 | 改动范围 | Gate 条件 | 依赖 |
|-------|------|---------|-----------|------|
| **Phase 1** | ASR 引擎替换 | inference 服务 | 10 分钟音频 < 60s 处理完成 | 无 |
| **Phase 2** | pyannote SD 接入 | inference + edge worker | Tier 2 产出 >90% 说话人归属 | Phase 1 Gate |
| **Phase 3** | ONNX 统一运行时 | inference 服务 | 全模型 ONNX 推理结果与 PyTorch 一致 | Phase 2 Gate |

**详细设计见：**
- [Phase 1: ASR 引擎升级](./2026-02-26-phase1-asr-engine-upgrade-design.md)
- [Phase 2: 说话人分段管线接入](./2026-02-26-phase2-speaker-diarization-wiring-design.md)
- [Phase 3: ONNX 统一运行时](./2026-02-26-phase3-onnx-unification-design.md)

---

## 3. Gate 验收规范

### GATE 1: ASR 引擎基准测试

**触发条件：** Phase 1 所有 Task 完成

**验收命令：**
```bash
cd inference
python -m pytest tests/test_sensevoice.py -v
python tests/benchmark_asr.py --audio samples/10min_interview_16k.wav --engine sensevoice
```

**必须满足的 5 个条件：**

| # | 条件 | 阈值 | 验证方式 |
|---|------|------|---------|
| G1.1 | SenseVoice 单元测试全部通过 | 0 failures | `pytest` exit code 0 |
| G1.2 | 10 分钟音频处理时间 | < 60 秒（RTF < 0.1） | benchmark 脚本输出 |
| G1.3 | 中文转录 WER | < 8%（AISHELL-1 test） | benchmark 脚本输出 |
| G1.4 | 英文转录 WER | < 5%（LibriSpeech test-clean） | benchmark 脚本输出 |
| G1.5 | `/asr/transcribe-window` 端点兼容性 | 响应 schema 与 Whisper 相同 | 集成测试 |

**不通过的处理：** 停止，不进入 Phase 2。排查 SenseVoice 模型加载、设备检测、或回退到 whisper.cpp + CoreML。

### GATE 2: Tier 2 说话人分段 E2E

**触发条件：** Phase 2 所有 Task 完成 + GATE 1 仍然通过

**前置检查（回归锁）：**
```bash
cd inference && python -m pytest tests/test_sensevoice.py -v  # GATE 1 回归检查
```

**验收命令：**
```bash
# 启动推理服务
cd inference && uvicorn app.main:app --port 8000 &

# Tier 2 批处理 E2E
curl -X POST http://localhost:8000/batch/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $INFERENCE_API_KEY" \
  -d '{"audio_url": "/tmp/audio/test_3speakers_10min.wav", "num_speakers": 3, "language": "auto"}'
```

**必须满足的 5 个条件：**

| # | 条件 | 阈值 | 验证方式 |
|---|------|------|---------|
| G2.1 | `/batch/process` 返回 200 | HTTP 200 | curl 响应码 |
| G2.2 | 说话人归属覆盖率 | > 90% utterances 有 speaker != "_unknown" | 脚本统计 |
| G2.3 | 检测到的说话人数量 | 与预期一致（±1） | 响应中 speaker_stats 长度 |
| G2.4 | 处理时间（10 分钟音频） | < 5 分钟（MPS）/ < 2 分钟（CUDA） | 响应中 total_processing_time_ms |
| G2.5 | GATE 1 回归检查 | 全部通过 | pytest exit code 0 |

**不通过的处理：** 停止，不进入 Phase 3。排查 pyannote 模型加载、HF_TOKEN 配置、或 MPS 兼容性。

### GATE 3: ONNX 运行时验证

**触发条件：** Phase 3 所有 Task 完成 + GATE 1 + GATE 2 仍然通过

**前置检查（回归锁）：**
```bash
cd inference
python -m pytest tests/test_sensevoice.py -v      # GATE 1
python -m pytest tests/test_batch_process.py -v    # GATE 2
```

**验收命令：**
```bash
python tests/benchmark_onnx_parity.py
```

**必须满足的 5 个条件：**

| # | 条件 | 阈值 | 验证方式 |
|---|------|------|---------|
| G3.1 | SenseVoice ONNX vs PyTorch 输出一致 | 文本完全匹配 | parity 脚本 |
| G3.2 | CAM++ ONNX vs PyTorch embedding 距离 | cosine distance < 0.01 | parity 脚本 |
| G3.3 | ONNX 推理速度 | >= PyTorch 速度（不能更慢） | benchmark |
| G3.4 | 无 PyTorch 依赖运行 | `import torch` 不在 ONNX 路径中 | 代码审查 |
| G3.5 | GATE 1 + GATE 2 回归 | 全部通过 | pytest exit code 0 |

---

## 4. 交叉验证矩阵

每个 Task 完成后，不仅要验证自身，还要验证它对其他组件的影响：

| 被改动的组件 | 必须同时验证 | 验证方式 |
|-------------|-------------|---------|
| ASR 引擎 (SenseVoice) | `/asr/transcribe-window` 响应 schema | `tests/test_asr_endpoint.py` |
| ASR 引擎 (SenseVoice) | `/batch/transcribe` 响应 schema | `tests/test_batch_endpoint.py` |
| ASR 引擎 (SenseVoice) | Edge Worker `LocalWhisperASRProvider` 兼容性 | `edge/worker vitest` |
| pyannote 升级 | `/batch/diarize` 响应 schema | `tests/test_batch_endpoint.py` |
| pyannote 升级 | `/batch/process` merge 逻辑 | `tests/test_batch_process.py` |
| ONNX CAM++ | `/sv/extract_embedding` 响应 schema | `tests/test_sv.py` |
| ONNX CAM++ | `/speaker/resolve` cosine 距离一致性 | `tests/test_orchestrator.py` |
| config.py 改动 | 所有测试（全量回归） | `python -m pytest tests/ -v` |

---

## 5. 测试音频素材要求

在开始任何 Phase 之前，必须准备以下测试音频：

| 文件名 | 规格 | 用途 | 来源 |
|--------|------|------|------|
| `samples/10min_interview_16k.wav` | 16kHz mono PCM16, 10 分钟, 3 说话人 | GATE 1 + GATE 2 | 从已有 E2E 测试录音提取，或录制新的 |
| `samples/short_3s_zh.wav` | 16kHz mono, 3 秒中文 | 单元测试快速验证 | TTS 生成或手动录制 |
| `samples/short_3s_en.wav` | 16kHz mono, 3 秒英文 | 单元测试快速验证 | TTS 生成或手动录制 |
| `samples/silence_3s.wav` | 16kHz mono, 3 秒静音 | 边界情况测试 | 生成 |

**Task 0（前置任务）：** 准备测试音频并提交到 `inference/samples/`。此任务在 Phase 1 Task 1 之前完成。

---

## 6. 配置变量汇总

以下是本设计方案涉及的所有新增/修改配置变量：

| 变量名 | Phase | 默认值 | 可选值 | 文件 |
|--------|-------|--------|--------|------|
| `ASR_BACKEND` | 1 | `sensevoice` | `sensevoice`, `whisper`, `whisper-cpp` | `inference/.env` |
| `SENSEVOICE_MODEL_ID` | 1 | `iic/SenseVoiceSmall` | ModelScope 模型 ID | `inference/.env` |
| `SENSEVOICE_DEVICE` | 1 | `auto` | `auto`, `cuda`, `mps`, `cpu` | `inference/.env` |
| `ENABLE_DIARIZATION` | 2 | `true`（改） | `true`, `false` | `inference/.env` |
| `PYANNOTE_MODEL_ID` | 2 | `pyannote/speaker-diarization-community-1`（改） | pyannote HF 模型 ID | `inference/.env` |
| `HF_TOKEN` | 2 | 空 | HuggingFace token | `inference/.env` |
| `TIER2_ENABLED` | 2 | `true`（改） | `true`, `false` | `edge/worker wrangler.jsonc` |
| `TIER2_AUTO_TRIGGER` | 2 | `true`（改） | `true`, `false` | `edge/worker wrangler.jsonc` |
| `SV_BACKEND` | 3 | `onnx` | `onnx`, `modelscope` | `inference/.env` |
| `ASR_ONNX_MODEL_PATH` | 3 | `~/.cache/sensevoice-onnx/` | 本地路径 | `inference/.env` |
| `SV_ONNX_MODEL_PATH` | 3 | `~/.cache/campplus-onnx/` | 本地路径 | `inference/.env` |

---

## 7. 风险登记

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| SenseVoice 在 Apple Silicon 上性能不达预期 | 低 | 阻断 Phase 1 | 回退到 whisper.cpp + CoreML（已验证 RTF 0.08-0.30） |
| pyannote 4.0 community-1 模型需要新的 HF license 接受 | 中 | 阻断 Phase 2 | 提前在 HuggingFace 上接受 license |
| pyannote MPS 支持不完整（部分 PyTorch op 回退 CPU） | 中 | 速度降级 | 接受 MPS 部分加速，Phase 3 ONNX 完全解决 |
| ONNX 导出后精度损失 | 低 | 阻断 Phase 3 | parity 测试 < 0.01 cosine distance，不通过则保持 PyTorch |
| FunASR 依赖与 SenseVoice 版本冲突 | 中 | 阻断 Phase 1 | 独立虚拟环境测试，明确锁定版本 |

---

## 8. 时间线

| 阶段 | 预计时间 | 前置条件 |
|------|---------|---------|
| Task 0: 准备测试音频 | 0.5 天 | 无 |
| Phase 1: ASR 引擎替换 | 3-5 天 | Task 0 |
| GATE 1 验收 | 0.5 天 | Phase 1 |
| Phase 2: pyannote SD 接入 | 3-4 天 | GATE 1 通过 |
| GATE 2 验收 | 0.5 天 | Phase 2 |
| Phase 3: ONNX 统一运行时 | 4-5 天 | GATE 2 通过 |
| GATE 3 验收 | 0.5 天 | Phase 3 |

**总计：12-16 天**（不含风险缓冲）
