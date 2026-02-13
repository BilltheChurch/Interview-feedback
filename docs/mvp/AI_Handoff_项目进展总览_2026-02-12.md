# AI Handoff：项目进展总览（2026-02-12）

## 0. 快照信息（严格基于当前仓库）
- 仓库路径：`/Users/billthechurch/Interview-feedback`
- 当前主线最新提交：`bf97970 feat: add enrollment pipeline and manual cluster mapping`
- 最近关键提交：
  - `8d6a3ce fix: tighten name extraction and improve echo suppression diagnostics`
  - `d51e6d2 feat(phase2.3): add capture recovery, echo suppression, and config UX overhaul`
  - `61b58ee Phase 2.3: switch to realtime ASR pipeline, add session config/events APIs, and desktop live UI`
- 当前工作区（未提交）：
  - `M /Users/billthechurch/Interview-feedback/desktop/main.js`
  - `M /Users/billthechurch/Interview-feedback/desktop/renderer.js`
  - 未跟踪样本音频：`/Users/billthechurch/Interview-feedback/samples/*.m4a|*.wav`

## 1. 我们已经做了什么（已落地）

### 1.1 Inference（FastAPI，SV/聚类/绑定）
实现位置：
- `/Users/billthechurch/Interview-feedback/inference/app/main.py`
- `/Users/billthechurch/Interview-feedback/inference/app/services/orchestrator.py`
- `/Users/billthechurch/Interview-feedback/inference/app/services/sv.py`
- `/Users/billthechurch/Interview-feedback/inference/app/services/clustering.py`
- `/Users/billthechurch/Interview-feedback/inference/app/services/name_resolver.py`

已实现能力：
- `GET /health`
- `POST /sv/extract_embedding`
- `POST /sv/score`
- `POST /speaker/resolve`
- `POST /speaker/enroll`（Phase 2.3.1 新增）
- `POST /sd/diarize`（保留接口，返回 501）

关键行为：
- 音频统一转 `16k/mono/pcm_s16le` 后进入 VAD+SV。
- students 识别顺序已升级：
  - `locked manual binding > existing binding > enrollment profile > roster name extract > unknown`
- 已修复策略语义漏洞：不允许 `decision=confirm` 且 `speaker_name=null`。

模型与阈值：
- SV 模型：`iic/speech_campplus_sv_zh_en_16k-common_advanced`
- ASR 模型（Worker 侧）：`fun-asr-realtime-2025-11-07`
- profile 默认阈值：`AUTO>=0.72`、`CONFIRM>=0.60`、`margin>=0.08`

### 1.2 Worker（Cloudflare Worker + DO + R2）
实现位置：
- `/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts`
- `/Users/billthechurch/Interview-feedback/edge/worker/wrangler.jsonc`

已实现能力：
- 双流 WebSocket ingest：
  - `GET /v1/audio/ws/:session_id`
  - `GET /v1/audio/ws/:session_id/:stream_role`（`teacher|students`）
- 会话与转写查询：
  - `GET /v1/sessions/:id/state`
  - `GET /v1/sessions/:id/utterances?stream_role=&view=raw|merged`
  - `GET /v1/sessions/:id/events`
- ASR 维护：
  - `POST /v1/sessions/:id/asr-run`（离线补算）
  - `POST /v1/sessions/:id/asr-reset`
- Phase 2.3.1 新增：
  - `POST /v1/sessions/:id/enrollment/start`
  - `POST /v1/sessions/:id/enrollment/stop`
  - `GET /v1/sessions/:id/enrollment/state`
  - `POST /v1/sessions/:id/cluster-map`
  - `GET /v1/sessions/:id/unresolved-clusters`

已切换主链：
- 实时 ASR 为常驻 WS（不再用 10s 窗口重放作为实时主链）。
- `asr-run` 保留为历史补算工具。

状态与产物：
- DO 里维护 `ingest_by_stream`、`asr_by_stream`、`capture_by_stream`。
- `finalize` 产出 `result.json` 到 R2。
- `utterances` 支持 `raw` 与 `merged` 视图。

### 1.3 Desktop（Electron 双流采集）
实现位置：
- `/Users/billthechurch/Interview-feedback/desktop/index.html`
- `/Users/billthechurch/Interview-feedback/desktop/renderer.js`
- `/Users/billthechurch/Interview-feedback/desktop/main.js`

已实现能力：
- 双输入采集：`mic(teacher)` + `system(students)`。
- 双 WS 上传（1s chunk）。
- system audio 自动恢复状态机：`running/recovering/failed`。
- teacher 去串音抑制（相关性 + RMS 规则）。
- Session Config UI 去 JSON 化（participants 列表可增删）。
- Enrollment Start/Stop + unresolved cluster 手动映射 UI。

网络入口：
- Inference：`https://if.frontierace.ai`
- Worker：`https://api.frontierace.ai`

## 2. 我们还没做什么（明确未完成）
来源：`/Users/billthechurch/Interview-feedback/Task.md`

未完成门禁（必须实测闭环）：
- 真实 Teams 5~10 分钟实机验证（延迟门禁）。
- 真实 Teams 容错验证（system/mic track ended 后可恢复）。
- 无耳机场景重复转写率下降目标（>=60%）尚未验收打勾。
- Phase 2.3.1 实机门禁：
  - `students unknown_ratio <= 15%`
  - 手动映射后 unresolved cluster = 0
  - `confirm_without_name_count = 0`（实机统计口径）

## 3. 开发思路（当前真实执行路径）
- 原则：本地优先，先跑通端到端，再做云侧分层。
- 当前分层：
  - Desktop 负责采集与上报
  - Worker/DO 负责会话编排、实时 ASR、事件与状态
  - Inference 负责 SV/聚类/身份判定（含 enrollment profile）
- Diarization 策略：接口已预留，可插拔；当前主链不依赖 diarization 模型。
- 识别收敛策略：
  - 自动链路（profile + name extract）
  - 失败可回退人工映射（manual map + lock）

## 4. 当前验证状态（本次快照复核）
本次复核命令与结果：
- `cd /Users/billthechurch/Interview-feedback/inference && pytest -q` -> `22 passed`
- `cd /Users/billthechurch/Interview-feedback/edge/worker && npm run typecheck` -> 通过
- `cd /Users/billthechurch/Interview-feedback/desktop && node --check renderer.js main.js preload.js` -> 通过

## 5. 给其他 AI 的上下文重点
当你在 ChatGPT Web 等工具继续讨论方案时，请直接提供以下事实：
1. 实时主链已经不是 window replay，而是 per-stream long-lived ASR websocket。
2. students 识别已经接入 enrollment + manual mapping，且 API 已落地。
3. 当前关键问题不在“能不能跑通”，而在“实机 SLO 与身份收敛率门禁”。
4. 讨论新方案时必须兼容既有 API（尤其 `state/events/utterances/finalize`）。
