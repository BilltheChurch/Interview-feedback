# Phase 2/3：Worker + DO + R2 联调手册（Realtime 版）

## 1. 目标

- 保持现有 Inference API 契约不变
- 网关层切换到 realtime ASR 主链
- 双流（teacher/students）稳定上传、状态可观测、结果可追溯

## 2. 目录

- Worker：`/Users/billthechurch/Interview-feedback/edge/worker`
- 入口：`/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts`
- 配置：`/Users/billthechurch/Interview-feedback/edge/worker/wrangler.jsonc`

## 3. 必要准备

```bash
cd /Users/billthechurch/Interview-feedback/edge/worker
npm install
wrangler whoami
```

Secrets:

```bash
wrangler secret put INFERENCE_BASE_URL
wrangler secret put INFERENCE_API_KEY
wrangler secret put ALIYUN_DASHSCOPE_API_KEY
```

## 4. 核心接口（本阶段）

- `GET /health`
- `GET /v1/audio/ws/:session_id`
- `GET /v1/audio/ws/:session_id/:stream_role`
- `POST /v1/sessions/:session_id/config`
- `POST /v1/sessions/:session_id/enrollment/start`
- `POST /v1/sessions/:session_id/enrollment/stop`
- `GET /v1/sessions/:session_id/enrollment/state`
- `GET /v1/sessions/:session_id/events?stream_role=...&limit=...`
- `POST /v1/sessions/:session_id/cluster-map`
- `GET /v1/sessions/:session_id/unresolved-clusters`
- `GET /v1/sessions/:session_id/state`
- `GET /v1/sessions/:session_id/utterances?stream_role=...&view=raw|merged&limit=...`
- `POST /v1/sessions/:session_id/resolve?stream_role=...`
- `POST /v1/sessions/:session_id/asr-reset?stream_role=...`
- `POST /v1/sessions/:session_id/asr-run?stream_role=...&max_windows=...`（补算）
- `POST /v1/sessions/:session_id/finalize`

## 5. 双流协议说明

### 5.1 WS 路由

- teacher：`/v1/audio/ws/<session_id>/teacher`
- students：`/v1/audio/ws/<session_id>/students`

### 5.2 帧约束

- `sample_rate=16000`
- `channels=1`
- `format=pcm_s16le`
- 单 chunk 大小 `32000 bytes`（1s）

### 5.3 会中配置下发

在 `hello` 或 `/config` 中写入：
- `teams_participants`（支持 `[{name,email?}]` 或 `["Alice","Bob"]`）
- `teams_interviewer_name`
- `interviewer_name`

Enrollment 启动请求（开场引导采样）：

```bash
curl -sS -X POST "https://api.frontierace.ai/v1/sessions/<session_id>/enrollment/start" \
  -H "content-type: application/json" \
  -d '{
    "participants":[{"name":"Alice"},{"name":"Bob"}],
    "interviewer_name":"Bill"
  }' | jq
```

WS 运行时可追加上报：
- `type=capture_status`（Desktop 采集健康指标）

## 6. 实时 ASR 状态字段

`state.asr_by_stream.<role>`：
- `mode`
- `asr_ws_state`
- `backlog_chunks`
- `ingest_lag_seconds`
- `last_emit_at`
- `ingest_to_utterance_p50_ms`
- `ingest_to_utterance_p95_ms`

`state.capture_by_stream.<role>`：
- `capture_state` (`idle|running|recovering|failed`)
- `recover_attempts`
- `last_recover_at`
- `last_recover_error`
- `echo_suppressed_chunks`（teacher）
- `echo_suppression_recent_rate`（teacher）

`state` 还包含：
- `participant_profiles`
- `cluster_binding_meta`
- `enrollment_state`

## 7. 联调步骤

1) 启动/部署 Worker。
2) `GET /health` 确认 `asr_realtime_enabled=true`。
3) `POST /config` 写会前名单与 interviewer。
4) teacher/students 各跑一轮 WS smoke。
5) `GET /state` 查看 `ingest_by_stream`、`asr_by_stream` 与 `capture_by_stream`。
6) `GET /utterances` 查看 `raw|merged`。
7) `GET /events` 查看 `identity_source`。
8) `POST /finalize`，在 R2 确认 `result.json`。
9) 对未绑定 cluster 使用 `GET /unresolved-clusters` + `POST /cluster-map` 做人工兜底。

## 8. 验收重点

- 双流并行上传无覆盖（teacher/students 都有连续 seq）
- merged 视图生效（不是 raw 等量拷贝）
- teacher 事件身份来源可追踪（`identity_source`）
- students 自动 resolve 失败不阻断 ASR 主链
- capture 状态可追踪（students 自动恢复计数、teacher 去串音抑制计数）
- 事件阅读口径：
  - `decision=confirm` 不允许 `speaker_name=null`（Inference 已强约束）
  - 手动映射后应出现 `identity_source=manual_map` 且 `cluster_binding_meta.<id>.locked=true`
