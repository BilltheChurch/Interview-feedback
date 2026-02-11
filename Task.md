# Task Tracking (Strictly Aligned With PRD / 开发计划 / 快速启动指南)

Last Updated: 2026-02-11
Workspace: `/Users/billthechurch/Interview-feedback`

## 0. 文档基线（执行必须对齐）
- `/Users/billthechurch/Interview-feedback/docs/source/PRD_实时群面记录系统_英文版.md`
- `/Users/billthechurch/Interview-feedback/docs/source/开发计划.md`
- `/Users/billthechurch/Interview-feedback/docs/source/快速启动指南.md`
- `/Users/billthechurch/Interview-feedback/docs/source/开工行动清单_MVP-A_从零开始_v2.0.md`
- `/Users/billthechurch/Interview-feedback/docs/mvp/*.md`

## 1. 当前阶段
- Current Phase: **Phase 2.3（双流上传 + ASR 联动）**
- Why: Phase 2.2（FunASR 模型纠偏 + 全量补算）已完成，进入双流协议与说话人联动阶段。

## 2. 里程碑总览（来自《开发计划》）
- Phase 0: 账号/环境
  - Status: **COMPLETED**
  - Done:
    - Cloudflare + Wrangler 登录可用
    - Inference 固定域名可用：`https://if.frontierace.ai`
    - Worker 自定义域名可用：`https://api.frontierace.ai`
    - `ALIYUN_DASHSCOPE_API_KEY` 已配置，Fun-ASR realtime 首轮 smoke 已通过
- Phase 1: 音频采集与上传
  - Status: **COMPLETED**
- Phase 2: ASR 实时转写
  - Status: **IN_PROGRESS**
  - Done:
    - Worker/DO 已实现 ASR 窗口任务框架（window/hop 可配置）
    - 已新增 `asr-run` 与 `utterances` 调试接口
    - DashScope key 已配置并完成线上 smoke（`utterance_count` 增长、`last_error=null`）
    - Phase 2.2 首轮完成：`ASR_HOP_SECONDS` 默认下调到 `3s`，并新增 `avg_window_latency_ms/avg_rtf` 指标
    - 模型已纠偏并固定：`fun-asr-realtime-2025-11-07`
    - 已完成 `asr-reset` + 历史会话 `soak-20260211-02` 全量补算（`last_window_end_seq=325`）
    - 已实现双流 WS 协议：`/v1/audio/ws/:session_id/:stream_role`
    - 已实现 `utterances view=raw|merged` 与 `state` 的 `*_by_stream` 字段
    - students 自动 `/speaker/resolve` 链路已接入（失败事件隔离，不阻断 ASR）
    - 已完成 Phase 2.3 紧急重构：主链切换为 `realtime`（常驻 ASR WS，不再依赖 10s 窗口轮询）
    - 已新增 `POST /v1/sessions/:id/config` 与 `GET /v1/sessions/:id/events`
    - `asr_by_stream` 已扩展 `mode/asr_ws_state/backlog_chunks/ingest_lag_seconds/last_emit_at/p50/p95`
    - `merged v2` 已上线（token overlap + 近似重复合并）
    - teacher 身份优先级已落地：`Teams参会者 > 会前配置 > 转写抽名 > teacher`
  - Pending:
    - 在真实 Teams 双流会话中完成 5~10 分钟端到端验证（teacher/students）
    - 实机会中验证 `P95<=5s`（目标 `<=3s`）并固化性能门禁
- Phase 3: 说话人日志 + enrollment
  - Status: **PARTIAL**
  - Done:
    - Inference MVP-A（VAD+SV+聚类+姓名绑定）
  - Pending:
    - 与 Electron/ASR 端到端联动、映射 UI
- Phase 4: 反馈模式
  - Status: **TODO**

## 3. 当前阶段任务（Phase 2.3）
Source: `/Users/billthechurch/Interview-feedback/docs/source/开发计划.md`

