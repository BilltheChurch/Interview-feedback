# Task Tracking (Strictly Aligned With PRD / 开发计划 / 快速启动指南)

Last Updated: 2026-06-27
Workspace: `/Users/billthechurch/Interview-feedback`

## 0. 文档基线（执行必须对齐）
- `/Users/billthechurch/Interview-feedback/docs/source/PRD_实时群面记录系统_英文版.md`
- `/Users/billthechurch/Interview-feedback/docs/source/开发计划.md`
- `/Users/billthechurch/Interview-feedback/docs/source/快速启动指南.md`
- `/Users/billthechurch/Interview-feedback/docs/source/开工行动清单_MVP-A_从零开始_v2.0.md`
- `/Users/billthechurch/Interview-feedback/docs/mvp/*.md`
- `/Users/billthechurch/Interview-feedback/docs/plans/*.md`

## 1. 当前阶段
- Current Phase: **Phase 6（架构重定向：云端化 + Companion + Speechmatics）**
- Why: Phase 5 实机验收暴露根本性架构问题——旧架构依赖"开发机本地推理（`if.frontierace.ai` tunnel，现 1033 不健康）+ 自建 CAM++ 说话人识别"，**无法满足"用户开箱即用、零本地部署"**。2026-06-27 决策重定向为：云 API 起步（Speechmatics 实时 STT + 实时 diarization）、Companion 优先、LLM 合成移入 Worker、删除自建 `inference/`。
- 设计基线：`docs/plans/2026-06-27-cloud-companion-speechmatics-architecture.md`
- 锁定决策：D1 云 API 起步 / D2 Companion 优先 / D3 Speechmatics / D4 说话人分离硬需求(1v1 & 群面同等重要) / D5 一次性交付 ≤3-5min / D6 MVP 零自建服务器
- **D7 迁移方式 = 渐进、纯云、零 GPU**（feature-flag 切换、验证后删旧码；生产全程不部署任何 GPU/服务器，旧 GPU 机器 if.frontierace.ai 退役）
- **D8 群面命名 = 匿名 diarization(S1/S2) + 自我介绍自动抽名 + 手动纠正兜底**（不做两段式重型 enrollment）
- **红队评审已完成（2026-06-27，6-agent）**：方向成立但 6 维度全 needs-adjustment，强制调整见设计文档 §9。关键修正：①逐字稿不过 LLM（确定性清洗，LLM 只做总结/memo/打分）②每场=2路并发流、付费从第一天、免费层实为~20h且仅1场并发 ③群面 diarization 是 best-effort 需兜底 ④删 global-cluster 前先把 /cluster-map 改接 Speechmatics 标签 ⑤静音保活帧是刚需（看题阶段全员静音）⑥inference 移植真实规模~2.4k 行跨4服务。
- 注意：Phase 5 的 OAuth 配置与实机验收待办**仍然有效**，但需在 Phase 6 架构落地后再执行。

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
- Phase 2: ASR 实时转写 + 说话人识别
  - Status: **COMPLETED**
  - Done:
    - Worker/DO 已实现 ASR 窗口任务框架（window/hop 可配置）
    - DashScope ASR 线上 smoke 通过
    - 双流 WS 协议：`/v1/audio/ws/:session_id/:stream_role`
    - 实时 ASR（常驻 WS）替代窗口轮询
    - merged v2（token overlap + 近似去重）
    - teacher 身份优先级（Teams参会者 > 会前配置 > 转写抽名 > teacher）
    - Phase 2.3.1 Enrollment + Mapping 接口全部就绪
- Phase 3: 后端智能升级（Backend Intelligence Upgrade）
  - Status: **COMPLETED**
  - Done:
    - `POST /analysis/synthesize` 端点 + `ReportSynthesizer` 类（DashScope qwen-plus）
    - Worker `buildMultiEvidence`（每个 claim 3-5 条 utterance 引用）
    - Worker `extractMemoNames`（memo → 说话人绑定）
    - Worker `addStageMetadata`（面试阶段分割）
    - Worker `enforceQualityGates`（证据质量门禁）
    - Worker `collectEnrichedContext`（rubric + notes + history 上下文收集）
    - Worker finalize v2 9 阶段管线：freeze → drain → replay → reconcile → stats → events → report → persist
    - Inference LLM fallback（DashScope 失败时回退结构化模板）
    - CJK token 估算（`len(text) * 1.5`）
    - Evidence namespace 冲突修复
