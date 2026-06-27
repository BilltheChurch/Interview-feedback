# 云端化 + Companion + Speechmatics 架构重定向设计

Status: **In Progress**
Created: 2026-06-27
Owner: 总统大人 / Claude

> 本文档是一次**架构重定向**的设计基线，取代旧的"本地推理 + DashScope FunASR + 自建 CAM++ 说话人识别"假设。
> 后续实现严格对齐本文档与 `Task.md`。

---

## 0. 一句话定位

**Chorus = 会议记录 + 实时多流转写 + 用户批注 + 会后即时总结/复盘（Granola for interview/coaching）。**
第一形态为 **Companion**：用户继续用 Teams/Zoom/腾讯会议，Chorus 旁路采集音频、记笔记、会后快速出报告。
用户**开箱即用，零本地部署**（不装 Docker、不跑模型、不开服务）。

---

## 1. 已锁定决策（2026-06-27）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 语音转写方案 | **云 API 起步**（实时 + 会后均用托管云 STT，零自建 GPU） |
| D2 | 产品形态 | **Companion 优先**（接入现有会议软件），Room（自建会议+白板）作为第二形态 |
| D3 | 实时 STT 供应商 | **Speechmatics**（实时 + 实时 diarization + 实时中英双语 `cmn_en` + 命名声纹 + 50h/月免费） |
| D4 | 说话人分离 | **硬需求**。1v1 与 1vN 群面**同等重要、同样高频**，必须支持说话人日志/分离 |
| D5 | 会后交付 | **一次性交付**（不强制分 Tier），延迟上限 **3–5 分钟**；内部用 `deliverable` 开关支持"只要纪要不要评分"的通用场景 |
| D6 | 自建推理服务 | **MVP 不要任何自建服务器**。Speechmatics 取代自建 ASR/SV/diarization；LLM 合成移入 Worker 直调 LLM API |

---

## 2. 现状审计结论（带证据，2026-06-27 多 agent 审计）

### 2.1 三个必修 bug（与方案无关，最高优先）
1. **生产版 Desktop 连不上云端**：`SetupView.tsx:867` 读 `VITE_EDGE_BASE_URL`，但 `.env.production` 只定义 `API_BASE_URL`（无 `VITE_` 前缀，Vite 不暴露给渲染进程）→ `baseApiUrl=''` → WS 拼出 `ws:///v1/...` 畸形地址，所有云调用被跳过。
2. **录音时 Worker 不回传转写**：`WebSocketService.ts:141` 入站只认 `type==='ready'`，忽略所有转写帧。非 Teams 会议（Zoom/腾讯/线下）**零实时字幕、零客户端持久化**。
3. **满地 `127.0.0.1:8000` 硬编码 fallback**：`realtime-asr-processor.ts:306`、`incremental-processor.ts:129/292`、`finalize-orchestrator.ts:1631`。光改 wrangler 无效，env 缺失时 Worker 会偷连不存在的 localhost。

### 2.2 两个架构现实
- **"云 API" ≠ "没有自己的服务"**：旧架构里说话人识别（CAM++ + 聚类）和 LLM 报告编排仍跑在 `inference/`（即 `if.frontierace.ai`，一个**自建 GPU 栈**的 tunnel，当前 1033 不健康）。本次重定向用 Speechmatics 取代 SV/diarization、用 Worker 直调 LLM 取代 LLM 编排，从而**彻底删除 `inference/` 与 `if.frontierace.ai`**。
- **实时 STT 现状**：旧实时路径 `realtime-asr-processor.ts:778` 永远走 DashScope FunASR（与 `ASR_PROVIDER` 无关）；Groq/OpenAI provider 是**死代码且仅批处理**。Speechmatics 为净新接入。