- [x] Worker 主链改为实时 ASR（常驻 WS），替代每窗重建连接
- [x] 新增 `POST /config`（teams_participants/interviewer 配置）
- [x] 新增 `GET /events`（speaker events + identity_source）
- [x] `asr_by_stream` 新增实时指标（mode/ws_state/backlog/lag/p50/p95）
- [x] merged v2（token overlap + 近似去重）替换旧 exact-match 去重
- [x] teacher 身份优先级落地（Teams参会者 > 会前配置 > 转写抽名 > teacher）
- [x] Desktop UI 增加 Session Config + Live Transcript + Speaker Events
- [x] 双流并发 ingest 一致性修复（同 session teacher/students 不互相覆盖）
- [x] Desktop 断流容错：单路 track ended 时不再强制全局 stop upload，改为 degraded 模式并允许手动 re-init 恢复

### Phase 2.3 验收标准（当前）
- [x] `health` 显示 `asr_realtime_enabled=true`
- [x] 双流并发 smoke 下 teacher/students 均 `received_chunks` 连续增长
- [x] 实时语音样例可产出 utterance，且 `ingest_to_utterance_p50_ms` 可读
- [x] merged 视图与 raw 产生差异（重叠文本场景）
- [x] teacher 事件 `identity_source` 命中优先级
- [ ] 真实 Teams 5~10 分钟实机验证（含 latency 门禁）
- [ ] 真实 Teams 容错验证：手动触发 system/mic track ended 后，另一流持续上传且可 re-init 恢复双流

## 4. 已完成基础能力（供后续阶段复用）
- [x] Inference FastAPI + Docker + 模型版本固定 + smoke 回归
- [x] Inference 生产防护：API Key、请求体上限、限流、健康可观测字段
- [x] 固定 Cloudflare Tunnel 域名绑定 + 运行脚本
- [x] Worker + Durable Object + R2 骨架
- [x] Worker Custom Domain 绑定：`api.frontierace.ai`
- [x] Worker WebSocket ingest（1s chunk）+ DO 顺序统计 + R2 chunk 落盘

## 5. 最新验证记录（完成后才允许打勾）
Validation Date: 2026-02-11

- [x] `curl https://if.frontierace.ai/health` -> 200 + JSON
- [x] `curl https://api.frontierace.ai/health` -> 200 + JSON
- [x] `cd inference && pytest -q` -> `13 passed`
- [x] `python scripts/smoke_sv.py --base-url https://if.frontierace.ai --samples ./samples` -> `smoke_sv passed`
- [x] `cd desktop && npm run normalize:smoke` -> `Alice.m4a/Bob.m4a` 均转码为 `16k mono pcm_s16le` 且校验通过
- [x] `cd desktop && node --check main.js preload.js renderer.js lib/audioPipeline.js scripts/normalize_smoke.js` -> 语法检查通过
- [x] `cd edge/worker && npm run typecheck` -> 通过（含 WebSocket ingest + DO/R2 逻辑）
- [x] `node scripts/ws_ingest_smoke.mjs --base-http http://127.0.0.1:8787 --base-ws ws://127.0.0.1:8787 --chunks 3` -> 3/3 ACK，`missing_chunks=0`，`bytes_stored=96000`
- [x] `cd edge/worker && npm run deploy` -> 已发布新版本（Version ID: `460ddc27-d345-4f58-95bd-6559ec8dff3d`）
- [x] `node scripts/ws_ingest_smoke.mjs --base-http https://api.frontierace.ai --base-ws wss://api.frontierace.ai --chunks 3` -> 3/3 ACK，公网联调通过
- [x] `POST /v1/sessions/soak-20260211-01/finalize` -> `sessions/soak-20260211-01/result.json`
- [x] `node scripts/export_r2_session_audio.mjs --session-id soak-20260211-01 ...` -> `135 chunks`, `local_missing_chunks=0`, `duration_sec=135`, 输出 WAV：
  - `/Users/billthechurch/Interview-feedback/artifacts/r2-export/soak-20260211-01/soak-20260211-01.wav`
