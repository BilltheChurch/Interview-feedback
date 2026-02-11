# PRD｜基于本地音频采集 + 云端实时转写/说话人识别的群面智能记录系统（v4.1）

**版本**：v4.1  
**更新日期**：2026-02-11  
**目标用户**：老师（主持模拟群面/模拟面试）  
**核心约束**：
- **会议过程中必须实时处理音频**（可不显示字幕，但数据必须实时生成，保证“面试结束→立即进入反馈”无需等待）
- 生态优先：**Mac 桌面端（Electron）+ 云端（Cloudflare）**
- ASR 模型固定：**阿里云百炼 Fun-ASR Real-time**
- 说话人：采用**开源 Diarization + Enrollment 声纹/说话人确认**实现“speaker → 真实姓名”
  - SV 默认模型：`iic/speech_campplus_sv_zh_en_16k-common_advanced`（16k，中英通用）
- 不走 Teams Bot/Unmixed Audio（成本过高、部署复杂）

---

## 1. 背景与问题

### 1.1 为什么不走实时 Teams Bot（Unmixed Audio）
- Azure VM + 公网 IP + 媒体端口/网络要求带来固定成本与运维复杂度
- 对你的产品形态而言（老师 Mac 端使用），更像 Granola：**本地采集 + 云端分析**即可落地

### 1.2 关键难点
1. **音频来源**：在 Mac 上稳定采集 Teams 会议音频（含远端与本地）
2. **说话人识别**：Fun-ASR realtime **不提供说话人日志**（Diarization），需要自建
3. **反馈时效**：面试结束后必须立即进入反馈，不接受“会后再等几分钟”

---

## 2. 产品目标（What / Why）

### 2.1 目标
- 会议中实时生成结构化数据：
  - `Utterance`: {speaker_name, start_ms, end_ms, text, confidence}
  - `Participation`: 发言次数、时长、轮次、打断/被打断（可选）
  - `Key moments`: 老师一键标记（亮点/问题/追问/证据）
- 面试环节结束（两道题）→ **一键进入反馈模式**：
  - 个人表现（英语表达、逻辑、协作、影响力）
  - 团队表现（共识形成、分工、推进、冲突处理）
  - 证据引用（带时间戳/原话）

### 2.2 非目标（MVP 不做）
- 真正的实时字幕展示（可选隐藏，MVP 默认不展示）
- 完美的多方重叠分离（MVP 以 diarization 能稳定为主；必要时 UI 允许人工修正）
- Teams 原生转写依赖（不要求 Teams 开启转写/录音）

---

## 3. 用户流程（Teacher UX）

### 3.1 会前
1. 老师打开桌面端，创建“模拟群面任务”
2. （可选）粘贴 Teams 会议链接，用于自动拉取**参会人名单**（也可手动录入）
3. 选择题目/面试脚本

### 3.2 会中（面试环节）
- 主界面不展示字幕，展示：
  - 计时与题目进度（题 1 / 题 2）
  - 参与度仪表盘（谁讲话少、谁主导）
  - 老师“笔记区 + 一键标记”：👍亮点 / ⚠️问题 / ❓追问 / 🎯证据
- 后台持续进行：
  - 音频采集与上传（流式）
  - 云端实时 diarization + ASR + speaker mapping
  - 结构化数据不断更新（供反馈模式秒开）

### 3.3 会后立即（反馈环节，紧接面试）
- 老师点击【进入反馈】：
  - 立即生成（或刷新）“每人反馈卡 + 团队复盘卡”
  - 支持中文输出（可保留英文原话证据）

---

## 4. 系统架构（MVP）

```
Mac Electron App
  ├─ 音频采集（Teams 会话音频）
  ├─ 本地 UI：计时/笔记/标记
  └─ WebSocket 上传 PCM/Opus → Cloudflare Durable Object

Cloudflare
  ├─ Durable Object：会话状态机（meeting_id）
  ├─ R2：音频分片存储（1s chunks）
  ├─ D1/Postgres：转写/标记/反馈数据
  └─ Worker：编排（调用 ASR + 推理服务）

推理服务（Docker 部署在 GPU/推理托管平台）
  ├─ VAD（可选）
  ├─ Speaker Diarization（滑窗 10s/hop 2s）
  └─ Speaker Verification/Identification（Enrollment + 匹配）

ASR（阿里云百炼）
  └─ Fun-ASR Real-time WebSocket（可选 VAD、热词、时间戳）
```

