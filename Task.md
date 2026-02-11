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
- Current Phase: **Phase 1（音频采集与上传）**
- Why: 按《开发计划》阶段顺序，完成基础服务后，下一阶段应进入 Electron 端音频采集 + 上传 R2（连续 5 分钟不断流）。

## 2. 里程碑总览（来自《开发计划》）
- Phase 0: 账号/环境
  - Status: **PARTIAL**
  - Done:
    - Cloudflare + Wrangler 登录可用
    - Inference 固定域名可用：`https://if.frontierace.ai`
    - Worker 自定义域名可用：`https://api.frontierace.ai`
  - Pending:
    - `ALIYUN_DASHSCOPE_API_KEY` 及 Fun-ASR realtime 验证
- Phase 1: 音频采集与上传
  - Status: **IN_PROGRESS**
- Phase 2: ASR 实时转写
  - Status: **TODO**
- Phase 3: 说话人日志 + enrollment
  - Status: **PARTIAL**
  - Done:
    - Inference MVP-A（VAD+SV+聚类+姓名绑定）
  - Pending:
    - 与 Electron/ASR 端到端联动、映射 UI
- Phase 4: 反馈模式
  - Status: **TODO**

## 3. 当前阶段任务（Phase 1）
Source: `/Users/billthechurch/Interview-feedback/docs/source/开发计划.md`

- [x] Electron 框架（窗口、任务列表、会议页面）
- [x] 音频采集（先完成本地麦克风自检链路；ScreenCaptureKit 为下一迭代）
- [x] PCM 统一：16kHz / mono / s16le
- [x] WebSocket 上传（1s chunks）
- [x] R2 落盘（meeting_id/seq 连续）
- [x] 自检 UI（电平 + 回放）

### Phase 1 验收标准（必须全部通过）
- [ ] 连续 5 分钟上传不断流
- [ ] R2 `seq` 连续（允许极少丢包）
- [ ] 从 R2 合成 WAV 可清晰回放

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

## 6. 当前阻塞与处理
- `pnpm` 在 Node v25 + corepack 环境出现签名校验错误（keyid mismatch）。
- 当前已使用 `npm install` 完成 `desktop` 依赖安装与验证，不影响本阶段代码开发。

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
- Phase 1.6：补“5 分钟不断流”压测脚本与回放验证（从 R2 合成 WAV）。
- Phase 2.1：接入 Fun-ASR realtime（先 10s 窗口轮询，后收敛到 2–3s）。