- Phase 4: 生产就绪（Production Readiness）
  - Status: **COMPLETED**
  - Done:
    - **Desktop 技术栈升级**：React + Vite + TypeScript + Tailwind v4（~2086 模块）
    - **状态架构**：Zustand sessionStore + Service Singletons（AudioService/WebSocketService/TimerService）
    - **OAuth 登录**：MSAL Node v5 acquireTokenInteractive + Google OAuth2 loopback
    - **LoginView**：Granola 风格品牌登录（Microsoft / Google / 跳过）
    - **日历集成**：Microsoft Graph Calendar + Google Calendar API v3
    - **PiP 悬浮窗**：背景 session 监控（计时器 + 音量指示）
    - **UI/UX 打磨**：
      - HomeView 精简（紧凑问候、去除 hero banner + HealthIndicator）
      - HistoryView 日期分组（Today/Yesterday/This Week/Earlier）+ 筛选标签
      - AppShell 用户头像 + 平滑过渡 + Tooltip
      - 共享动画系统（motion/react + animations.ts）
    - **安全加固**：
      - Inference：timing-safe API key 验证（hmac.compare_digest）
      - Worker：timing-safe 字符串比较 + auth 中间件提取
      - Error sanitization：内部错误仅服务端日志，客户端返回通用消息
      - ffmpeg 30s 超时保护
    - **测试基础设施**：
      - Desktop：Vitest + React Testing Library + jsdom（63 tests）
      - Inference：pytest（95 tests）
      - Edge Worker：Vitest（59 tests）
      - 总计：217 tests 全部通过
    - **代码模块化**：
      - Worker 提取 `auth.ts`、`audio-utils.ts`、`reconcile.ts`
      - Desktop 6 views + 25 components + 12 hooks + 3 services
    - **文档更新**：CLAUDE.md 全面重写对齐当前架构
    - **Secrets 配置**：INFERENCE_API_KEY + WORKER_API_KEY 已生成并配置
- Phase 5: 实机验收 + Beta 上线
  - Status: **TODO**

## 2.5 Phase 6 架构重定向待办（当前主线）

> 详见 `docs/plans/2026-06-27-cloud-companion-speechmatics-architecture.md`

### Phase A — P0：云端可用闭环（用户零部署 + 实时转写 + 能出报告）
- [~] A1 新增 Speechmatics 实时 provider（DO outbound WS / 每声道 / diarization=speaker / language=en|cmn_en）
  - ✅ A1a 协议纯模块 `speechmatics-asr.ts`:`buildStartRecognition`(diarization 可关——teacher 声道 §9.3.4)/`buildEndOfStream`/`parseSpeechmaticsMessage`(解析 AddTranscript→words[].speaker+词级时间戳+文本重建,标点不带前空格)/`openSpeechmaticsSocket`(CF fetch-upgrade 出站 WS,Bearer 鉴权)。`Env` 加 `SPEECHMATICS_API_KEY`/`SPEECHMATICS_WS_URL`。基于**实测验证过的真实消息结构**。测试 10 例,worker 497 全绿
  - ✅ A1b dispatch 接线(核心):`realtimeProvider(ctx)` 按 `ASR_PROVIDER==='speechmatics'` 分流(默认仍 dashscope,最小插入,DashScope 路径零改动);`connectSpeechmaticsRealtime`(开 WS + StartRecognition + ready on RecognitionStarted + R2 replay)、`handleSpeechmaticsMessage`(RecognitionStarted/Transcript final/Error;词时间戳→seq;students 取 `dominantSpeaker` S 标签)、`closeRealtimeAsrSession` 发 EndOfStream、`emitRealtimeUtterance(…, speakerOverride)` 广播带 S 标签、`isAsrEnabled`/`asr_provider` 支持 speechmatics。复用现有 drain/队列/重连/退避(发原始 PCM,Speechmatics 直收)。worker 497 全绿,tsc 绿,DashScope 零回归
  - ⏳ A1b 增强(后续,非阻塞 MVP):静音保活帧(§9.3.6,当前靠静音期重连+R2 replay 兜底,S 标签会重编号)、严格背压 seq_no/AudioAdded(§9.3.8)、partial(is_final=false)下行、用精确词级时间戳替代 seq 近似
