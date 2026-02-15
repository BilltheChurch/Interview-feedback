# Task Tracking (Strictly Aligned With PRD / 开发计划 / 快速启动指南)

Last Updated: 2026-02-15
Workspace: `/Users/billthechurch/Interview-feedback`

## 0. 文档基线（执行必须对齐）
- `/Users/billthechurch/Interview-feedback/docs/source/PRD_实时群面记录系统_英文版.md`
- `/Users/billthechurch/Interview-feedback/docs/source/开发计划.md`
- `/Users/billthechurch/Interview-feedback/docs/source/快速启动指南.md`
- `/Users/billthechurch/Interview-feedback/docs/source/开工行动清单_MVP-A_从零开始_v2.0.md`
- `/Users/billthechurch/Interview-feedback/docs/mvp/*.md`
- `/Users/billthechurch/Interview-feedback/docs/plans/*.md`

## 1. 当前阶段
- Current Phase: **Phase 5（实机验收 + OAuth 配置 + Beta 上线）**
- Why: Phase 4 Production Readiness 全部完成。Desktop 已具备 React + Vite + TypeScript + Tailwind v4 技术栈、OAuth 登录、日历集成、PiP、UI/UX 打磨。需要完成 Azure/Google OAuth 配置后进行首次实机端到端验收。

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

## 3. 当前待办（Phase 5）

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
- **OAuth 配置未完成**：需要创建 Azure App Registration 和 Google Cloud OAuth Client ID，否则无法进行实机登录测试。
- **Speaker Diarization 模型缺失**：当前仅有 Speaker Verification（CAM++），无独立 SD 模型。MVP 阶段通过 SV+聚类+enrollment 覆盖需求，不阻塞 beta。
- **实机验收未执行**：所有代码就绪，等待 OAuth 配置完成后进行首次端到端验收。

## 8. 设计文档索引
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

## 11. 下一步（立即执行）
1. **Azure App Registration 创建** → 获取 `MS_GRAPH_CLIENT_ID`
2. **Google Cloud OAuth 配置** → 获取 `GOOGLE_CALENDAR_CLIENT_ID` + `SECRET`
3. **填入 desktop/.env** → 验证 OAuth 登录流程
4. **首次实机端到端验收** → 录制 + 转写 + feedback 全流程
5. **Phase 5 门禁验收** → P95<=5s, unknown_ratio<=15%, confirm_without_name=0