- [x] Teams 实机验证（双路）：
  - 远端说话时 `System level` 明显变化
  - 本地说话时 `Mic level` 明显变化
  - `Mixed level` 与 WS ACK 连续增长
- [x] `GET /v1/sessions/soak-20260211-02/state` -> `last_seq=325`, `missing_chunks=0`, `duplicate_chunks=0`
- [x] `POST /v1/sessions/soak-20260211-02/finalize` -> `sessions/soak-20260211-02/result.json`
- [x] `node scripts/export_r2_session_audio.mjs --session-id soak-20260211-02 ...` -> `325 chunks`, `local_missing_chunks=0`, `duration_sec=325`, 输出 WAV：
  - `/Users/billthechurch/Interview-feedback/artifacts/r2-export/soak-20260211-02/soak-20260211-02.wav`
- [x] `cd edge/worker && npm run typecheck`（Phase 2 代码）-> 通过
- [x] 本地回归：`node scripts/ws_ingest_smoke.mjs --base-http http://127.0.0.1:8787 --base-ws ws://127.0.0.1:8787 --chunks 3` -> 3/3 ACK
- [x] 新接口验证：`POST /v1/sessions/:id/asr-run` 与 `GET /v1/sessions/:id/utterances` 可访问
- [x] `cd edge/worker && npm run deploy` -> 已发布新版本（Version ID: `8c62be63-8ca7-4e81-92d3-f6b05e5e7f35`）
- [x] `curl https://api.frontierace.ai/health` -> `asr_enabled=true`，provider=`dashscope`
- [x] `python3 scripts/smoke_asr_worker.py --base-url https://api.frontierace.ai --session-id soak-20260211-02 --min-utterances 1 --max-windows 1` ->
  - `asr-run` 返回 `generated=1`
  - `utterance_count` 从 `1` 增长到 `2`
  - `last_error=null`
  - `smoke_asr_worker passed`
- [x] `cd edge/worker && npm run typecheck`（Phase 2.2 metrics + 3s hop）-> 通过
- [x] `cd edge/worker && npm run deploy` -> 已发布新版本（Version ID: `5f14616a-255d-4966-b1e2-bfad47f233eb`）
- [x] `curl https://api.frontierace.ai/health` -> `asr_window_seconds=10`, `asr_hop_seconds=3`
- [x] `python3 scripts/smoke_asr_worker.py --base-url https://api.frontierace.ai --session-id soak-20260211-02 --min-utterances 2 --max-windows 1` ->
  - `asr-run` 返回 `generated=1`, `last_window_end_seq=23`
  - `total_windows_processed=1`, `avg_window_latency_ms=11412`, `avg_rtf=1.1412`
  - `utterances.count=3`, `smoke_asr_worker passed`
- [x] `cd edge/worker && npm run typecheck`（Phase 2.3: 双流 + asr-reset + merged 视图）-> 通过
- [x] `cd edge/worker && npm run deploy` -> 已发布新版本（Version ID: `5508b4b7-4d45-498e-ac5c-f87f6f3de0aa`）
- [x] `cd edge/worker && npm run deploy`（students resolve 失败隔离修复）-> 已发布（Version ID: `f53aa950-9e5e-41f4-ad7f-fd02e343900f`）
- [x] `cd edge/worker && npm run deploy`（teacher 空文本不落日志）-> 已发布（Version ID: `bd27da11-4b78-48a1-b1e9-e2d76e14a5ee`）
- [x] `curl https://api.frontierace.ai/health` -> `asr_model=fun-asr-realtime-2025-11-07`，`stream_roles=[mixed,teacher,students]`
- [x] 双流 WS smoke（本地）：
  - `node scripts/ws_ingest_smoke.mjs ... --stream-role mixed` -> 3/3 ACK
  - `node scripts/ws_ingest_smoke.mjs ... --stream-role teacher` -> 3/3 ACK
  - `node scripts/ws_ingest_smoke.mjs ... --stream-role students` -> 3/3 ACK
