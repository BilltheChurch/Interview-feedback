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
- **[并行轨道] 桌面端 UI 重设计（2026-06-29，分支 `feat/ui-liquid-glass`，未合 main）**：从暗色翻为**浅色液态玻璃** + **单一橘橙强调色**(3 token：`--color-accent`#FF7A1A 填充 / `--color-accent-ink`#B5560A 浅底文字 / `--color-on-accent`#3A1500 填充上文字) + **GSAP `back.out` 回弹 SegmentedControl**(gsap + @gsap/react) + **Plus Jakarta Sans**。全站对比度迁移(深→浅、teal→橘橙，66 处 text-accent→ink、白字→on-accent，26 文件)。用 design-taste-frontend + ui-ux-pro-max + gsap-react 三个 skill 完成。基础+全视图已验收,待回主线后择机合并。详见 memory `desktop-ui-redesign-direction`。

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
- [x] B3 diarization S 标签 → 候选人命名（commit 1479225）：`buildReconciledTranscript` 云端模式也跑自我介绍抽名（此前仅 `diarizationBackend==='edge'`），每条 utterance 的名字绑定其 speaker-event 自身的 S 标签（1:1，不用 ±5s 时间搜索）；名字 patterns 接受大写句首（"My name is"/"This is"）；containment-first 匹配。修复"群面报告全 unknown"。手动纠正仍走 `/cluster-map`（`state.bindings` 优先）。worker 534 测试绿。未部署。
- [~] B4 质量门禁阈值可配置 + 纪要交付与评分门禁解耦
  - ✅ Part1 阈值 env 化:`enforceQualityGates` 加 `unknownRatioThreshold`(默认 0.25),两处调用从 `env.QUALITY_GATE_UNKNOWN_RATIO` 读取(新 `resolveUnknownRatioThreshold`,空/越界→默认)。测试 5 例(顺手修了 `Number("")===0` 导致空 env→阈值0 的 bug)。worker 529 全绿
  - ⏳ Part2 交付解耦:cleaned_transcript/summary/personalized_memo 已随 resultV2 持久化(不被门禁拦截存储);真正的"tentative 也照展示纪要/逐字稿"属 Desktop 展示侧(读 cache 时即使 ready=false 也渲染 deliverables）——留作 Desktop 跟进
- [x] B5 通用实时字幕面板（`CaptionPanel` 由 `transcriptSegments` 驱动，覆盖非 Teams 会议）
  - ✅ CaptionPanel 统一字幕源:ACS captions 优先,否则把 `transcriptSegments`(A2 下行)映射成 caption 显示;渲染条件改为"ACS off 且无转写才隐藏";speaker 用 S 标签/回退 Interviewer/Candidate。SidecarView 传入 `transcriptSegments`。desktop tsc + 241 测试绿（UI glue,无新增单测）

### 🚀 生产部署（2026-06-29）— 云端管线上线
- ✅ D1 建库 + 迁移：`chorus-meta`(bee0bd7c…) + `chorus-meta-staging`(4785fe8c…),各 6 表；id 填入 wrangler.jsonc
- ✅ `wrangler deploy` 成功 → `api.frontierace.ai`（version 1b8cb3f7）；`ASR_PROVIDER=speechmatics` + `REPORT_SYNTHESIS_MODE=worker`(默认)
- ✅ `WORKER_API_KEY` secret 设入(=dev c078…)→ **生产鉴权开启**；prod secrets: DASHSCOPE/INFERENCE_BASE_URL/SPEECHMATICS/WORKER_API_KEY
- ✅ 健康检查 `/health` → 200 `{"status":"ok"}`
- ⏳ 待真实音频验证(§9.6 剩余两项现可测)：群面重叠 diarization DER + CF DO 持久双出站 WS/保活/重连;以及端到端(实时字幕→报告由 Worker+DashScope 出)
- 回退:ASR 问题→ASR_PROVIDER=dashscope;报告问题→REPORT_SYNTHESIS_MODE=inference;鉴权问题→删 WORKER_API_KEY secret

### Phase C — P2：清理与通用性
- [~] C1 删本地 pyannote-rs sidecar / 重复 `useWebSocket` hook / Settings localhost 文案
  - ✅ 删死代码 `useWebSocket.ts` + 测试 + hooks barrel re-export(确认无任何 `../hooks` 消费者;WebSocketService 是唯一实现）
  - ✅ 删 SettingsView "Batch Processor Endpoint" 字段(localhost:8000/batch/process 死端点)+ batchEndpoint state + 更新测试。desktop tsc + 234 测试绿
  - ⏳ `lib/diarizationSidecar.js`(pyannote-rs)移除留作专门 pass:它在 main.js 启动期创建且被多处 IPC 用,需 Electron 主进程手术 + 启动验证(此环境无法 E2E)
- [ ] C2 长会议分块清洗兜底
- [x] C3 归档 `inference/` + 退役 `if.frontierace.ai` tunnel（2026-06-29，真人 pilot 验证通过后）：`git rm` 删 `inference/` FastAPI 服务（133 文件，保留在 git 历史）+ 清空 wrangler.jsonc 死配置（`INFERENCE_BASE_URL_*`/`ASR_ENDPOINT`/`TIER2_BATCH_ENDPOINT` 的 tunnel+localhost → ""）+ CLAUDE.md 顶部立架构重定向横幅。worker 不依赖 inference/ 目录(tsc 仍过)。DashScope key 保留在 `edge/worker/.dev.vars`。**用户侧**:停掉 `if.frontierace.ai` GPU tunnel、可选删 prod secret `INFERENCE_BASE_URL`。
  - ⏳ 残留(可选,低优先):worker 内 `inference_client.ts`/`inference-helpers.ts` 等客户端代码仍在但被 `INFERENCE_ENABLED=false` 关掉(死代码,后续可删);Tier2 batch 路径(`/batch/process`)已无端点,如需 Tier2 须改云端实现。

### Phase R — 链路鲁棒性硬化（2026-06-30，subagent-driven-development 执行，分支 `claude/ecstatic-chaum-51c7eb`）
> 设计：`docs/plans/2026-06-29-cloud-pipeline-hardening-roadmap-design.md` + 计划 `docs/superpowers/plans/2026-06-29-phase-r-pipeline-hardening.md`。基线 main 9fb7cee(534 测试) → 含两个 R1 热修后 4674735(582 测试)。每任务 2 道独立对抗式评审（规格→质量）+ 全分支 opus 最终评审。零 Co-Authored-By。**已合 main + feat/phase6 + 部署生产(版本 482085a5)**。
- [x] R-T1 Speechmatics `max_speakers` 可配置（commit f724228）：`SpeechmaticsConfig.maxSpeakers` → `buildStartRecognition` 仅 diarization 开时 emit `speaker_diarization_config.max_speakers`；纯 `resolveMaxSpeakers(env)`（unset/非法/<2 → undefined，用 `Number` 非 parseInt）；只接 students 路径；`wrangler.jsonc ASR_MAX_SPEAKERS="6"`。Speechmatics rt-api 文档已核字段。
- [~] R-T2 静音 keepalive **原语**（commit a37fa80）：纯 `shouldSendKeepalive`/`makeSilencePcm16`(零 PCM,不产幽灵说话人)/`resolveKeepaliveMs`(默认 5000)；`lastAudioSentAt` 仅真实发送时更新；导出 `maybeSendKeepalive` 入口。⚠️ **递归 DO alarm 接线推迟到 R3**（用户决策：桌面连续采集下 idle-drop 威胁未证实，先验证再接线，避免对单一 alarm 槽做投机性结构改动）。R3 接线时需顺带让 keepalive 发送也自增 `lastSentToSpeechmaticsSeq`。
- [x] R-T3 Speechmatics backpressure（commit 244ddcd）：纯 `backpressureLag`/`shouldThrottle` + `BACKPRESSURE_WINDOW=50`；消费 `AudioAdded{seq_no}`（非 Transcript early-return 前，`Math.max` 防乱序）；**专用 per-connection 计数器** `lastSentToSpeechmaticsSeq`（仅真实发帧自增，与 `lastAckedSeq` 在每次新建 WS 连接+teardown 时一起归零 → 对齐 Speechmatics seq_no 每连接从 1，消除重连 Math.max-冻结死锁）；节流门控 `realtimeProvider==="speechmatics"`（DashScope 无 ack 否则死锁）；`backpressure_lag` 指标在 DashScope 路径为 undefined；节流为「跳过本轮」非永久停。
- [x] R-T4 面试官排除出学生评分、保留为上下文（commit 0ece17d）：两条 finalize 路径 `studentStats=stats.filter(speaker_key!=="teacher")` 喂 per-person/memo/evidence/observations/synthesize；完整 transcript（含 teacher）仍进 LLM 作上下文；`speakerKey()` 在 finalize_v2.ts **和** local_events_analyzer.ts 均短路 `stream_role==="teacher"`→"teacher"（防 ACS 名字继承泄漏）；新 `tests/dual-stream-report.test.ts` 10 例（含 ACS 风格 + 事件路径回归锁，实证：还原修复→测试失败）。
- [x] R-T5 双流 live harness（commit e3afa8f）：`desktop/e2e_dual_stream_test.mjs`——双 WS（首帧 auth→auth_ok→hello，per-stream stream_role）、并发推 teacher+students PCM、finalize+poll+result、Gate-R1 摘要（students-only per-person + interviewer context + 用时 + transcript 里的 stream roles）。协议经核与生产 `WebSocketService` 一致；`ws` 入 devDependencies。Step1 确认真实 app 确并发连两路（WebSocketService:284）。本地冒烟因无 Speechmatics key 延迟到 R1。
- [x] **R1 双流真实音频验证通过**（2026-06-30，The Exchange SOHO=面试官 mic + Qingnian Road=学生群面，对生产 482085a5）：详见 §6。dual-stream 契约成立——4 位学生分离+命名+真分数(14 claims)、面试官排除出 per-person、finalize 91s。**过程揪出并修掉 2 个生产级 latent bug（见下两个 hotfix commit）**。
- [ ] R-Gates R2–R5（**用户手动跑真实 live 会议**，非自动可测）：R2 5–6 人群面 / R3 30–60min 长会持续 track（顺带验 keepalive 是否需要，需要则接线）/ R4 时效预算（为 Tier2 ≤5min 留头寸）/ R5 Speechmatics 并发额度+单价(2 路/场)。runbook 见计划 §Chunk 5。结果回填本 §6。
- **🔥 R1 验证中发现并修复的 2 个生产级 latent bug（非 Phase R 回归，pre-existing；单测/评审均未触及，仅真实会话+真实音频暴露）**：
  - [x] hotfix-1（commit 6994e45）：`MeetingSessionDO` 构造器无条件要求 `INFERENCE_BASE_URL` → C3 清空 URL 后**自 06cdc9c5 起生产开不了任何会话**（走 DO 的路由全 1101/500，仅 /health 幸免）。修：提取纯函数 `resolveInferencePrimaryBaseUrl(env)`，仅 inference 启用时才 throw，否则返回占位符（永不调用）。+7 测试。
  - [x] hotfix-2（commit 4674735）：`DIARIZATION_BACKEND_DEFAULT="local"` 映射成 `"edge"` → 任何不显式传 `diarization_backend=cloud` 的会话（含真实桌面 app——它不 POST /config、hello 也不带该字段）走退役的 edge 路径 → **学生全 unknown**。修：默认改 `"cloud"`；harness 也显式传 cloud。
- R-跟进（**Phase Q**）：
  - [x] ① tier2 + feedback-cache-refresh 报告路径同类 teacher 泄漏 → 已修（commit 5c10270，prod ef150fd3）：两路径加 `studentStats` 过滤，mirror R-T4。F1-F4 测试锁定。
  - [x] ② **B3 preferred-name 绑定** → 已修（commit 5d64466，prod ef150fd3）：根因=Phase 2 roster 传播覆盖 preferred anchor + Phase 3 last-wins；修=`isPreferred` 标签 + Phase 2 跳过 + Phase 3 `committedPreferred` 保护；补中文模式（请叫我/可以叫我/叫我X就好/我喜欢叫我）。"my name is Hong, please call me Rice"→显示 Rice。roster 匹配/多人切分逐字未变。
  - [x] ③ 真实 app 会话配置流 → 已由 app-readiness P1/P3 + 审计覆盖（mode/interviewer_name 经 hello 送达；roster 经 teams_participants）；残留低优=SettingsView 的 useAudioCapture 平行实现待对齐。
  - [~] ④ **Tier2 云端化**：设计+计划已评审通过，待实现。brainstorm 决策：两层(Tier1 即时 + Tier2 异步 ≤5min)、深度层加全部 4 类(跨人对比/培优/深挖/面试官视角)、触发=自动+手动、**增量叠加不重算 per_person、失败不回归 Tier1**、跳过已死的音频 batch（用 Tier1 转写）。设计 `docs/superpowers/specs/2026-06-30-tier2-deep-layer-design.md`（spec 评审✅）；计划 `docs/superpowers/plans/2026-06-30-tier2-deep-layer.md`（6 chunks，plan 评审✅）。**下一步：subagent-driven-development 实现**（建议先 compact 再开实现窗口）。
  - [x] ⑤ **Setup Step 2「Evaluation Rubric」合并 + 接通**（用户 2026-06-30 反馈：Step 2 三控件中 Rubric Template + 面试类型 既重叠又**完全失效**、面试类型还全中文）：合成一个英文「Evaluation Rubric」控件（选 4 类型预设 + 完整维度编辑器 + 可复用命名模板），并**接通**——选/改的维度+权重经 finalizeV2 metadata 送 worker，真正驱动报告 per-person 评分。**关键事实**：worker 维度管线早已接通(只差 desktop 没送)；weight 此前被 `getDimensionPresets` 剥离+prompt 不用。brainstorm 决策 D1-D7。设计 `docs/superpowers/specs/2026-06-30-setup-evaluation-rubric-design.md`（spec✅）；计划 `docs/superpowers/plans/2026-06-30-setup-evaluation-rubric.md`（6 chunks，plan✅）。Interview Flow 不动。**✅ 已实现（2026-06-30，subagent-driven-development，每任务 spec+代码质量双审；全分支 5-lens 最终评审=GO）**：Chunk1 维度 key 生成+懒迁移(`a6049d0`)；Chunk2 `EvaluationRubricEditor` 控件 + SetupView 接入（删旧两卡+`BUILTIN_TEMPLATES`+`RubricTemplateModal`，`24435df`/`28b8e6d`）；Chunk3 store 持久化 + finalizeV2 metadata 转发 snake_case(`be77c91`)；Chunk4 worker metadata→`state.config` 合并 + 逐项校验(`9f73344`)；Chunk5 weight 真生效（`getDimensionPresets` 保留 weight + `DEFAULT_DIMENSION_PRESETS` 带 1.0 + prompt 按权重综合，**0-10 分本身不缩放**）(`09d38612`)；最终评审修复=legacy 模板迁移保留 `name`(D4) + 4 预设 `description` 英文化(D6) + 自定义维 `label_zh` 回退 label_en/key(`20fb76b`/`ed93b23`)。**desktop 280 测试 / worker 627 测试全绿，tsc/typecheck 清，8 commit 零 co-author**。**已部署（prod Version `a54816e6`）；S1–S5 真人验收门待用户跑（需真实学生音频）**。
  - [x] ⑥ **真人测试(2026-06-30~07-01)发现的实时链路+finalization 7 bug — systematic-debugging + 3 并行只读调查定位根因 + subagent-driven-development 每任务双审**：**R1** teacher 流单人 roster 被误标学生→caption 全染 122（`resolveTeacherIdentity` 删单人分支 + desktop `CaptionPanel` teacher 恒 "Interviewer"，`475ab9a`）；**R3** `invokeInferenceAnalysisReport` 缺 `isInferenceEnabled` 守卫→退役 inference 530/1016 噪音（补守卫，`3035f98`）；**R5+R6** Speechmatics `operating_point=enhanced`(可配 env)+`max_delay` 2→1s+language 显式 cmn_en(`655e759`)；**R4** 逐字流式（worker 转发 partial `isFinal=false`+dedupe+200ms/流节流+跨句首词立即；desktop `partialTranscripts` 就地更新+视觉区分 partial 行；`STT_UTTERANCE_GAP_MS` 800→500 可配，`dc6aa3f`）；**R2** 无学生发言→overview-only 降级可读报告（新 report source `degraded_no_participants` + 共享 `computeEligibleSpeakers` oracle 对齐 synthesizer 三层判据 + notice banner + 真实 orchestrator 集成测试；**返工修掉"守卫 `finalPerPerson.length===0` 恒 false → 降级不可达"致命 bug**，`54087bc`）；**R7** speaker activity 静音门 1→8 对齐 0-100 量纲（AnalyserNode 底噪不再计给静默学生 + 量纲统一，`bfb19e4f`）。**worker 671 / desktop 304 全绿，6 commit 零 co-author，每任务 spec/质量双审（T5 经返工）**。已 ff main + 部署 + 重建 dist，待用户带真实学生音频复测。
  - [x] ⑦ **真人测试 round-2(2026-07-01) 9 个实时链路/finalization/report bug — systematic-debugging + 5 路并行只读调查定位根因 + subagent-driven-development 每任务双审**：**批次1(regression/critical)**：R-B history 重进又 `empty per_person`（`feedback-cache-refresh` 重载路径缺 R2 降级分流+覆写好缓存 → 移植降级分流+好缓存防覆盖护栏+真实 orchestrator 集成测试，`fc9de39`）；R-F/G memo 被当候选人 transcript/evidence 注入=unknown+异常 epoch 时间戳+假证据三合一（memo 打独立 `type:"note"`+绑目标人+`start_ms` 24h sanity guard+1v1 唯一候选兜底，`9d5727b`）；R-A interviewer 真名被 `CaptionPanel` 硬编码覆盖(改为显真名仅占位回退)+R-C speaker-activity 反转(R7 阈值 8 对降噪 mic 偏高→mic/system 分离阈值 4/8)(`2ef017e`)。**深层**：R-E transcript 乱序(students `start_ms` 时钟不统一+Speechmatics 重连归零→删 `flushSttBuffer` 游标覆盖、排序统一到会话单调 seq，`bcd98ef`)；R-I caption 每句分段+mm:ss 起始时间戳(纯前端共享 `formatSessionTime`，`d3a8a85`)；R-D 逐字打字机(`useTypewriter` rAF reveal+CJK 码点+reduced-motion；worker partial 节流 200→100、gap 500→900，`c83084a`)；R-H 中文标点(Speechmatics `punctuation_overrides.permitted_marks:["all"]` env-gated 默认 ON 可回退+CJK-aware join 去词间空格，`8a84712`)；R-K local_events memo epoch 收尾(复用 F2 `sanitizeTimeRange`，`2e7f0f2`)。**worker 713 / desktop 337 全绿，8 commit 零 co-author，每任务双审(F1/F2 走真实 orchestrator 集成测试)**。批次1 部署 `ea3f6250`；深层部署 **`b6a6000d`** + 重建 dist(16:58)。**待用户复测**。**已知 latent 后续项**：DashScope 路径(`realtime-asr-processor.ts:845`)R-E 类游标隐患(非默认 provider，切回前单独立项)；R-J 中文识别准确率=Speechmatics 上游能力(非代码可解)；中文标点实际效果待真人 live 验证；F1 refresh `bindings:[]` vs orchestrator `memoBindings`(极窄保守偏差)。
  - [x] ⑧ **真人测试 round-3(2026-07-01，最新版复测) 7 个实时链路/report/面板 bug — systematic-debugging + 6 路并行只读调查 + subagent-driven-development 每任务双审**：停顿后不 finalize（flush 纯"下一条驱动"无静音兜底 → worker 静音超时定时器 `STT_SILENCE_FLUSH_MS=1200` 主动定稿，`3e067b6`）；会后 transcript 一坨/时间全 00:00（**R-E 副作用**：改用 seq 游标后 `start_ms` 塌 0 → 连接会话偏移 base + Speechmatics 词级真实时间，既铺开又重连不倒挂，`bfd57a6`）；面试官说的话在报告标 Unknown（finalize teacher 流 speaker_name=null → `resolveInterviewerDisplayName` 标真名，per_person 按 key/role 排除不受影响，`74a9404`）；1v1 面板空 + speaker-activity 把任何系统音频算学生（**电平数据源根本缺陷** → 改用 `transcriptSegments`(final) 驱动 talk-time，音乐/噪音不产转写天然排除；participants store 优先；Interviewer 始终显示+真名 `isInterviewer` 标志，`39b5a63`）；AUDIO 绿条太小(`rms*200`→`rms*500`，audioActive 门限同步 ×2.5 行为不变) + Setup 1v1 加 Candidate 字段(`c746b18`)；中文无标点（Speechmatics cmn 不吐 → `cleanUtteranceText` 补句尾标点，CJK→。/吗呢→？/吧→。/幂等，evidence 走 utterance_id 无 char-offset 零影响，`e2bfd40`）。**worker 734 / desktop 357 全绿，6 commit 零 co-author，每任务双审**。已 ff main + 部署 Version **fb593ecf** + 重建 dist(19:11)。**澄清**：报告里"Unknown: 我写的 note 内容"其实是面试官自己说的话被转写(既说又写)，非 memo 注入代码——已由 teacher 标真名解决。**已知后续**：DashScope 路径 R-E 类游标隐患(非默认 provider)；`useAudioCapture` 与 `AudioService` 双份 readRmsLevel 采集器待合并；R-D 逐字流畅度(partial 粒度)可能仍需调；中文识别准确率是 Speechmatics 上游能力(非代码可解)。
  - [x] ⑨ **断句门控：句末标点 + 长静音兜底（承接 ⑧ 停顿 finalize + line 189「handler endpointing 根治」，TDD）**：真人反馈一人连说 30-90s 被 900ms 思考停顿切成 2-3 词碎段、固定词组（"Imperial College London"）拦腰斩断。根因=flush 触发纯基于时间停顿从不看句末标点。**改动**：同一说话人内，短停顿（gap `STT_UTTERANCE_GAP_MS` 900 / silence `STT_SILENCE_FLUSH_MS` 1200）**只有 buf 文本以句末标点结尾才 flush**（复用 `transcript-cleaner.ts` 的 `SENTENCE_FINAL_PUNCT`，已 export）；否则继续累积。silence 定时器改两级——短窗仅在有句末标点时 flush，否则重排到长静音兜底；新增 `STT_MAX_UTTERANCE_SILENCE_MS`（默认 2800ms，config runtime + env 覆盖）到期无条件强制 flush（防无标点长独白/中文永不定稿——Speechmatics cmn_en 实时不吐 CJK 句末标点，天然走兜底）。**说话人切换仍是硬边界立即 flush**（保留）。**断连安全**：graceful close（client-close/finalize-watchdog，`gracefulFinish=true`）新增线程化 `sessionId` 直接 flush 残余 buf（buf 忍到句末存活更久，防断连丢整段）；reconnect（`gracefulFinish=false, clearQueue=false`）保留 buf 不 flush 让新连接续接。改 `realtime-asr-processor.ts`（gap-flush 门控 + `bufferEndsWithSentenceStop` + `scheduleSilenceCheck` 两级定时器 + close 残余 flush）、`config.ts`（新配置项）、`transcript-cleaner.ts`（export `SENTENCE_FINAL_PUNCT`）、`index.ts` + `websocket-handler.ts`（线程化 sessionId）。**新增 `tests/asr-sentence-endpointing.test.ts`（10 测试：a 无标点短停顿不 flush / b 有标点短停顿 flush / c 中文长静音兜底 flush / d 说话人切换立即 flush / e graceful close 残余 flush + reconnect 保留 + 配置默认/env 覆盖）；更新 `asr-silence-flush.test.ts` 3 测试为新语义（样本加句末标点）**。worker 744 全绿，typecheck 清。不动 P0-a start_ms 时间轴。**对抗审查补修（important）**：长静音兜底衡量"自最后一条 final 起的静音"、每条新 final 重 arm 定时器 → 中文/无标点流利长独白（换气 <2800ms、单说话人无切换）会累积成整段零切分，违反"一段最多 2-3 段"（CJK 主力场景）。修法=新增 `STT_MAX_UTTERANCE_MS`（默认 22000ms，config runtime + env，同样式回退）时长上限硬兜底：`handleSpeechmaticsMessage` 累积每条 final 后若 `buf.endMs-buf.startMs >= 上限` 则在 **final 边界强制 flush**（不切词内、不看标点），下一条 final 起新段。取舍：30s≈1-2 段/60s≈3/90s≈4，落在合理区间（真实说话有停顿实际更少）；英文先在标点切、真中文先 >2800ms 兜底，都到不了 22s，只兜极端连续独白。顺手：ingest-ws-closed close 加注释（瞬时 drop flush 保住已识别词优于丢失，buf 内存态 DO 驱逐即没）；`STT_MAX_UTTERANCE_SILENCE_MS` 加 INVARIANT 注释（须 ≫ `STT_SILENCE_FLUSH_MS`，否则两级定时器退化）。补测 c2（22s 上限强制 flush）+ c3（短句不受上限干扰）+ `resolveSttMaxUtteranceMs` 3 配置测试。worker 749 全绿，typecheck 清。
  - [x] ⑩ **会后 transcript 每句独立时间戳 + 显示层用带标点 cleaned_transcript（desktop 侧，TDD + spec/quality/adversarial 三审）**：真人反馈会后 TRANSCRIPT「一坨、没真实逐句时间戳、没句尾标点」。两个独立 desktop bug 叠加：(A) `TranscriptSection.tsx` 把连续同说话人多条 utterance 合并成 group 后只渲染组头一个 `formatSessionTime(group.startMs)`，P0-a 铺开的逐句 `start_ms` 被合并掩盖；(B) `useFeedbackData.ts` 的 `normalizedTranscript` 从 `raw.transcript`（无句尾标点）映射，未消费 worker P2 已生成的带标点 `cleaned_transcript`。**改动**：(A) 保留「按说话人分组」视觉（组头 speaker 名/色点/证据徽标不变），组内每条 utterance 各自渲染一行 `formatSessionTime(u.start_ms)`；虚拟化 `estimateSize` 改按组内条数估算（`HEADER_PX+条数×UTTERANCE_ROW_PX`，配合 `measureElement` 动态重测防滚动错位）；`scrollToIndex` 仍按 group 定位（可接受近似）。(B) `RawApiReport` 加 `cleaned_transcript?: RawUtterance[]`，**显示** transcript 优先 `cleaned_transcript`（非空）否则回退 `raw.transcript`。**对抗/quality 审查补修（两个真缺陷）**：① per-person `communicationMetrics`（fillerWordCount/turnCount/speakingTimeSec/latencies…）**必须继续基于原始 `raw.transcript`**——cleaned 去 filler + 丢纯-filler-utterance 会使 fillerCount 塌 0、turnCount 少算。拆成 `rawTranscript`（喂指标，行为与改前完全一致）+ `normalizedTranscript`（cleaned 优先，喂显示），指标数值经测试断言两条路径 `toEqual` 完全一致。② start_ms 未铺开（旧数据/degraded/全 0）时组内逐句同 `start_ms` 会渲染一列重复 00:00 → group 加 `perUtteranceTimes`（组内 start_ms 有 ≥2 个不同值才为 true），false 时退化为组头单时间戳（回旧行为）。顺手：evidence 跳转 substring 二级回退改用 `report.rawTranscript`（原文命中率更高，主路径按 utterance_id 不变）；`HEADER_PX/UTTERANCE_ROW_PX` 提模块级常量。**新测试**：`TranscriptSection.test.tsx`（4 例：同说话人多句多时间戳 / 保留 speaker 名 / 全同 start_ms 只渲一个时间戳 / 混合场景分组各自判定）；`useFeedbackData.test.ts` 加 7 例（cleaned 优先/缺失回退/空数组回退/保留逐句 start_ms/指标基于 raw 与 cleaned `toEqual`/rawTranscript 仅在差异时暴露）。**desktop 367 全绿，tsc 清，vite build 通过，零 co-author**。只改 desktop（`TranscriptSection.tsx`/`useFeedbackData.ts`/`feedback/types.ts`/`FeedbackView.tsx` + 两测试文件），不动 edge/worker（worker `cleaned_transcript` 已就绪无需改）。**已知边界**：cleaned 丢纯-filler-utterance，若某 evidence 恰锚定被丢的 filler utterance_id，跳转 no-op（不崩溃，风险极低——证据引用实质内容非纯 filler）。
  - [x] ⑪ **真人测试 round-4(2026-07-02) 收尾——① 模板选择器 / ⑤ 降级 summary / ③ 打字机改动 2 + 对抗式复审 3 补修（② ④ 已录于 ⑨ ⑩）**：**①** Rubric & Flow 选已存模板后下拉框仍显 "Select a template..."（`EvaluationRubricEditor` 加 `selectedTemplateId` 受控 select，`6810aa4`）。**⑤** 降级 summary 空洞 + evidence 莫名（重建 summary=notice+面试官发言要点+notes 摘要，evidence_ids 一律置空杜绝盲挂 `globalEvidenceRefs.slice(0,4)`，stream_role fallback，`07889ba`；边界兜底+notice 真用 `275d752`；desktop overview evidence 卡显真实置信度不再写死 80% `24805b7`）。**③ 打字机改动 2**（上会话未提交改动丢失，按交接文档 `docs/plans/2026-07-02-round4-progress-handoff.md` 规格重做）：`commonPrefixLength`/`clampRevealToCommonPrefix` 码点级公共前缀保护——partial 前缀改写（"Imperial Killedge"→"Imperial College London"）时 reveal 回退到公共前缀、只重打尾部，纯追加不动（`0f066df`）。**对抗式复审（3 视角审查 + 逐发现怀疑者核实，11 子代理）确认 3 真问题并当场修复**：(a) major｜hook 层零测试钉扎——变异实证删掉 clamp 接线 23 测试仍全绿 → 补 3 个 hook 级改写测试（head-rewrite/缩短/CJK，实证可杀变异）；(b) minor｜clamp 在 passive useEffect 产生脏帧（真实 React19+MutationObserver 实证 DOM 序列 "Imperial Colleg"→回跳）→ 移到 render 期状态调整（react.dev 官方模式，脏帧不进 commit）——两者 `cfca81a`；(c) **major｜主路径失效：Worker 段级 final 使 partial 归零**——⑨ 的端点缓冲把 UI 级 utterance 拉长跨多个 Speechmatics 识别段（max_delay=1.0 → 连续说话 ~每 1s 一个段级 final），但 partial 下行不含 sttBuffer 已缓冲前缀 → desktop 公共前缀≈0、整行抹空重打，"旧字不被替换"在主路径结构性达不成。根治=worker `is_partial` 分支转发前 `joinTranscriptPieces([...buf.texts, partial])`（同说话人才拼/CJK 无幻影空格/空 partial 仍丢弃/换人不拼），+3 新测试+1 既有测试更新到新语义（`834d163`）。另 2 项声称被怀疑者驳回为误报（"橡皮筋抖动"被 max_delay=1.0 API 契约排除；"高频浅前缀饿死"前提病态）。**worker 764 / desktop 385 全绿，tsc/typecheck 清，vite build 通过，6 commit 零 co-author**。已部署 Worker Version **4ac750c1** + 重建 dist。**⑥ 中英识别准确度=Speechmatics 上游能力（非代码 bug），待用户决定是否单独立项排查 STT 配置（operating_point/additional_vocab/domain）**。**待用户 round-5 重测**：实时字幕打字机（跨段不抹行、改写只重打尾部）+ 断句 + 会后 transcript + 降级 summary + 模板选择器。
  - [x] ⑫ **真人测试 round-5(2026-07-02) 反馈修复——降级 summary 质量三连 + Session Notes memo 卡去重（打字机获用户好评："实现了我想要的打字机的流式输出效果"）**：用户反馈 (a) 降级 summary 只有统计句+把 caption 原文当总结；(b) notice 被截成 "no per-student feedback could be…"；(c) memo 富文本 HTML（`<p><mark data-memo-id=…>`）结构性泄漏进 summary；(d) Highlight memo 卡重复显示上方笔记已高亮的原文。**修复**：**(a) 真总结**=新增 `synthesizeDegradedOverviewSummary`（llm-synthesizer.ts，轻量 LLM 把面试官发言+notes 概括成 2-5 条中文要点，JSON bullets），`buildDegradedSummarySections` 加 `llmBullets` 参数（非空→"内容小结"段替代原样拼接+notes 两段），三条降级 fork（finalize 两路径+cache-refresh）接线、失败回退确定性拼接（降级报告永不变空）；**(b)** notice 专用 400 上限不再拦腰截断；**(c)** 新增 `stripHtmlToText` 纯函数（保守正则剥 tag+entity 解码），notes 进 summary/LLM prompt 前剥净；**(d)** `isMemoTextDuplicateOfNotes`（memoHighlight.ts）——mark 仍在笔记 HTML 里时 memo 卡只显 chip+时间戳（`9864faa`/`fa3582c`）。**对抗式复审（3 视角+逐发现核实，16 子代理）确认 3 真问题并补修**：(1) **critical｜(d) 实为 no-op**——SidecarView 写进 mark 的 id 和 store memo 的 id 是两次独立随机生成、永不相等（测试 fixture 手工对齐 id 掩盖了分叉）→ `sessionStore.addMemo` 加可选 id 参数、SidecarView 传同一 memoId、补穿透真实管线的 store 回归测试（`6f19931`）；(2) **major｜cache-refresh 的 LLM 在 feedback-open 同步路径**——10s 新鲜窗后每次历史重开都重打 DashScope（120s×3 契约、无复用、措辞漂移、finalize 好小结可被失败回退静默覆盖）→ prior degraded cache 已含"内容小结"直接复用不打 LLM + `callDashScope` 加 `{maxRetries,maxTokens}` 覆盖、降级小结走 15s/1 重试/512token 轻量契约 + 空 catch 加日志；(3) minor｜`stripHtmlToText` 实体解码顺序（`&amp;` 必须最后解，否则字面 entity 双重解码）+ LLM 成功路径零集成覆盖 → 修顺序+补 orchestrator 集成用例（stubbed fetch→断言"内容小结"段）+ cache-refresh 复用护栏用例（fetch 零调用）——均入 `6b657fc`。6 项声称被怀疑者驳回为误报（locale 硬编码/asStringArray 对象/8000 字符截断/`<[^>]+>` 吞纯文本/presence 判定/独立超时项）。**worker 781 / desktop 392 全绿，tsc/typecheck 清，vite build 通过，4 commit 零 co-author**。已部署 Worker Version **fec14d61** + 重建 dist。**待用户 round-6 重测**：降级 summary（应见"内容小结"真总结、完整 notice、无 HTML 泄漏）+ Session Notes memo 卡（新会话的 Highlight 卡只显标签+时间戳；旧会话数据 id 已分叉仍显原文，属预期）。

  - [x] ⑪ **降级报告（`degraded_no_participants`）重建 overview summary + 不盲挂无关 evidence（worker 侧，TDD + 三视角审查 approve_with_notes 后补边界）**：真人 1v1 复测（只有面试官/teacher 流说话、无候选人发言 → per_person 空 → 走降级报告）暴露两个问题：(1) OVERVIEW 的 Summary 极空洞——降级 fork 从不重建 `summary_sections`，原封沿用 memo-first 那句通用占位「本场记录已生成，建议结合个人维度反馈查看。」，面试官说了很多话、又写了 session notes，summary 却什么都没总结；(2) Summary 盲挂无关 evidence——memo-first 按 evidence 数组顺序取头 4 个（`globalEvidenceRefs.slice(0,4)`）作为 summary 的 `evidence_ids`，数组头部恰是面试官开场白 quote，与 summary 内容毫无语义关系。**改动**：新增纯函数 `buildDegradedSummarySections`（`feedback-helpers.ts`）——确定性拼接（无 LLM，零额外成本/延迟/失败点）重建降级 summary：① 首段用调用方传入的 `notice`（三处 fork 已算好同一常量）+ 有发言时补确定性统计「共 N 段发言、总时长约 M 秒」（直接从 transcript 算）；② 面试官/teacher 流发言要点（按时间序，滤掉 <12 字开场白）；③ session notes 摘要。所有段 `evidence_ids` 一律置空 `[]`（不盲挂头部 evidence）。**三条降级 fork 全部接入且行为一致**：`feedback-cache-refresh.ts`（history-reload 路径）、`finalize-orchestrator.ts` 的 full 与 report-only 两条路径。只改降级路径，正常（有候选人）报告的 summary/evidence 逻辑不变。**三视角审查 approve_with_notes 后补边界（important）**：(a) teacher 发言全被 <12 字过滤且无 notes → summary 只剩 notice 空洞 → 加兜底：过滤后为空则退回取最长 1-2 条原始发言（去字数门槛）；(b) 完全无 teacher 发言 → notice 段补「N 段/M 秒」统计（0 段则不虚构）；(c) `stream_role` 全 undefined/非 teacher 的降级场景 → `collectInterviewerUtterances` fallback：无任何 `stream_role==="teacher"` 时把所有非空 utterance 视为面试官候选（降级场景已无学生发言）。**minor 清理**：消除 dead param——`notice` 参数此前声明却从不引用（首段硬编码中文），改为真正使用 `params.notice` 生成首段，JSDoc 同步。**新测试** `tests/degraded-summary-rebuild.test.ts`（11 例：helper 单元 6 例含 notice param 真用 + 3 边界兜底 a/b/c + evidence 全空 + 不产通用占位；orchestrator report-only 集成 2 例含正常路径回归）+ `feedback-cache-refresh-degraded.test.ts` 增 BRANCH A2（history-reload fork 降级 summary 集成）。**worker 761 全绿（基线 749），typecheck 清，零 co-author**。只改 edge/worker（`feedback-helpers.ts`/`feedback-cache-refresh.ts`/`finalize-orchestrator.ts` + 2 测试文件），不动 desktop。

### Phase A 前置验证门（删 inference 前必须通过 pilot，需 Speechmatics key）
> **2026-06-27 实测**（`scripts/speechmatics_rt_validate.mjs`，真实 Speechmatics key + 真实样本）
- [x] cmn_en + 实时 + diarization=speaker 三者同时可用且返回每词 speaker（官方无矩阵，必须实测）✅ language_pack="English and Mandarin"；alice+bob→S1/S2 切换点 6.11s≈拼接边界 6.0s；每词带 speaker+词级时间戳；三者同会话共存
- [~] 真实 3–4 人群面**重叠音频**的 diarization 错误率（DER/误切换率）达标 —— 顺序双人正确;**重叠场景仍需真实群面音频 pilot**
- [ ] 实时免费/付费**并发额度**与确切单价（portal 实测；注意每场=2路流）—— 账户实时用量当前为空,需 portal 查
- [ ] CF DO **持久双出站 WS + 静音保活 + 重连** 实跑验证（dashscope-asr.ts 是短连，不能作证）—— 待 A1 实现 + 部署
- [x] 16000Hz sample_rate 被 Speechmatics 接受 ✅
- 备注:cmn_en 下英文 ASR 正常("History and belonging…passionate");en/zh 3s 短样本转写为空(样本质量),中文 ASR 质量待真实样本验证

**🧪 首次端到端云端 pilot（2026-06-29，合成 4 嗓音音频对生产 api.frontierace.ai）**:
- ✅ 架构端到端通:WS 首帧鉴权 → Speechmatics 实时 ASR(英文质量好)→ A2 转写下行 → finalize(events/report/persist)→ ResultV2 + cleaned_transcript。
- ❌→修:报告降级 memo_first(`report_model=null`)。根因实锤=**阿里云 DashScope 欠费 Arrearage**(直接 curl 实测),账户问题非 bug;待用户充值后重跑验真 LLM。
- ❌→修:群面全 unknown → **B3 已修**(commit 1479225)。
- ⚠️→修:finalize ~180s(死 inference 地址超时)→ **INFERENCE_ENABLED cleanup 已修**(commit 5ee03bf,events 走本地/improvements 跳过)。
- ⚠️ 合成 TTS 4 嗓音 diarization 只分 S1/S2(嗓音太接近);真实重叠 DER 仍需真人群面录音。
- ✅ **已合 main + 部署 + 复测**(生产 Version a6a34cbd)。用户充值 + 指定 **qwen3.7-plus**(推理模型,已 `enable_thinking:false` 否则 133s 撞超时)。第3次 pilot:`source=llm_synthesized, model=qwen3.7-plus, degraded=false`,finalize **83s**。A5 ✅ 真 LLM 报告。
- ⚠️ **B3 命名待真人验**:Speechmatics 逐词 emit utterance → 自我介绍碎片化,已加 `mergeStudentUtterancesBySLabel` 按 S 标签合并后抽名(commit a6a34cbd,单测过);但合成 TTS diarization 崩塌(S1 含 4 人)无法验命名 → **需真人 3-4 人群面录音**验 B3 命名 + DER。
- 📌 下一步真问题:Speechmatics handler **逐词分句**是根因(也害证据粒度)→ 根治=handler endpointing/断句(需真实流验)。

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

Validation Date: 2026-06-29（UI 重设计 `feat/ui-liquid-glass`）
- [x] `cd desktop && npx tsc --noEmit` -> passed
- [x] `cd desktop && npx vitest run` -> **234 tests passed**
- [x] `cd desktop && npx vite build` -> production build passed
- UI: 浅色液态玻璃 + 橘橙单 accent + GSAP `back.out` SegmentedControl;全站对比度迁移(text-accent→accent-ink、白字→on-accent，26 文件)；其余 5 视图自动翻浅 + 残留清理(隐形 tint、登录按钮、bg-white→bg-surface)

Validation Date: 2026-06-30（Phase R 链路鲁棒性硬化 `claude/ecstatic-chaum-51c7eb`，基于 main 9fb7cee）
- [x] `cd edge/worker && npx vitest run` -> **575 tests passed**（基线 534 → +41 新覆盖：speechmatics-config 9 / asr-keepalive 9 / asr-backpressure 13 / dual-stream-report 10）
- [x] `cd edge/worker && npm run typecheck` -> passed
- [x] `node --check desktop/e2e_dual_stream_test.mjs` -> 通过（live 冒烟延迟到 R1，无 Speechmatics key）
- [x] 全分支 opus 最终评审 -> **Ready to merge**（5 任务每任务 2 道独立评审 + 跨切面交互核验通过）
- [x] 已合 main + feat/phase6 + 部署生产（最终版本 482085a5，含两个 R1 热修）

**🎯 R1 双流真实音频验证（2026-06-30，The Exchange SOHO=面试官 mic 100s + Qingnian Road=学生群面 8.3min，realtime `--chunk-delay 1000` 对生产 482085a5）**：
- ✅ **dual-stream 契约成立**：两路并发摄取→teacher 推完干净关闭→finalize 91s 成功。transcript stream roles=teacher+students。
- ✅ **学生分离+命名**：4 位 Kenny Tan(155s/10轮)/Stephanie(139s/5)/Alice(96s/5)/Bob(60s/6)；per-person 4 人真分数；qwen3.7-plus degraded=false，**14 条证据 claim**。
- ✅ **面试官(teacher)排除出 per-person**（无 Interviewer 卡片，R-T4 成立）；Interviewer 50s/2轮只在 speaker stats，不计分；teacher 两条仍在 transcript 喂 LLM。
- 🔥 **过程揪出并修掉 2 个生产级 latent bug**（修复前同一音频：学生全 unknown / 4 claims → 修复后 4 命名学生 / 14 claims）：hotfix-1 `6994e45`(DO 构造器 inference URL，自 C3 起 prod 开不了会话)、hotfix-2 `4674735`(diarization 默认 edge→cloud，真实 app 同样中招)。详见 §2.5 Phase R。
- ⚠️ 非阻塞瑕疵(Phase Q)：① "please call me Rice" 绑成 roster 名 Alice（B3 preferred-name 缺口；真实会议 roster 是真名故影响小）② harness "interviewer context: false" 是弱检查(teacher 实际在 transcript)，可优化 harness 判定。

**🛠 真实 app 多人流程审计 + 修复（2026-06-30，为「真实使用软件、多人真实测试」准备；prod 版本 9f80f499）**：R1 验证的是 harness 路径，真实 Electron app 路径(不 POST /config、靠 hello 帧 + 服务端默认)此前未验。只读审计(`audit-app-flow`)发现并修了 3 个阻塞缺口：
- [x] **P1 group 被当 1v1**（commit 2bd6cb6）：真实 app 从不发 `mode`，worker 默认 1v1 → 群面报告用错语义。修：`mode` 经 SetupView→`wsService.connect`→hello 帧→worker `updateSessionConfigFromHello` 解析(仅认 1v1/group，条件写)→`state.config.mode`→finalize。新 `tests/hello-mode.test.ts` 12 例。**已部署**(P1 worker 改动须部署才生效)。
- [x] **P2 系统音频静默失败**（commit 9f1d448）：屏幕录制权限缺失/无音轨时 students 流静默无声、无提示 → 可能录完整场零学生音频。修：`AudioService.initSystem` 检测 3 种失败(permission/no-track 早退停轨/other)→`systemAudioFailureReason`；`SidecarView` 持久琥珀横幅(`isCapturing && !systemReady`)+ 一次性 toast(ref 守卫)，复用此前未接线的 ToastContainer。不硬阻断。
- [x] **P3 面试官名恒空**（commit c74187e）：SetupView 硬编码 `interviewerName:''`、无输入框。修：加英文输入框「Your name (interviewer)」(选填，空→undefined)，经 hello 送达。
- 审计同时确认 ✅：双流采集(mic→teacher / 系统 loopback→students)路由正确、PCM 16k/mono/s16le 对、finalize 自动触发+10min 轮询、prod base URL/key 经 IPC 就位、desktop tsc 过。
- [ ] **跟进(低优)**：`useAudioCapture.initSystem`(SettingsView 音频测试面板用)是未升级的平行实现(no-track 仍 throw、cancel 检测弱)——录音期走 SidecarView 路径不受影响，但建议后续对齐或让 SettingsView 走 AudioService。

## 7. 当前阻塞与处理
- **[架构] 旧架构依赖自建推理**：`if.frontierace.ai` 是开发机 tunnel（现 1033 不健康），不满足"用户零部署"。→ Phase 6 用 Speechmatics + Worker 直调 LLM 取代，删除 `inference/`。
- **[P0 bug] Desktop 生产版连不上云端**：`VITE_EDGE_BASE_URL` 未定义 → `baseApiUrl=''`。→ Phase 6 A3 修。
- **[P0 bug] 录音时转写不回传 Desktop**：非 Teams 会议零实时字幕零持久化。→ Phase 6 A2 修。
- **[待核实] Speechmatics `cmn_en` 实时可用性/单价 + CF 并发 outbound WS 限制**：commit 前实测。
- **OAuth 配置未完成**（历史阻塞，架构落地后再处理）：需创建 Azure App Registration 和 Google Cloud OAuth Client ID。
- **[Phase R 待办] 部署需 Cloudflare auth**：Phase R 代码已 Ready-to-merge（分支 `claude/ecstatic-chaum-51c7eb`，575 测试绿），但 `wrangler deploy` 需登录态；R1–R5 live gate 必须先合并+部署再由用户跑真实会议。合并到 main + 同步 `feat/phase6-cloud-companion` 待用户确认。

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
