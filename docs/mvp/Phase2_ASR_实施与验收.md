# Phase 2 ASR 实施与验收（Realtime 主链）

## 1. 当前主链（已切换）

- ASR 模型固定：`fun-asr-realtime-2025-11-07`
- ASR 主链：`realtime`（每流常驻 WS，会中增量送音频）
- 回放补算：保留 `asr-run`（`window/hop`）仅用于历史补算，不作为实时路径

关键目标：
- 解决原窗口重放模式产生的 `~11s` 固有延迟
- 实时状态可观测（backlog/lag/ws_state）
- 会中采集健康可观测（capture_state/recovery/echo suppression）

## 2. 实时协议映射（Step 0 输出）

DashScope WS 事件映射（Worker 目前按以下策略解析）：
- `task-started`：流会话 ready
- `result-generated`：读取文本；若 `is_final/final/sentence_end/end_of_sentence` 非 `false`，落库为 final utterance
- `task-finished`：视为 final
- `task-failed`：记录 `last_error` 并触发重连

调试开关：
- `ASR_DEBUG_LOG_EVENTS=true` 时，Worker 会打印 `task-*` / `result-generated` payload 摘要日志。

## 3. 新增状态字段（`state.asr_by_stream.<role>`）

- `mode`: `realtime | windowed`
- `asr_ws_state`: `disconnected | connecting | running | error`
- `backlog_chunks`
- `ingest_lag_seconds`
- `last_emit_at`
- `ingest_to_utterance_p50_ms`
- `ingest_to_utterance_p95_ms`

## 3.1 采集健康字段（`state.capture_by_stream.<role>`）

- `capture_state`: `idle | running | recovering | failed`
- `recover_attempts`
- `last_recover_at`
- `last_recover_error`
- `echo_suppressed_chunks`（teacher）
- `echo_suppression_recent_rate`（teacher）

## 3.2 teams-test2 复盘与修正（2026-02-11）

已确认问题：
- 无耳机场景下 teacher/students 文本高重合，`teams-test2` 中重合比例约 `21/23`（students utterance 与 teacher 同时段高相似）。
- students 事件并非“后半段全 unknown”，真实统计是 `confirm=21`、`unknown=2`；但当 `speaker_name` 为空时 UI 显示为 `unknown`，造成误读。

已落地修正：
- Desktop 去串音改为双策略：
  - hard suppress：高相关强抑制
  - soft suppress：中相关 + RMS 比判定
  - teacher 主导保护：teacher RMS 显著高于 students 时不抑制，避免误杀
- Inference 姓名抽取规则收紧：过滤非姓名短语（如 `studying in...` / `from ...`）。
- Binder 增强：高置信度自我介绍姓名（`>=0.93`）可在 `confirm` 决策下固化到 cluster 绑定。
- Desktop Speaker Events 展示：无 `speaker_name` 时显示 `cluster:<id>`，避免视觉“全 unknown”。

## 4. merged v2（展示视图）

- `raw`：保持原始 utterance（不可改写）
- `merged`：重叠拼接与近似去重视图
  - token suffix/prefix overlap
  - 近似重复（包含、Jaccard 高相似）合并
- 预期：有重叠时 `merged.count < raw.count`

## 5. 核心接口

- `POST /v1/sessions/:id/config`
- `GET /v1/sessions/:id/events?stream_role=...&limit=...`
- `GET /v1/sessions/:id/state`
- `GET /v1/sessions/:id/utterances?stream_role=...&view=raw|merged&limit=...`
- `POST /v1/sessions/:id/asr-run?stream_role=...&max_windows=...`（补算）
- `POST /v1/sessions/:id/asr-reset?stream_role=...`

## 6. 验收命令

1) 健康检查：

```bash
curl -sS https://api.frontierace.ai/health | jq
```

应看到：
- `asr_realtime_enabled=true`
- `asr_mode="realtime"`

2) 配置会话（teacher 优先级输入）：

```bash
curl -sS -X POST "https://api.frontierace.ai/v1/sessions/<session_id>/config" \
  -H "content-type: application/json" \
  -d '{
    "teams_participants":["Bill","Alice"],
    "teams_interviewer_name":"Bill",
    "interviewer_name":"Bill Pre"
  }' | jq
```

3) 双流 ingest smoke：

```bash
node /Users/billthechurch/Interview-feedback/scripts/ws_ingest_smoke.mjs \
  --base-http https://api.frontierace.ai \
  --base-ws wss://api.frontierace.ai \
  --session-id <session_id> \
  --stream-role teacher \
  --chunks 6
```

```bash
node /Users/billthechurch/Interview-feedback/scripts/ws_ingest_smoke.mjs \
  --base-http https://api.frontierace.ai \
  --base-ws wss://api.frontierace.ai \
  --session-id <session_id> \
  --stream-role students \
  --chunks 6
```

4) 查看状态与事件：

```bash
curl -sS "https://api.frontierace.ai/v1/sessions/<session_id>/state" | jq
curl -sS "https://api.frontierace.ai/v1/sessions/<session_id>/events?limit=50" | jq
```

可额外检查：
- `state.capture_by_stream.students.capture_state`
- `state.capture_by_stream.students.recover_attempts`
- `state.capture_by_stream.teacher.echo_suppressed_chunks`

5) merged 视图差异：

```bash
curl -sS "https://api.frontierace.ai/v1/sessions/<session_id>/utterances?stream_role=mixed&view=raw&limit=20" | jq '.count'
curl -sS "https://api.frontierace.ai/v1/sessions/<session_id>/utterances?stream_role=mixed&view=merged&limit=20" | jq '.count'
```

## 7. 通过标准

- 主链不依赖 `asr-run` 也能持续产出实时 utterance（真实 Teams 会话）
- `state.asr_by_stream.<role>.mode=realtime`
- 有效语料下，`merged.count` 小于 `raw.count`
- teacher 事件具备 `identity_source` 且优先级符合：
  `teams_participants > preconfig > name_extract > teacher`