- [x] A2 Worker→Desktop 转写下行协议 + Desktop 入站处理 + `transcriptSegments[]` 持久化
  - ✅ Worker 下行:DO 新增 `ingestWebSocketsByStream` 存 server socket（`setupWebSocketPair` accept 后 `registerIngestSocket`、close 时 `unregisterIngestSocket`）；`broadcastTranscriptFrame` 用纯函数 `buildTranscriptFrame`（asr-helpers.ts）按 `{type:'transcript',role,speaker,text,is_final,ts_ms,start_ms,words}` 推送；`emitRealtimeUtterance` 存完 utterance 后广播（teacher 解析面试官名，students 暂 null）
  - ✅ Desktop 入站:`WebSocketService` onmessage 处理 `type==='transcript'` → `appendTranscriptSegment`
  - ✅ 持久化:sessionStore 新增 `TranscriptSegment`/`transcriptSegments[]`/`appendTranscriptSegment`（上限 1000）；纳入 `PersistedSession` + `restoreSession` + 自动保存快照（reload/crash/PiP 不丢）
  - ✅ 测试:Worker tests/transcript-frame.test.ts（契约 4 例）+ Desktop sessionStore A2（3 例）；Worker 478 / Desktop 241 全绿，tsc 双绿
  - ⏳ 跟进:partial（is_final=false）下行待 Speechmatics `enable_partials` 落地后接入（当前 DashScope 实时路径只发 final）；B5 CaptionPanel 改由 transcriptSegments 驱动属 Phase B
- [x] A3 修 Desktop base URL 配置（`VITE_EDGE_BASE_URL` / 经 IPC 读 `API_BASE_URL`）+ `VITE_WORKER_API_KEY`
  - ✅ 新增 `config:getEdgeBaseUrl` IPC（main.js 读 `API_BASE_URL || WORKER_BASE_URL`）+ preload 暴露 + `desktop-api.d.ts` 类型 + `SetupView` 经 IPC 解析 `baseApiUrl`（回退 `import.meta.env.VITE_EDGE_BASE_URL`）
  - ✅ API key 链路已确认：`WebSocketService.getApiKey()` 先走 `getWorkerApiKey` IPC（main.js 读 `WORKER_API_KEY`）再回退 `VITE_WORKER_API_KEY`；WS 首帧 `{type:'auth',key}` + HTTP `x-api-key` 头均依赖此值
  - ✅ 配置补齐：`API_BASE_URL=https://api.frontierace.ai` 与 `WORKER_API_KEY`（dev 值，须与生产 secret 一致）已入 `.env`；`.env.example` 补 `WORKER_API_KEY` 文档占位
  - ✅ 验证：`tsc --noEmit` exit 0 / `vite build` 2559 模块成功 / main.js·preload.js `node --check` 通过；顺手清除 main.js 遗留 `[DEBUG]` 日志，CSP 头补 Google Fonts 白名单（与 index.html meta CSP 对齐）
- [~] A4 删 4 处 `127.0.0.1:8000` fallback + `wrangler.jsonc` 云端化（ASR_PROVIDER=speechmatics, 删 inference localhost, 加 SPEECHMATICS_API_KEY secret）
  - ✅ A4.1 删 4 处代码 localhost fallback → fail-fast（§2.1 bug#3）:realtime-asr-processor(local-whisper)、incremental-processor×2、finalize-orchestrator(improvements)。配置缺失时抛错/优雅跳过，不再静默连 localhost。worker 487 全绿
  - ⏳ wrangler.jsonc 云端化（ASR_PROVIDER→speechmatics、删 INFERENCE_* localhost、加 SPEECHMATICS_API_KEY secret）**deferred**:翻转 ASR_PROVIDER 依赖 A1 验证通过（无 key 会搞挂现有 DashScope 实时）；需可部署环境验证。当前保留 DashScope 实时路径不动（§9.2 迁移期 fallback）