### 2.3 Granola 交付物差距
- ✅ 好消息：用户 note + mark **已经**喂进 LLM 合成（`finalize_v2.ts:1542` 带 memos+free_form_notes）。
- ❌ 缺口：输出是"面试打分"形状（per_person 能力维度 + overall 叙述），**没有**整理过的逐字稿、**没有**精简会议总结、**没有**贴合用户书写风格的个性化 memo。transcript 合成前被截到 4000 token（长会议丢中段）。`ResultV2`(`types_v2.ts:245`) 无对应字段。

---

## 3. 供应商选型依据（七家实测对比，已对抗复核）

判据：英文为主 + 偶有中英混说 + 实时 + 说话人分离（1v1 & 群面）+ 零自建 + 会后快速。

| 供应商 | 实时分人(live) | 实时中英混说 | 命名声纹 | 词级时间戳 | 实时价格 | 结论 |
|---|---|---|---|---|---|---|
| **Speechmatics** | ✅ 每词带 speaker | ✅ `cmn_en` 双语 | ✅ 实时 | ✅ | ~$0.13–0.40/h（待核实），50h/月免费 | **选定** |
| Deepgram | ⚠️ v1 流式分人质量差 | ❌ 中文不在混说集 | ❌ | ✅ | ~$0.35/h，$200 额度 | 备选 |
| AssemblyAI | ✅ | ⚠️ 中文仅 premium preview | ❌ | ✅ | $0.15/h+附加 | 备选 |
| Azure | ✅ Guest-1/2 | ❌ 仅跨句 | ❌(已下线) | ✅ | ~$1.30/h | 不选 |
| Gladia | ❌ 实时不支持(仅声道) | ✅ | ❌ | ✅ | $0.75/h | 不选 |
| DashScope FunASR | ❌ 实时不支持 | ⚠️ 句内不保证 | ❌ | ✅ | 待核实 | 不选 |
| OpenAI | ❌ diarize 不在 Realtime | ⚠️ 不确定 | ✅ 仅批 | ❌ gpt-4o 无时间戳 | $0.003–0.017/min | 不选 |

**选 Speechmatics 的决定性理由**：唯一同时满足 D3+D4（实时 diarization + 实时中英双语 + 命名声纹）。群面里多候选人共用 `students` 声道，必须靠它声道内分人。

**待 commit 前核实**（来源：官方文档 + 厂商 blog + Pipecat 第三方集成，非首方"模式矩阵"）：
1. `cmn_en` 双语模型在**标准托管实时端点**对所选 region/账户层是否可选；
2. 实时确切单价（文档 $0.129/h 与聚合源 $0.24–0.40/h 不一致）；
3. 群面重叠语音下 diarization 质量（需真实音频 pilot）。

---

## 4. 目标架构

### 4.1 数据流

```
用户电脑 Chorus Desktop (Companion)
  ├─ mic (interviewer)      ──WS ch=teacher──┐
  ├─ system audio (cands)   ──WS ch=students─┤   1s PCM16 16kHz mono
  └─ notes / marks (带 time_ms)              │
                                             ▼
        Cloudflare Worker + Durable Object + R2  (我们的全部"云端")
          ├─ 每条声道 → Speechmatics Realtime WS
          │     config: diarization=speaker, language=en|cmn_en, enable_partials
          │     ← partial/final transcript (text + speaker S1/S2/.. + word ts)
          ├─ 角色判定: 声道=teacher → 面试官; 声道=students → 候选人
          │     候选人具体是谁: diarization 标签 (+ 可选命名声纹 enrollment)
          ├─ [NEW] 转写帧回推 Desktop (实时字幕下行协议)
          ├─ 转写分段持久化 (DO/R2;  Desktop 侧也落地, UI 关也不丢)
          └─ on stop (一次性, ≤3-5min):
                Worker → LLM API (DashScope qwen / OpenAI / Claude)
                  单次合成 → ①整理逐字稿 ②精简总结 ③个性化memo ④打分表(可开关)
                  (note/mark 作为"用户强调信号"做个性化)
                          ▼
                  R2 (ResultV2) + FeedbackCache + D1 + History
                          ▼
Desktop: 录音中实时字幕 (P95≤5s); 结束后 ≤3-5min 全量报告
```