- [x] 双流 WS smoke（公网）：
  - `node scripts/ws_ingest_smoke.mjs --base-http https://api.frontierace.ai --base-ws wss://api.frontierace.ai --session-id ws-remote-teacher-20260211 --chunks 3 --stream-role teacher` -> 3/3 ACK
  - `node scripts/ws_ingest_smoke.mjs --base-http https://api.frontierace.ai --base-ws wss://api.frontierace.ai --session-id ws-remote-students-20260211 --chunks 3 --stream-role students` -> 3/3 ACK
- [x] `POST /v1/sessions/ws-phase23-verify/asr-reset?stream_role=mixed` -> 清空 ASR/utterances，保留 chunks
- [x] `GET /v1/sessions/ws-phase23-verify/utterances?stream_role=mixed&view=raw|merged` -> 两种视图可访问
- [x] `POST /v1/sessions/ws-phase23-verify/finalize` + `wrangler r2 object get --remote` ->
  - `result.json` 含 `ingest_by_stream`
  - `result.json` 含 `asr_by_stream`
  - `result.json` 含 `utterances_raw_by_stream`
  - `result.json` 含 `utterances_merged_by_stream`
- [x] 历史会话全量补算（`soak-20260211-02`）：
  - `python3 scripts/backfill_asr_session.py --base-url https://api.frontierace.ai --session-id soak-20260211-02 --stream-role mixed --batch-windows 5 --reset-first`（启动）
  - `python3 -u scripts/backfill_asr_session.py ... --batch-windows 3`（续跑完成）
  - 结果：`last_window_end_seq=325`，`utterance_count=106`，`model=fun-asr-realtime-2025-11-07`，`last_error=null`
- [x] `POST /v1/sessions/soak-20260211-02/finalize` + R2 校验 ->
  - `result.json` 中 `utterances_raw_by_stream.mixed=106`
  - `result.json` 中 `utterances_merged_by_stream.mixed=106`
  - `result.json` 中 `asr_by_stream.mixed.last_window_end_seq=325`
- [x] `python3 scripts/smoke_asr_worker.py --base-url https://api.frontierace.ai --session-id soak-20260211-02 --stream-role mixed --view raw --min-utterances 100 --max-windows 1` -> passed
- [x] `python3 scripts/smoke_asr_worker.py --base-url https://api.frontierace.ai --session-id soak-20260211-02 --stream-role mixed --view merged --min-utterances 100 --max-windows 1` -> passed
- [x] `cd edge/worker && npm run typecheck`（Phase 2.3 realtime refactor）-> 通过
- [x] `cd desktop && node --check renderer.js main.js preload.js`（Phase 2.3 UI）-> 通过
- [x] `cd edge/worker && npm run deploy`（realtime ASR + /config + /events + merged v2）-> 已发布（Version ID: `c44e335f-67d8-41b0-ae89-4e4ff1916ba0`）
- [x] `cd edge/worker && npm run deploy`（realtime close/final emit 修复）-> 已发布（Version ID: `05fe7b56-39e2-446b-a53b-d0471dec49dc`）
- [x] `curl https://api.frontierace.ai/health` -> 包含 `asr_realtime_enabled=true`, `asr_mode=realtime`
- [x] `POST /v1/sessions/realtime-check-20260211/config` -> roster/config 写入成功
- [x] `GET /v1/sessions/realtime-check-20260211/events?limit=5` -> 新接口可访问
- [x] 双流并发 WS smoke（公网，同一 session）：
  - `node scripts/ws_ingest_smoke.mjs --base-http https://api.frontierace.ai --base-ws wss://api.frontierace.ai --session-id realtime-check-20260211-racefix2 --stream-role teacher --chunks 6` -> pass
  - `node scripts/ws_ingest_smoke.mjs --base-http https://api.frontierace.ai --base-ws wss://api.frontierace.ai --session-id realtime-check-20260211-racefix2 --stream-role students --chunks 6` -> pass
  - `GET /v1/sessions/realtime-check-20260211-racefix2/state` -> teacher/students `received_chunks=6`
