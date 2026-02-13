# AI Handoff：详细代码审查与风险清单（2026-02-12）

## 0. 审查范围与基线
- 仓库：`/Users/billthechurch/Interview-feedback`
- 基线提交：`bf97970`
- 本地未提交变更：
  - `/Users/billthechurch/Interview-feedback/desktop/main.js`
  - `/Users/billthechurch/Interview-feedback/desktop/renderer.js`
- 验证状态：
  - `pytest`: 22/22 通过
  - Worker typecheck 通过
  - Desktop JS 语法检查通过

---

## 1. 架构与实现细节（按代码真实行为）

### 1.1 Inference（FastAPI）
关键入口：
- `/Users/billthechurch/Interview-feedback/inference/app/main.py`

核心编排：
- `/Users/billthechurch/Interview-feedback/inference/app/services/orchestrator.py`

实现事实：
- 音频统一 ffmpeg 归一化后处理：`/Users/billthechurch/Interview-feedback/inference/app/services/audio.py`
- VAD 分段 -> embedding 聚合 -> cluster assign -> identity 决策。
- 新增 enrollment：`POST /speaker/enroll` 累积 `participant_profiles`。
- `resolve` 明确禁止 `confirm + null`。

数据结构扩展：
- `/Users/billthechurch/Interview-feedback/inference/app/schemas.py`
  - `SessionState.participant_profiles`
  - `SessionState.cluster_binding_meta`
  - `ResolveEvidence.profile_* / binding_source / reason`

### 1.2 Worker（DO 状态编排）
关键实现：
- `/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts`

实现事实：
- 路由契约：
  - 旧接口兼容保留
  - enrollment + cluster-map + unresolved 新接口已落地
- ASR 主链为实时常驻 WS（`ASR_REALTIME_ENABLED=true`）。
- students 端 utterance 触发 inference resolve；失败写事件但不阻断 ASR 主链。
- teacher 端直接 identity bind（按优先级）。

状态写入：
- `state` 中含 `ingest_by_stream`、`asr_by_stream`、`capture_by_stream`、`enrollment_state`、`participant_profiles`、`cluster_binding_meta`。

### 1.3 Desktop（Electron）
关键实现：
- `/Users/billthechurch/Interview-feedback/desktop/renderer.js`
- `/Users/billthechurch/Interview-feedback/desktop/index.html`

实现事实：
- 双流上传 teacher/students。
- system track ended 自动恢复（重试退避）。
- 去串音规则使用相关性 + 能量比。
- Enrollment UI 与手动 cluster mapping UI 已打通。

---

## 2. Code Review Findings（按严重级别）

### [P1] Realtime ASR 队列是内存态，DO 重启后存在实时转写空洞风险
位置：
- `/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts:1395`
- `/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts:2040`
- `/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts:2051`

现象：
- `sendQueue`、`currentStartSeq`、`sentChunkTsBySeq` 都在 `AsrRealtimeRuntime` 内存中。
- chunk 虽然已落 R2，但 DO 被驱逐/重启时，这些实时发送状态不会自动从 R2 回放恢复。

影响：
- 会中短时间可能“收到音频但无实时 utterance 产出”，需靠后续 `asr-run` 补算追平。

建议（面向下一版）：
- 引入“realtime replay cursor”（持久化 last_sent_seq / last_emitted_seq）。
- DO 恢复时自动从 R2 顺序回放缺口，而不是仅依赖内存队列。

### [P2] Inference 决策逻辑已从 Binder 外移，存在策略双轨漂移风险
位置：
- `/Users/billthechurch/Interview-feedback/inference/app/services/orchestrator.py:30`
- `/Users/billthechurch/Interview-feedback/inference/app/services/orchestrator.py:37`
- `/Users/billthechurch/Interview-feedback/inference/app/services/binder.py`

现象：
- `BinderPolicy` 仍被注入并维护测试，但当前 `resolve()` 主逻辑在 orchestrator 内部手写，`self._binder` 未被调用。

影响：
- 后续若只改 `binder.py` 或只改 `orchestrator.py`，策略可能不一致，产生回归风险。

建议：
- 统一单一决策源（要么 Binder 完整承载，要么删除 Binder 并迁移测试到 orchestrator）。

### [P2] `cluster-map` 允许写入不存在的 cluster_id，可能污染绑定状态
位置：
- `/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts:3205`
- `/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts:3214`
- `/Users/billthechurch/Interview-feedback/edge/worker/src/index.ts:3221`

现象：
- API 只校验 `cluster_id` 非空，不校验 `cluster_id` 是否在 `state.clusters` 中存在。
- 因此能写入“悬空 binding meta”（例如 `c-test`）。

影响：
- 会话状态可能出现无法追溯到真实声纹聚类的绑定，影响审核和回放解释。

建议：
- 默认强校验 cluster 存在；若要允许预绑定，需显式模式字段并标记状态。

### [P3] NameResolver 当前主要覆盖英文名模板，中文/混合语料命中率受限
位置：
- `/Users/billthechurch/Interview-feedback/inference/app/services/name_resolver.py`

现象：
- 规则正则和 token 过滤以 `[a-z]` 为主，中文名提取能力有限。

影响：
- 中英混合会议里“转写抽名”路径命中率低，更多依赖 enrollment/manual map。

建议：
- 增加中文姓名规则（含常见自我介绍模板）并配合 roster fuzzy。

### [P3] Desktop 启动崩溃问题尚在定位阶段（已有诊断增强但未入主线）
位置：
- `/Users/billthechurch/Interview-feedback/desktop/main.js`（未提交）
- `/Users/billthechurch/Interview-feedback/desktop/renderer.js`（未提交）

现象：
- 你反馈“启动即崩溃”；目前新增了 `render-process-gone`、`uncaughtException`、`unhandledrejection` 诊断。

影响：
- 会影响实机验证稳定性与节奏。

建议：
- 先把崩溃 repro 最小化并固定启动方式（`open -na ... --args ...`）；
- 采集一轮稳定崩溃日志后再做根因修复并提交。

---

## 3. 当前“已完成 / 未完成”判定（严格对齐 Task）

已完成：
- 双流 ingest + realtime ASR 主链
- FunASR 模型纠偏并固定
- raw/merged 双视图
- teacher 身份优先级
- enrollment + manual mapping API 与 UI
- `confirm+null` 策略漏洞修复

未完成（门禁未打勾）：
- 真实 Teams 5~10 分钟实机 SLO
- 无耳机场景重复率目标
- enrollment 实机命中率门禁（unknown ratio）
- manual map 后 unresolved=0 的闭环验收

---

## 4. 与其他 AI 讨论新方案时的“不可变约束”
1. 不允许破坏现有 API 契约（尤其 `state/events/utterances/finalize`）。
2. 任何新策略必须兼容双流会话模型（teacher/students 独立状态）。
3. 实时主链必须继续“失败隔离”：inference 失败不能阻断 ASR 主链。
4. 优先级规则不变：`Teams参会者 > 会前配置 > 转写抽名 > teacher`。
5. 手动映射是生产兜底，不能删。

---

## 5. 建议给外部 AI 的讨论主题（高价值）
1. Realtime ASR “可恢复队列”设计（DO 重启自动 replay）。
2. 策略引擎单一化（Binder 与 orchestrator 去重）。
3. cluster-map 一致性约束（防悬空绑定）。
4. 多语种姓名抽取策略（中文/英文统一）。
5. Desktop 崩溃根因定位与可观测性最小集。