### 4.2 两层说话人结构（关键设计）
- **第一层（确定性）**：声道决定角色。`teacher` 声道 = 面试官；`students` 声道 = 候选人整体。永不混淆。
- **第二层（diarization）**：仅在 `students` 声道内，用 Speechmatics 实时分人得到 S1/S2/S3…；再通过**命名声纹 enrollment**（开场每人念一句）或**手动映射 UI**（复用现有 `/cluster-map`、`/unresolved-clusters`）映射到候选人姓名。
- 1v1：第二层退化为单说话人，零额外成本。群面：第二层提供多候选人区分。

### 4.3 Granola 会后交付物（一次性、note-aware）
单次 LLM 合成同时产出，写入 `ResultV2` 新字段：
- `cleaned_transcript`：说话人标注 + 轻清洗（filler / ASR 错误）的逐字稿；长会议分块清洗兜底。
- `summary`：会议级 TL;DR + 关键节点（非"面试评估叙述"）。
- `personalized_memo`：以用户 note/mark 为强调信号、贴合用户书写风格的备忘录。
- `per_person` 打分表：受 `deliverable`/quality-gate 控制，可开关；**即使评分被门禁标记 tentative，纪要/逐字稿/memo 也照常先出**（解耦交付）。

---

## 5. 组件改动清单（按子系统 × 优先级）

### 5.1 Edge Worker
- **[P0] 新增 Speechmatics 实时 provider**：DO 内对每条声道开 outbound WS 到 `wss://eu.rt.speechmatics.com/v2`，发送 PCM16，接收 partial/final + per-word speaker。模式已被现有 `dashscope-asr.ts` 的 outbound WS 验证可行。
- **[P0] ASR dispatch 改造**：`getAsrProvider` / `ensureRealtimeAsrConnected` / `runWindowedAsr` 增加并默认 speechmatics；摘除"实时永远 DashScope"的隐式绑定。
- **[P0] 转写帧下行协议**：Worker → Desktop ingest WS 推送 `{type:'transcript', role, speaker, text, is_final, ts_ms, words}`。
- **[P0] 删除 4 处 `127.0.0.1:8000` fallback**；`wrangler.jsonc` 切云端配置（见 5.4）。
- **[P0] LLM 合成移入 Worker**：将 `inference/app/services/report_synthesizer.py` 的 prompt 构建 + LLM 调用 + 解析移植为 Worker 端直调 LLM API（DashScope/OpenAI/Claude），从而删除对 `inference/` 的依赖。`finalize-orchestrator.ts` REPORT 阶段改调本地合成函数。
- **[P0] 删 `local_asr` finalize 阶段**（`finalize-orchestrator.ts:667`）：逐字稿来自实时流，不再会后批量转写。
- **[P1] 输出新字段**：`types_v2.ts` `ResultV2` 增 `cleaned_transcript`/`summary`/`personalized_memo`；合成 contract 增 `deliverable`/`want_summary`/`want_cleaned_transcript`/`personalize_to_notes`。
- **[P1] reconcile 改造**：speaker binding 改用"声道 + diarization 标签 + 命名声纹/手动映射"，移除 CAM++ 聚类依赖（`global-cluster.ts` 在 MVP 不再需要）。
- **[P1] 质量门禁可配置**：`enforceQualityGates` 的 `unknown_ratio` 等阈值 env 化；纪要交付与评分门禁解耦。
- **[P2] 删 Tier2/batch 自建依赖**：`tier2-processor.ts`、`incremental-processor.ts` 中的 inference 批处理路径（依赖自建 GPU），MVP 移除或重写为云端。

