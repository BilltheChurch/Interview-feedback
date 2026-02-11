# Phase 2/3/4：Worker + Durable Object + R2 联调手册

## 1. 目标

在不改动 Inference API 契约的前提下，增加 Cloudflare 网关层：

- Worker：统一公网入口、鉴权、路由
- Durable Object：按 `session_id` 持久化会话状态与事件
- R2：面试结束写入 `result.json`

## 2. 目录

- Worker 工程：`/Users/billthechurch/Interview-feedback/edge/worker`
- 主入口：`/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts`
- 配置：`/Users/billthechurch/Interview-feedback/edge/worker/wrangler.jsonc`

## 3. 先决条件

```bash
cd /Users/billthechurch/Interview-feedback/edge/worker
npm install
wrangler whoami
```

若未登录：

```bash
wrangler login
```

## 4. 资源准备

### 4.1 创建 R2 bucket

```bash
wrangler r2 bucket create interview-feedback-results
```

### 4.2 配置 Worker secrets

```bash
wrangler secret put INFERENCE_BASE_URL
wrangler secret put INFERENCE_API_KEY
```

说明：
- `INFERENCE_BASE_URL` 建议填固定 tunnel 域名，例如 `https://api.<your-domain>`。
- `INFERENCE_API_KEY` 必须与 `inference/.env.production` 保持一致。

## 5. 本地联调

```bash
npm run dev
```

检查：

```bash
curl -s http://localhost:8787/health | jq
```

## 6. 网关接口

- `GET /health`
- `GET /v1/audio/ws/:session_id`（WebSocket）
  - 客户端发送 `type=chunk` 帧：`meeting_id/seq/timestamp_ms/sample_rate/channels/format/content_b64`
  - Worker/DO 校验：`16000/1ch/pcm_s16le/32000 bytes`
  - 写入 R2：`sessions/<session_id>/chunks/<seq>.pcm`
  - 服务端返回 `ack` 与 `status`（含 `missing_chunks/duplicate_chunks/bytes_stored`）
- `POST /v1/sessions/:session_id/resolve`
  - 入参：`{ audio, asr_text?, roster? }`
  - 行为：DO 读取状态 -> 调用 inference `/speaker/resolve` -> 写回 updated_state + event
- `GET /v1/sessions/:session_id/state`
  - 返回当前 session state 与 event_count
- `POST /v1/sessions/:session_id/finalize`
  - 将 `{ state, events, metadata }` 写入 `sessions/<session_id>/result.json`

## 7. 部署

```bash
npm run deploy
```

首次部署会自动应用 `MeetingSessionDO` 的 `v1` migration。

## 8. 推荐联调顺序

1. `Worker /health` 返回 200
2. `node scripts/ws_ingest_smoke.mjs --base-http http://127.0.0.1:8787 --base-ws ws://127.0.0.1:8787 --chunks 3` 通过
3. `POST /v1/sessions/:id/resolve` 能产出 decision
4. `GET /v1/sessions/:id/state` 可读到 DO 中 state/ingest
5. `POST /v1/sessions/:id/finalize` 后，在 R2 中确认 `result.json`