- [~] A5 LLM 合成移入 Worker（移植 `report_synthesizer.py`）+ finalize 摘除 inference 依赖 + 删 `local_asr` 阶段
  - ✅ 核心:新增 `services/llm-synthesizer.ts`（直调 DashScope OpenAI-compatible `chat/completions`,读 `ALIYUN_DASHSCOPE_API_KEY`,model=`LLM_MODEL`默认 qwen-plus,temp 0.2,json mode;`buildSynthesisMessages`/`parseSynthesisResponse`(健壮,code-fence/空/畸形→安全默认)/`truncateTranscript`(CJK-aware 4000 tok 首现+近期)/`synthesizeReportInWorker`)。移植自 report_synthesizer.py（系统prompt+评分rubric+证据规则+输出schema）
  - ✅ 接线:`invokeInferenceSynthesizeReport`(index.ts,两 context 共用)按 `REPORT_SYNTHESIS_MODE`(默认 **worker**)分流——worker 直调 DashScope(失败内部 catch→degraded→memo_first 回退),`=inference` 回滚旧路径。Tier2Context backend_used 放宽 string
  - ✅ 测试:`tests/llm-synthesizer.test.ts` 27 例(fetch stub),worker 524 全绿,tsc 绿
  - ⏳ 未完:① 把 synthData.summary/personalized_memo 接进 buildResultV2(B1 收尾,call site 作用域需加外层变量)② 删 `local_asr` finalize 阶段(§5.1)③ checkpoint/regenerate-claim/improvements/tier2 仍调 inference,按 §9.3.7 决定移植/降级 ④ 无法 E2E(需部署+DashScope 账户有额度)

### Phase B — P1：Granola 交付物 + 说话人命名 + 质量
- [x] B1 `ResultV2`/合成 contract 新增 `cleaned_transcript`/`summary`/`personalized_memo`（一次性交付）
  - ✅ 类型:`ResultV2` 加 `cleaned_transcript`/`summary`/`personalized_memo`（均可选）；`SynthesizeRequestPayload` 加 `deliverable`/`want_summary`/`want_cleaned_transcript`/`personalize_to_notes`
  - ✅ 确定性逐字稿:新增 `transcript-cleaner.ts`（§9.3.1 不过 LLM，仅去 filler `um/uh/嗯/呃…` + 规整空格，保守不误伤 `like/you know/就是`）；`buildResultV2` 默认对每份报告生成 `cleaned_transcript`
  - ✅ `summary`/`personalized_memo`:A5 synthesizer 产出 → finalize 两条路径(report-only + 主)均接入 `buildResultV2`（外层 finalSummary/finalPersonalizedMemo,LLM 产出即 surface）
  - ✅ 测试:transcript-cleaner 9 例 + llm-synthesizer 27 例,worker 524 全绿,tsc 绿
- [ ] B2 note/mark 精确锚点（`anchor.time_ms`）+ 作为个性化信号
- [ ] B3 diarization 标签 → 候选人命名（Speechmatics 命名声纹 enrollment 或复用手动映射 UI）
- [ ] B4 质量门禁阈值可配置 + 纪要交付与评分门禁解耦
- [x] B5 通用实时字幕面板（`CaptionPanel` 由 `transcriptSegments` 驱动，覆盖非 Teams 会议）
  - ✅ CaptionPanel 统一字幕源:ACS captions 优先,否则把 `transcriptSegments`(A2 下行)映射成 caption 显示;渲染条件改为"ACS off 且无转写才隐藏";speaker 用 S 标签/回退 Interviewer/Candidate。SidecarView 传入 `transcriptSegments`。desktop tsc + 241 测试绿（UI glue,无新增单测）