### 5.2 Desktop
- **[P0] 修 base URL**：统一为 `VITE_EDGE_BASE_URL`（或通过 IPC 从 main 的 dotenv 读 `API_BASE_URL`），并补 `VITE_WORKER_API_KEY`。
- **[P0] 转写入站 + 持久化**：`WebSocketService` 入站处理 `transcript` 帧 → store 新增 `transcriptSegments[]` + `appendTranscriptSegment`；无论当前在哪个 view 都落地。
- **[P0] PersistedSession 纳入 transcript/captions**：reload/crash/PiP 不丢实时转写。
- **[P1] mark/note 精确锚点**：`addMemo` 写 `anchor.time_ms`（含亚秒），对齐逐字稿时间轴。
- **[P1] 通用实时字幕**：`CaptionPanel` 由 `transcriptSegments` 驱动（覆盖非 Teams 会议），不再 ACS-only。
- **[P1] 命名声纹 enrollment UI**：开场每候选人录 2–10s 片段，传 Worker 供 Speechmatics enrollment（替代/兼容现有 enrollment 向导）。
- **[P2] 删本地推理痕迹**：移除 `lib/diarizationSidecar.js`（pyannote-rs 本地 sidecar）及其 IPC；删 `useWebSocket.ts` 重复 hook；删 Settings 里 `localhost:8000/batch/process` 文案。

### 5.3 Inference（`inference/`）
- **[P2] 退役**：ASR（sensevoice/moonshine/paraformer）、SV（CAM++）、diarization（pyannote）全部由 Speechmatics 取代；LLM 合成移入 Worker 后，整个 `inference/` 在 MVP 可归档/删除。
- **[P2] 退役 `if.frontierace.ai`** Cloudflare Tunnel。

### 5.4 配置（`wrangler.jsonc`）
- `ASR_PROVIDER` → `speechmatics`；删 `ASR_ENDPOINT`(localhost)；`ASR_TIMEOUT_MS` 降到云端量级（30–60s）。
- 新增 secret：`SPEECHMATICS_API_KEY`；保留 LLM key（`ALIYUN_DASHSCOPE_API_KEY` 或换 `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`）。
- 删 `INFERENCE_BASE_URL_SECONDARY=127.0.0.1`；MVP 删除/置空所有 `INFERENCE_BASE_URL_*`（合成移入 Worker 后不再需要）。
- `TIER2_*`、`DIARIZATION_BACKEND_DEFAULT=local`：MVP 关闭或移除。
- 修 staging env 的 localhost 指向。

---

## 6. 分阶段实施计划

### Phase A — P0：云端可用闭环（"用户零部署 + 实时转写 + 能出报告"）
A1 Speechmatics 实时 provider + dispatch
A2 Worker→Desktop 转写下行协议 + Desktop 入站/持久化
A3 修 Desktop base URL 配置
A4 删 127.0.0.1 fallback + wrangler 云端化
A5 LLM 合成移入 Worker + finalize 摘除 inference 依赖 + 删 local_asr 阶段

### Phase B — P1：Granola 交付物 + 说话人命名 + 质量
B1 ResultV2/合成 contract 新增 cleaned_transcript/summary/personalized_memo（一次性）
B2 note/mark 精确锚点 + 个性化信号
B3 diarization 标签 → 候选人命名（enrollment 或手动映射）
B4 质量门禁可配置 + 纪要/评分解耦
B5 通用实时字幕面板

### Phase C — P2：清理与通用性
C1 删本地 sidecar / 重复 hook / localhost 文案
C2 长会议分块清洗
C3 归档 `inference/` + 退役 `if.frontierace.ai`

---

