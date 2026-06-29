# 全云端 Companion 下一阶段设计 — 链路鲁棒化路线图

> Status: Approved (brainstorm 2026-06-29)
> 基线: `docs/plans/2026-06-27-cloud-companion-speechmatics-architecture.md`
> 前置: 全云端架构已端到端真人验证通过(Speechmatics 实时 ASR+diarization、B3 自动绑名、qwen3.7-plus 报告、断句、finalize 103s);自建 `inference/` 已归档删除。

## 北极星

让全云端这条链路**没有任何问题**:再复杂的多人群面也能**一直 track**,生成对群面复盘有帮助的**高质量报告**,并在**规定期望时间内**交付报告与总结。UI 再漂亮,引擎不稳就是本末倒置——故鲁棒性排在最前。

## 锁定的架构决策

**A · 音频来源 = 本地优先 + 多路可插拔。** 桌面 App 用系统声音 loopback + 麦克风采集任意会议软件(腾讯/Teams/Zoom/Meet),上传云端由 Speechmatics 分离(pilot 已证可行,零平台集成、最快上线)。把 "diarization 来源" 抽象成可插拔接口,未来接 Teams ACS unmixed audio / 自建会议平台不返工。

**B · 面试官声音 = 双流(主力线上场景)。** 实测使用模型:Tim 本地跑软件 + 本地加入线上会议;会议回灌的系统声音**只含学生**(Tim 自己的声音经 mic 出去,不回灌)→ **天然无回声**。故 mic=面试官(teacher 流,关 diarization)、系统声音=学生(students 流,开 diarization)的双流设计本就正确。缺口仅是**双流 live 验证**(pilot 只测了学生单流)。线下同室 / 混合(部分线下部分线上)是未来场景,架构预留(届时单流 + 面试官也走 diarization 并识别排除出学生评分)。

**C · 报告时效 = 两段式,Tier1 即时且好用 + Tier2 深度 ≤5min。** 理想是"一份又快又深";若做不到,Tier1 现已"快且不错"(qwen3.7-plus,8min 音频 finalize 103s),Tier2 在其上加**复盘/培优深度**(每人深挖、对比、可执行建议),**硬约束 Tier2 ≤5min**。

## 阶段路线(已批准顺序)

### Phase R — 链路鲁棒性 + 真实会议验证(最高优先,先做)
目标:把引擎做到 bulletproof,并用真实 live 会议把没验过的场景补齐。
- **双流 live 验证**:mic(面试官)+ 系统声音(学生)同时跑;报告正确区分面试官问题(作上下文,不计入学生评分)与学生发言。
- **复杂多人**:Speechmatics `max_speakers` 配置;3–6 人群面 diarization/命名稳定。
- **长会议持续 track**:CF DO 持久双出站 WS 的**保活(静音帧)/ 重连(R2 replay)/ 背压**(§9.6 一直未真验);30–60min 不掉线、不丢段。
- **时效量化**:测真实 30–60min 会议的 finalize 时间;确认 Tier1 即时、为 Tier2 ≤5min 留预算。
- **验证手段**:部分单测 + 主要靠**用户跑真实 live 会议**(双流、长、多人)采证。

### Phase Q — 质量(紧接其后)
- **Tier2 云端化**:原走已删的 inference batch,现需云端实现。深度复盘/培优层——每人深挖、跨人对比、可执行培优建议;DO alarm 调度,≤5min。
- **B3 preferred-name**:学生说 preferred name("you can call me X" / "我喜欢叫 X")也能绑定到该 S 标签(当前绑自报全名/roster)。

### Phase X — 体验(最后,独立设计)
- GSAP 全面动效 + 整个面试流程 UX 重构(每部分怎么呈现,不止配色)。
- **独立 brainstorm**:用 design-taste-frontend / ui-ux-pro-max / gsap-* skills 专门设计,不与后端鲁棒性混在一起。

## 未决/需真实 live 会议采证的开放项
- 双流同跑时 mic 与系统声音的时间对齐 / 合并到统一报告。
- 长会议下 Speechmatics 实时并发额度与单价(每场 2 路流)。
- 面试官声音存在时 diarization 是否误把面试官切进学生(线上场景理论上无回声,需实证)。

## 不做(YAGNI)
- 现在不自建会议平台(巨大工程;本地采集已验证够用,留作未来战略选项)。
- 现在不深度集成 Teams ACS / Zoom SDK(多路音频是 Phase R 之后的增强,接口已预留)。