### Phase C — P2：清理与通用性
- [ ] C1 删本地 pyannote-rs sidecar / 重复 `useWebSocket` hook / Settings localhost 文案
- [ ] C2 长会议分块清洗兜底
- [ ] C3 归档 `inference/` + 退役 `if.frontierace.ai` tunnel

### Phase A 前置验证门（删 inference 前必须通过 pilot，需 Speechmatics key）
> **2026-06-27 实测**（`scripts/speechmatics_rt_validate.mjs`，真实 Speechmatics key + 真实样本）
- [x] cmn_en + 实时 + diarization=speaker 三者同时可用且返回每词 speaker（官方无矩阵，必须实测）✅ language_pack="English and Mandarin"；alice+bob→S1/S2 切换点 6.11s≈拼接边界 6.0s；每词带 speaker+词级时间戳；三者同会话共存
- [~] 真实 3–4 人群面**重叠音频**的 diarization 错误率（DER/误切换率）达标 —— 顺序双人正确;**重叠场景仍需真实群面音频 pilot**
- [ ] 实时免费/付费**并发额度**与确切单价（portal 实测；注意每场=2路流）—— 账户实时用量当前为空,需 portal 查
- [ ] CF DO **持久双出站 WS + 静音保活 + 重连** 实跑验证（dashscope-asr.ts 是短连，不能作证）—— 待 A1 实现 + 部署
- [x] 16000Hz sample_rate 被 Speechmatics 接受 ✅
- 备注:cmn_en 下英文 ASR 正常("History and belonging…passionate");en/zh 3s 短样本转写为空(样本质量),中文 ASR 质量待真实样本验证

> 注：v2 强制调整已并入下方 A/B/C（详见设计文档 §9）：A5 改为"逐字稿确定性清洗 + LLM 只做总结/memo/打分"；A1 含 teacher 声道关 diarization + 静音保活帧 + R2-replay 重连；删 global-cluster 前先在 B3 把 /cluster-map 改接 S 标签；inference 移植按真实规模(~2.4k 行跨4服务)拆分并补 TS 回归测试。

---

## 3. 历史待办（Phase 5：实机验收 + OAuth，架构落地后再执行）

### 5.1 OAuth 配置（阻塞实机测试）
- [ ] Azure Portal 创建 App Registration（`MS_GRAPH_CLIENT_ID`）
  - Redirect URI: `http://localhost`（Mobile and desktop applications）
  - API Permissions: `User.Read`、`Calendars.Read`、`OnlineMeetings.ReadWrite`
- [ ] Google Cloud Console 创建 OAuth 2.0 Client ID（`GOOGLE_CALENDAR_CLIENT_ID` + `SECRET`）
  - Application type: Desktop app
  - Enable: Google Calendar API
- [ ] 填入 `desktop/.env` 并验证登录流程

### 5.2 实机端到端验收
- [ ] 首次启动验证：LoginView → Microsoft 登录 → 日历拉取 → 会议选择
- [ ] 完整录制流程：Setup → Sidecar（notes）→ 会中 memo 采集 → 结束 → Feedback
- [ ] 双流音频验证：Mic + System Audio 均正常采集且上传
- [ ] 实时转写验证：utterances 产出，延迟 P95<=5s
- [ ] Enrollment 验证：开场 2~3 分钟完成 participants 引导采样
- [ ] PiP 验证：离开 Sidecar 后悬浮窗正常显示计时器和音量
- [ ] Finalize 验证：session 结束后 feedback report 正常生成

### 5.3 质量门禁
- [ ] 真实 Teams 5~10 分钟实机验证（含 latency 门禁 P95<=5s）
- [ ] students `unknown_ratio <= 15%`
- [ ] `confirm_without_name_count = 0`
- [ ] 人工映射兜底后未绑定 cluster = 0
- [ ] 无耳机场景：teacher/students 重复转写率下降 >= 60%

## 4. 已完成阶段任务记录