## 7. 风险与待验证
- **CF Worker/DO outbound WS 限制**：每 session 需 2 条到 Speechmatics 的并发 outbound WS（mic+system）+ 1 条 inbound（Desktop）。需核实 DO 并发 WS 与时长限制（现有 DashScope 单 WS 模式已验证可行，但并发 2 条需确认）。
- **Speechmatics `cmn_en` 实时可用性 + 单价**：portal/账户实测。
- **群面 diarization 质量**：真实重叠语音 pilot；不达标则启用命名声纹 enrollment 兜底。
- **Speechmatics PCM 接入格式**：确认 16kHz/mono/pcm_s16le 配置（`sample_rate`/`encoding`）。
- **LLM 合成移植工作量**：`report_synthesizer.py` 较复杂，移植到 Worker（TS）为 L 级工作；过渡期可临时保留一个**极小无状态合成 Worker**而非 GPU 服务。
- **成本**：Speechmatics + LLM 按分钟计费；30 分钟模拟面试单场成本极低且在免费额度内，但需建监控防滥用。

## 8. 验收门禁（更新，对齐新架构）
- 实时字幕延迟 **P95 ≤ 5s**。
- 会后全量报告 **≤ 3–5 分钟**（30 分钟面试目标 ≤ 90s）。
- 说话人分离：1v1 声道分离 100%；群面 diarization 准确率实测并设阈值。
- **零自建常驻服务**（无 GPU/Docker/tunnel 依赖）。
- `unknown_ratio` 阈值随"声道+diarization"重新标定（移除硬编码 25%）。
- 用户**只安装 App**即可完成：登录 → 选会 → 录制 → 实时字幕 → 结束 → 出报告。

---

## 9. 红队评审结论与 v2 调整（2026-06-27，6-agent 对抗式评审）

裁决：6 个维度全部 **needs-adjustment**（无 broken / 无 sound）——方向成立，但以下调整为强制。

### 9.0 地基澄清（回应"要不要买 GPU"）
- **最终架构零 GPU、零自建服务**：仅 ① Speechmatics（云 STT+diarization）② 一个 LLM API（Worker 直调）③ CF Worker/DO/R2。`inference/` 与 `if.frontierace.ai` 全部退役。
- `inference/` 唯一需 GPU 的是 ASR/SV/diarization → 由 Speechmatics 取代；LLM 合成本就不需 GPU（仅 HTTP 调 DashScope），"移入 Worker"= 搬 HTTP 逻辑。
- **不走端侧模型**（用户机器跑模型 = 旧路线，慢/大/不一致/非开箱即用，已否决）。
- **"渐进迁移"= 代码层 feature-flag 保留旧路径以便回滚，NOT 部署任何服务器**。生产全程不碰 GPU。

### 9.1 站得住的假设（绿灯，已验证）
- CF DO 可持 2 出站 + 1 入站 WS（6-连接上限只算握手阶段）——非瓶颈。
- Speechmatics 接受 PCM16/16kHz/mono；返回每词 speaker + 时间戳，可映射。
- LLM 调用不受 Worker CPU 时限约束（等网络不计 CPU）；合成逻辑无重 Python 依赖、可移植。
- 现有 ACS caption 模式（`diarization-acs-caption.ts`）已是"外部 diarization 旁路 CAM++"范式，作 Speechmatics 模板。

### 9.2 数据修正（v1 写错的）
- ❌ v1 "50h/月免费" → ✅ 实时免费额度实为 **~20h/月**（50h 是批处理口径）；**免费层仅 2 路并发 = 同时只能 1 场面试**。
- **每场面试 = 2 路并发流（mic+system）**：付费 Pro 50 路 = 最多 25 场并发；单场 STT ≈ **$0.40(30min)/$0.80(60min)**。
- **Durable Objects 必须开 Cloudflare Workers 付费版** → "零成本"不成立；付费从第一天起。