- [x] `GET /v1/sessions/soak-20260211-02/utterances?view=merged` -> `count=68`（`raw=106`），且出现 `source_utterance_ids.length>1`
- [x] 兼容回归：`python3 scripts/smoke_asr_worker.py --base-url https://api.frontierace.ai --session-id soak-20260211-02 --stream-role mixed --view merged --min-utterances 50 --max-windows 1` -> passed
- [x] realtime teacher 语音样例上传（`samples/alice_probe.wav`）：
  - 会话 `realtime-speech-1770811454091`
  - `teacher raw_count=1`, `merged_count=1`
  - `last_window_latency_ms=474`, `ingest_to_utterance_p50_ms=474`
- [x] teacher 身份优先级验收（Teams 参会者优先）：
  - 会话 `realtime-teacherid-1770811488744`
  - `events[0].identity_source=teams_participants`
  - `events[0].speaker_name=Bill`
- [x] students 自动 resolve 失败隔离验收：
  - 会话 `realtime-students-1770811517481`
  - `students utterances=1`（ASR 主链不被阻断）
  - 失败事件按预期写入：`decision=unknown`, `note` 含 inference 530
- [x] inference 公网恢复验收（Tunnel 稳定）：
  - `curl https://if.frontierace.ai/health` -> `HTTP 200`
  - 本地 `http://127.0.0.1:8000/health` 与公网健康字段一致
- [x] students 自动 resolve 恢复验收：
  - 会话 `students-e2e3-1770812727878`
  - `GET /state` -> `asr_by_stream.students.utterance_count=1`, `ingest_to_utterance_p50_ms=693`
  - `GET /events?stream_role=students` -> `decision=confirm`, `cluster_id=c1`
- [x] teacher 身份事件回归验收：
  - 会话 `teacher-e2e-1770812809368`
  - `GET /events?stream_role=teacher` -> `identity_source=preconfig`, `speaker_name=Bill`
- [x] 会话 `teams-test1` 结果确认：
  - `ingest_by_stream.teacher.received_chunks=275`, `students.received_chunks=273`, `missing_chunks=0`
  - `asr_by_stream.teacher.ingest_to_utterance_p95_ms=1464`
  - `asr_by_stream.students.ingest_to_utterance_p95_ms=1406`
  - `POST /v1/sessions/teams-test1/finalize` -> `sessions/teams-test1/result.json`
- [x] students resolve 长音频保护（>30s 自动裁剪）：
  - Worker 已部署（Version ID: `b0cbc364-f86f-427c-b44e-a5cc97333728`）
  - 会话 `students-long-1770814903849`：`events` 正常产出，无 `422 audio duration exceeds 30s`

## 6. 当前阻塞与处理
- `pnpm` 在 Node v25 + corepack 环境出现签名校验错误（keyid mismatch）。
- 当前已使用 `npm install` 完成 `desktop` 依赖安装与验证，不影响本阶段代码开发。
- 当前无 Phase 2.1 阻塞；进入 Phase 2.2 参数调优与 Phase 2.3 链路联动。
- inference 可用性已恢复（Cloudflare Tunnel 改为 `http2` 稳定链路）：
  - `if.frontierace.ai` 健康检查恢复为稳定 200
  - students 自动 resolve 已恢复
  - 保留主链隔离（即使 inference 异常也不阻断 ASR）

## 7. 更新规则（强制执行）
每次开发迭代必须按以下顺序更新：
1. 先实现代码（严格按文档阶段目标）
2. 再执行验证（写明命令与结果）
3. 最后更新本 `Task.md`：
   - 当前阶段状态
   - 任务勾选
   - 验收勾选
   - 最新验证记录

未通过验证的任务，不允许标记为完成。

## 8. 下一步（立即执行）
- Phase 2.3 实机验收：桌面端真实 Teams 双流上传（teacher/students）5~10 分钟，确认 `asr_by_stream` 延迟指标。
- Phase 2.3 实机身份验收：检查 teacher 事件 `identity_source` 命中顺序（Teams参会者优先）。
- Phase 2.4：Graph 自动拉取参会者（企业应用 + OAuth + attendees）接入 `teams_participants`。