### Phase 2.3 任务（已完成）
- [x] Worker 主链改为实时 ASR（常驻 WS），替代每窗重建连接
- [x] 新增 `POST /config`（teams_participants/interviewer 配置）
- [x] 新增 `GET /events`（speaker events + identity_source）
- [x] `asr_by_stream` 新增实时指标（mode/ws_state/backlog/lag/p50/p95）
- [x] merged v2（token overlap + 近似去重）替换旧 exact-match 去重
- [x] teacher 身份优先级落地（Teams参会者 > 会前配置 > 转写抽名 > teacher）
- [x] Desktop UI 增加 Session Config + Live Transcript + Speaker Events
- [x] 双流并发 ingest 一致性修复
- [x] Desktop 断流容错 + System Audio 自动恢复
- [x] 无耳机优化：AEC/NS + 去串音抑制
- [x] Session Config UX 去 JSON 化
- [x] Worker 配置兼容：`teams_participants` 支持 `[{name,email?}]` 与 `string[]`
- [x] Inference 姓名抽取纠偏
- [x] Teacher 去串音阈值重调

### Phase 2.3.1 任务（Enrollment + Mapping，已完成）
- [x] Inference `BinderPolicy` 强约束
- [x] Inference `POST /speaker/enroll` 与 `SessionState.participant_profiles`
- [x] Inference resolve 顺序升级
- [x] Worker enrollment 接口：`start/stop/state`
- [x] Worker 手动映射接口：`POST /cluster-map`、`GET /unresolved-clusters`
- [x] Worker resolve 音频窗口改为尾窗策略
- [x] Worker 事件扩展 `identity_source`
- [x] Desktop Enrollment/Cluster Mapping UI

### Phase 3 任务（Backend Intelligence Upgrade，已完成）
- [x] `POST /analysis/synthesize` + `ReportSynthesizer`（LLM-Core Synthesis）
- [x] Worker `buildMultiEvidence`（3-5 utterances per claim）
- [x] Worker `extractMemoNames`（memo → speaker binding）
- [x] Worker `addStageMetadata`（stage segmentation）
- [x] Worker `enforceQualityGates`（quality gate enforcement）
- [x] Worker `collectEnrichedContext`（rubric + notes + history）
- [x] Worker finalize v2 管线全 9 阶段

### Phase 4 任务（Production Readiness，已完成）
- [x] Desktop React + Vite + TypeScript + Tailwind v4 技术栈迁移
- [x] Zustand sessionStore + Service Singletons 架构
- [x] PiP + Background Session 支持
- [x] OAuth 登录（MSAL interactive + Google loopback）
- [x] LoginView（Granola 风格）
- [x] Microsoft Graph Calendar 集成
- [x] Google Calendar API v3 集成
- [x] HomeView 精简
- [x] HistoryView 日期分组 + 筛选标签
- [x] AppShell 打磨（头像、过渡、Tooltip）
- [x] 安全加固（timing-safe auth, error sanitization, rate limiting）
- [x] Worker 代码模块化（auth.ts, audio-utils.ts, reconcile.ts）
- [x] 测试基础设施（Desktop 63 + Inference 95 + Worker 59 = 217 tests）
- [x] Vitest + RTL + jsdom 环境配置
- [x] CLAUDE.md 全面重写
- [x] Secrets 配置（INFERENCE_API_KEY + WORKER_API_KEY）

## 5. 已完成基础能力（供后续阶段复用）
- [x] Inference FastAPI + Docker + 模型版本固定 + smoke 回归
- [x] Inference 生产防护：API Key（timing-safe）、请求体上限、限流、健康可观测字段
- [x] 固定 Cloudflare Tunnel 域名绑定 + 运行脚本
- [x] Worker + Durable Object + R2 骨架
- [x] Worker Custom Domain 绑定：`api.frontierace.ai`
- [x] Worker WebSocket ingest（1s chunk）+ DO 顺序统计 + R2 chunk 落盘
- [x] Worker Auth 中间件提取（timing-safe）
- [x] Desktop 35+ IPC bridge methods（preload.js）
- [x] Desktop 设计系统（Tailwind v4 @theme, WCAG AA 对比度）
- [x] Desktop 动画系统（motion/react + shared variants）
- [x] 217 tests 跨三个组件全部通过

