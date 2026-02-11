# 技术选型与 FAQ（v4.1）

**更新日期**：2026-02-11

---

## 1. 为什么选择 Fun-ASR Real-time？
- 你已确定模型端用 Fun-ASR realtime
- 实时能力强；支持标点、热词、VAD 等参数（按阿里云文档能力为准）

> 注意：Fun-ASR realtime 本身不提供说话人日志（diarization），因此需要外置 diarization + enrollment。

---

## 2. 开源模型选型（推荐组合）

### 2.1 Speaker Diarization（说话人日志）
优先级从高到低：

1. **pyannote.audio speaker diarization（pipeline）**  
   - 优点：社区成熟、效果常被作为强 baseline  
   - 缺点：部分模型许可证/权重使用需注意；推理相对重

2. **阿里系/ModelScope 生态的 diarization pipeline（若有）**  
   - 优点：国内网络更友好，集成更顺  
   - 缺点：具体效果需用你的群面数据实测

> MVP 建议：先用 pyannote 跑通链路，再用替代模型做 A/B。

### 2.2 Speaker Verification（声纹确认 / enrollment 核心）
**已定稿（MVP 默认）**：
- `iic/speech_campplus_sv_zh_en_16k-common_advanced` ✅（中英通用，16k，适配英文群面）

**备选（用于 A/B 或回退）**：
- `iic/speech_campplus_sv_zh-cn_16k-common`
- `iic/speech_campplus_sv_zh-cn_3dspeaker_16k`

**工程约束（必须遵守）**
- 输入音频统一：`16kHz / mono / PCM16`
- SV 阈值必须配置化：`SV_T_LOW / SV_T_HIGH`（不同麦克风/房间会漂移）
- 推荐链路：`enroll -> embedding_db -> identify(score)`（不要把“人名”写死在模型侧）

### 2.3 Speaker Identification（可选）
如果你想“无需 enrollment 自动识别人”，需要 speaker identification（SID）或 closed-set 识别。  
但在你的场景（4–6 人、可控流程）里，**enrollment 更稳**，SID 可以放到 Phase 2。

### 2.4 VAD（可选）
- 如果 diarization 在噪声/静音上表现差，加入 VAD 先裁剪有效语音会显著提升稳定性
- ModelScope 常见选择是 FSMN VAD（轻量）

---

## 3. 推理服务应该部署在哪里？

你提出“Docker 封装 + 算力平台”是正确方向。下面给一套**选择逻辑**：

### 3.1 如果你主要用户在中国大陆（推荐优先）
- 阿里云 PAI / EAS（推理服务托管）
- 国内 GPU 算力租赁平台（按量计费、可自动开关）

### 3.2 如果你可以用海外平台（更丰富）
- RunPod（GPU 按需）
- Modal（serverless GPU）
- 其它：Replicate、Banana 等（偏托管）

### 3.3 你该怎么选（MVP ）
- **先选一个“最容易开通、能跑 Docker、按需计费”的平台**跑通
- 成本控制策略：
  - 会议开始才启动容器（或唤醒）
  - 会后 5 分钟无请求自动关停
  - 并发不大（你的业务 1 老师同时 1 场为主），不用预留太多

---

## 4. 为什么 Cloudflare Workers 不能直接跑这些模型？
- Workers 适合做 **编排/路由/状态机/轻计算**
- diarization/SV 属于重推理（CPU/GPU），不适合在 Worker 内执行  
正确架构是：Worker 调用外部推理服务 HTTP API。

---

## 5. FAQ

### Q1：会议中不显示字幕，会不会“没东西可看”？
不会。你的主界面应该服务“老师在面试中做决策”：
- 计时 + 题目进度
- 参与度提醒（谁没说话）
- 笔记与一键标记（带时间戳）
字幕只是后台数据源，反馈才是用户价值。

### Q2：我必须强依赖 Teams 的录音/转写吗？
不需要。Granola 路线的关键是本地采集音频并实时上传分析。

### Q3：我如何保证“结束即反馈”？
核心策略：
- 会中实时做 diarization + ASR + 数据入库
- 反馈模式先渲染“已有数据的草稿”，再增量刷新
- 不要把“所有计算”堆到结束按钮那一刻