### 9.3 强制设计调整
1. **逐字稿不过 LLM**：Speechmatics 已转好逐字稿；`cleaned_transcript` = 确定性清洗（说话人标注 + 轻去 filler），**LLM 只做 summary + personalized_memo + scorecard**。解决长会议 token 上限与 200-800s 解码延迟，保住一次性交付。
2. **渐进、纯云、零 GPU**（见 9.0）：先移植 LLM 合成入 Worker → 切 Speechmatics → 删 inference；旧路径 feature-flag 保留至 parity。
3. **群面 diarization = best-effort + 必须有兜底**：删 `global-cluster.ts` **之前**先把 `/cluster-map`、`/unresolved-clusters`、`resolveStudentBinding` 改接 Speechmatics 的 S 标签 ID 空间；保留手动纠正路径。
4. **teacher 声道关 diarization**（单一说话人，避免把面试官劈成 S1/S2）。
5. **students 声道串音必须处理**：代码现有 `echoLeakRate()` 证明面试官声音会漏进系统音频，但**实际并无串音抑制算法**（仅 mic 浏览器 AEC）。需实现相关性串音抑制或预算"幻影说话人"并以 echoLeakRate 为门禁。
6. **DO 存活 + 静音保活**（你的"看题阶段"全员静音数分钟刚需）：持续静音帧/ping 防 Speechmatics 3 分钟断连；DO alarm(<15min) 兜底；每 PCM chunk 先落 R2 再发；冷启动 R2 重放重连做成一等路径并处理 Speechmatics 重连后 S 标签重新编号的拼接。
7. **inference 移植按真实规模**：~2,000–2,400 行跨 4 个 Python 服务（report_synthesizer 1170 + report_generator 781 + checkpoint_analyzer 495 + improvement_generator 204），牵动 9–14 端点、6 模块。Worker 现有 `OpenAILLMProvider.synthesizeReport` 是死代码且更差，**不可作基础**。须显式决定 regenerate-claim / Tier2 / checkpoint / incremental 的"移植 or 降级 or 丢弃"，并补 TS 回归测试对齐现有产出。
8. **背压**：Worker→Speechmatics relay 实现 seq_no/AudioAdded 信号量(~500)，重放 drain 时尊重 ~10s 音频缓冲上限。
9. **单供应商无 failover** 是新风险：迁移期保留旧 DashScope FunASR 云路径（无 GPU）作为 ASR 临时降级；LLM 可多供应商。

### 9.4 锁定补充决策
- **D7 迁移方式 = 渐进、纯云、零 GPU**（feature-flag 切换，验证后删旧码；绝不部署服务器）。
- **D8 群面命名 = 匿名 diarization(S1/S2) + 自我介绍自动抽名绑定 + 手动纠正兜底**（不做两段式重型 enrollment——候选人随机自我介绍，无法受控采样）。
- **D9 自建栈是未来选项、非永久排除**：MVP 绝不自建/绝不端侧；但**保留可插拔 provider 架构**（`providers/types.ts` 的 ASR/Diarization/SV/LLM 接口），以便未来规模化、对速度/精度/隐私/安全要求更高时，把 Speechmatics 换回自建 inference 而不重写主链路。删 inference 时按"退役/归档"处理而非彻底抹除接口契约。

### 9.5 你的真实群面工作流（设计需对齐）
开场中文（问候/等人/调试声画/流程说明）→ 切英文主体（面试官自报家门 + 题目）→ 候选人**随机抢答自我介绍**（自我介绍含姓名，作自动命名钩子）→ 看题（**全员静音数分钟**，触发保活刚需）→ 讨论（候选人互相**重叠交流**，diarization 最难）→ 第二题同流程 → 英文收尾 → **中文复盘（报告大概率出中文）**。面试官口令（"now discuss"/"time's up"）= 天然阶段分割点。

### 9.6 删 inference 前的硬性验证门（pilot，需 Speechmatics key）
- [ ] cmn_en + 实时 + diarization=speaker 三者同时可用，且返回每词 speaker（官方无矩阵，必须实测）。
- [ ] 真实 3–4 人群面重叠音频的 diarization 错误率（DER/误切换率）。
- [ ] 实时免费/付费并发额度与确切单价（portal 实测）。
- [ ] CF DO 持久双出站 WS + 保活 + 重连 实跑验证（dashscope-asr.ts 是短连，不能作证）。
- [ ] 16000Hz sample_rate 被 Speechmatics 接受。