## 6. 最新验证记录
Validation Date: 2026-02-15

- [x] `cd desktop && npx vitest run` -> 63 tests passed（jsdom + RTL）
- [x] `cd desktop && npx tsc --noEmit` -> TypeScript check passed
- [x] `cd desktop && npx vite build` -> Production build passed（~2086 modules, ~1.2s）
- [x] `cd inference && python -m pytest tests/ -v` -> 95 tests passed
- [x] `cd edge/worker && npx vitest run` -> 59 tests passed
- [x] `cd edge/worker && npm run typecheck` -> TypeScript check passed
- [x] Total: **217 tests all passing**

## 7. 当前阻塞与处理
- **[架构] 旧架构依赖自建推理**：`if.frontierace.ai` 是开发机 tunnel（现 1033 不健康），不满足"用户零部署"。→ Phase 6 用 Speechmatics + Worker 直调 LLM 取代，删除 `inference/`。
- **[P0 bug] Desktop 生产版连不上云端**：`VITE_EDGE_BASE_URL` 未定义 → `baseApiUrl=''`。→ Phase 6 A3 修。
- **[P0 bug] 录音时转写不回传 Desktop**：非 Teams 会议零实时字幕零持久化。→ Phase 6 A2 修。
- **[待核实] Speechmatics `cmn_en` 实时可用性/单价 + CF 并发 outbound WS 限制**：commit 前实测。
- **OAuth 配置未完成**（历史阻塞，架构落地后再处理）：需创建 Azure App Registration 和 Google Cloud OAuth Client ID。

## 8. 设计文档索引
- `docs/plans/2026-06-27-cloud-companion-speechmatics-architecture.md` — **【当前主线】云端化 + Companion + Speechmatics 架构重定向设计**
- `docs/plans/2026-02-14-backend-intelligence-upgrade-plan.md` — LLM 合成管线实施计划
- `docs/plans/2026-02-14-backend-intelligence-upgrade-design.md` — 后端智能升级设计
- `docs/plans/2026-02-14-pip-background-session-design.md` — PiP + Zustand 架构设计
- `docs/plans/2026-02-14-production-redesign-design.md` — 竞品分析 + 生产重设计
- `docs/plans/2026-02-15-production-readiness-plan.md` — 安全 + 代码质量 + UI/UX 计划
- `docs/plans/2026-02-15-ux-elevation-design.md` — UX 提升设计规范

## 9. 技术栈概览
| Component | Stack | Tests |
|-----------|-------|-------|
| Inference | FastAPI + Python 3.12 + ModelScope CAM++ + DashScope | 95 |
| Edge Worker | Cloudflare Worker + Durable Objects + R2 + TypeScript | 59 |
| Desktop | Electron + React + Vite + TypeScript + Tailwind v4 + Zustand | 63 |
| **Total** | | **217** |

## 10. 更新规则（强制执行）
每次开发迭代必须按以下顺序更新：
1. 先实现代码（严格按文档阶段目标）
2. 再执行验证（写明命令与结果）
3. 最后更新本 `Task.md`：
   - 当前阶段状态
   - 任务勾选
   - 验收勾选
   - 最新验证记录

未通过验证的任务，不允许标记为完成。

## 11. 下一步（立即执行 — Phase 6 架构重定向）
1. **前置核实** → Speechmatics `cmn_en` 实时端点可用性 + 单价 + CF 并发 outbound WS 限制
2. **A1** → 新增 Speechmatics 实时 provider（DO outbound WS / 每声道 / diarization）
3. **A2 + A3** → 转写下行协议 + Desktop 持久化 + 修 base URL
4. **A4 + A5** → 删 localhost fallback + wrangler 云端化 + LLM 合成移入 Worker
5. **B1** → Granola 一次性交付物（cleaned_transcript + summary + personalized_memo）
6. （架构落地后）回到 Phase 5：OAuth 配置 + 实机端到端验收