> Durable Objects 单次事件默认 CPU 时间 30s，可在配置中提高上限（用于更重的编排/裁剪逻辑）。

---

## 5. 技术方案细化（面向实现）

### 5.1 音频采集（Mac）
MVP 推荐两条路径（按稳定性排序）：
1. **ScreenCaptureKit**（macOS 13+）：采集系统/应用音频（更接近 Granola）
2. **虚拟声卡（BlackHole/Loopback）**：将 Teams 输出路由到可采集输入

> 具体实现与校验写在《桌面客户端与说话人匹配实现》。

### 5.2 音频分片与时钟
- 采集帧：20–100ms
- 上传 chunk：建议 1s（16kHz mono PCM16：约 32KB/s）
- 云端 ring buffer：保留最近 15–20s（用于滑窗 diarization + segment 裁剪）
- 全链路时间戳：以客户端单调时钟为基准（meeting_start + offset_ms）

### 5.3 说话人日志（Diarization）
- 云端推理服务每 2s 调用一次 diarize：
  - 输入：最近 10s 音频（从 R2 拉 10 个 chunk）
  - 输出：本窗口的 speaker segments（含 overlap 标记可选）
- DO 做 **segment 去重/合并**（防止滑窗重复段反复进入 ASR）

### 5.4 ASR（Fun-ASR realtime）
- 每个 segment 音频裁剪后，送入 Fun-ASR realtime 识别
- 开启：
  - 标点
  - 时间戳输出
  - 热词（老师可配置“公司名/职位/专有名词”）
  - VAD（可选，依据效果决定）

### 5.5 Speaker → 真实姓名（Enrollment）
你提出的“自我介绍 enrollment”是最稳的做法：
1. 会中开始 1–2 分钟：按顺序让学生说 5–8 秒英文自我介绍
2. 推理服务提取每人声纹 embedding（SV model）
3. diarization 的 `speaker_k` 通过 embedding 聚合后与 enrolled embeddings 做匹配
4. 生成映射：`speaker_k → Zhang San`

MVP 策略：
- 允许老师在 UI 手动修正映射（极少数失败时兜底）
- 映射一旦确认，后续段落强制使用该映射（除非置信度持续异常）

---

## 6. MVP 范围与验收标准

### 6.1 MVP 功能清单
- Mac Electron：
  - 音频采集 + WebSocket 上传
  - 面试计时/题目进度
  - 笔记与一键标记（带时间戳）
  - Enrollment 引导与映射确认 UI
- Cloudflare：
  - Durable Object 会话编排
  - R2 存音频 chunk
  - 调用推理服务（diarization/SV）
  - 调用 Fun-ASR realtime（转写）
  - 数据落库（utterances/notes/tags）
- 推理服务（Docker）：
  - diarization API
  - enroll API
  - identify API（speaker 聚合 embedding → enrolled）
- 反馈模式：
  - 一键进入反馈（不等待）
  - 输出：个人 + 团队（中文为主，附英文证据）

### 6.2 量化验收（建议）
- **端到端延迟**（说话→对应 utterance 入库）：P95 < 5s
- **说话人正确率**（在 enrollment 成功前提下）：> 90%（MVP），目标逐步到 95%
- **转写可用性**：整场会议 ASR 成功率 > 99%
- **反馈秒开**：点击进入反馈→首屏 < 1s（可先渲染缓存草稿）

---

## 7. 风险与对策（MVP 必须写进开发任务）
1. **Mac 音频采集不稳定**  
   - 对策：两条采集路径并行实现；提供“自检页面”（录到自己的声音 + 远端声音）
2. **Diarization 质量不达标（重叠多/噪声大）**  
   - 对策：启用 VAD；窗口长度/阈值调参；必要时引入更强 diarization pipeline
3. **speaker 映射错误**  
   - 对策：enrollment 强制流程 + UI 手动修正 + 置信度报警
4. **成本不可控（GPU 常驻）**  
   - 对策：选择按需计费平台；服务自动缩容；会议空闲自动停实例

---

## 8. 开发阶段拆分（与《开发计划》对应）
- Phase 0：环境与账号（Cloudflare / Aliyun / GPU 平台）
- Phase 1（MVP-1）：音频采集 → 云端落盘（R2）→ 可回放校验
- Phase 2（MVP-2）：Fun-ASR realtime 转写全链路跑通（不含说话人）
- Phase 3（MVP-3）：推理服务 diarization + enrollment + 说话人映射
- Phase 4（MVP-4）：反馈模式 + 证据引用 + 导出
