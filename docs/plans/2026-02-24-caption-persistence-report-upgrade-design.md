# Caption 持久化 + Report 升级设计

**日期**: 2026-02-24
**状态**: 已批准

## 背景

ACS Teams caption-mode session 存在两个问题：
1. **captionBuffer 未持久化**：仅存于 DO 内存，Re-generate 时 buffer 为空，`useCaptions` 判断为 false，回退到 local ASR 导致卡死
2. **报告缺少完整 transcript**：`ResultV2.transcript` 已包含完整对话记录，但 FeedbackView 没有渲染，只展示碎片化的 evidence

此外，`runFinalizeV2Job` 是 ~500 行巨型函数，9 个 stage 混合在一起，不利于维护和 report-only 快速路径。

## 设计

### 1. Worker: captionBuffer 持久化

**存储方式：** DO storage `STORAGE_KEY_CAPTION_BUFFER = "caption_buffer"`

**写入策略：** 批量写入优化——攒 10 条或 5 秒（取先到的），一次性 `storage.put()`

**恢复逻辑：**
```
runFinalizeV2Job 开头:
  if captionSource === 'acs-teams' && captionBuffer.length === 0:
    captionBuffer = await storage.get(STORAGE_KEY_CAPTION_BUFFER) ?? []
```

**大小限制：** 最多 2000 条（60 分钟面试约 600-1200 条 Final caption），超出截断最旧的

### 2. Worker: Finalization Stage 拆分 + report-only 模式

**Stage 方法拆分**（保持在 Durable Object 类内，不拆文件）：

```typescript
private async stageFreeze(jobId, sessionId): Promise<StageResult>
private async stageDrain(jobId, sessionId): Promise<StageResult>
private async stageReplayGap(jobId, sessionId): Promise<StageResult>
private async stageLocalAsr(jobId, sessionId): Promise<StageResult>
private async stageCluster(jobId, sessionId): Promise<StageResult>
private async stageReconcile(jobId, sessionId, useCaptions): Promise<StageResult>
private async stageEvents(jobId, sessionId, transcript): Promise<StageResult>
private async stageReport(jobId, sessionId, ...): Promise<StageResult>
private async stagePersist(jobId, sessionId, result): Promise<StageResult>
```

**`/finalize?version=v2` 新增 `mode` 参数：**

| mode | 执行 stages | 用途 |
|------|------------|------|
| `full`（默认） | 全部 9 阶段 | 首次 finalization |
| `report-only` | reconcile → events → report → persist | Re-generate，复用已有 transcript |

**`report-only` 路径逻辑：**
1. 从 R2 加载现有 ResultV2
2. 提取 transcript + speaker_logs + stats
3. 跳到 stageEvents（重新分析交互事件）
4. stageReport（重新 LLM 合成）
5. stagePersist（保存新 ResultV2）

### 3. Desktop: FeedbackView Transcript Section

**位置：** 左侧 SECTIONS 导航新增 "Transcript" tab，位于 Session Notes 和 Evidence 之间

**布局：**
```
┌─ Filter Bar ────────────────────────┐
│ [All] [Ziyan Xu] [Interviewer]   🔍 │
└─────────────────────────────────────┘
┌─ Virtual Scroll List ───────────────┐
│ 00:02  ● Ziyan Xu                   │
│   你好，我叫许子言...               │
│                                      │
│ 00:15  ● Interviewer                 │
│   请介绍一下你对牛顿第二定律的...   │
│                                      │
│ 00:32  ● Ziyan Xu           [E12] ◆ │
│   好的，关于牛顿第二定律 F=ma...    │
│   ░░░░░░░░░░░░░░░░░░ (evidence bg)  │
└─────────────────────────────────────┘
```

**组件行为：**
- **虚拟化渲染**：`@tanstack/react-virtual` 处理 500+ utterances
- **说话人过滤**：顶部 filter chips，从 transcript 提取 unique speakers
- **说话人颜色**：复用 CaptionPanel 6 色循环方案
- **Evidence 高亮**：被引用的 utterance 带浅色背景 + evidence badge
- **Evidence 联动**：
  - Evidence section → 点击 → 跳转 Transcript 并滚动到对应 utterance
  - Transcript evidence badge → 点击 → 弹出 evidence detail modal
- **同说话人合并**：连续同说话人的 utterances 合并（只显示一次名字）
- **文本搜索**：搜索框过滤匹配的 utterance，高亮匹配文本
- **懒加载**：仅在用户点击 Transcript tab 时首次渲染

**数据流：**
```
ResultV2.transcript → normalizeApiReport → FeedbackReport.transcript
ResultV2.evidence   → normalizeApiReport → 构建 utteranceId → evidenceId 映射
                                                    ↓
                                           TranscriptSection 渲染
```

### 4. Desktop: Re-generate UI 增强

**SplitButton 设计：**
```
[Re-generate Report ▾]
  ├─ 🔄 Re-generate Report    (默认，report-only for caption-mode)
  └─ 🔬 Full Re-analysis      (完整 pipeline)
```

**行为矩阵：**

| Session 类型 | 默认点击 | 下拉「完整重新分析」 |
|-------------|---------|-------------------|
| caption-mode (`acs-teams`) | `mode=report-only`（~15s） | `mode=full`（需 inference） |
| audio-mode | `mode=full` | 同上 |

**错误处理：**
- `report-only` 失败 → 显示错误 + 保留旧报告
- `full` 模式 caption-mode → 从 DO storage 恢复 captionBuffer，走 caption pipeline
- inference 不可达 → 明确提示 "inference 服务未启动"

### 5. 修改文件清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `edge/worker/src/index.ts` | 修改 | captionBuffer 持久化、stage 方法拆分、`mode` 参数、report-only 路径 |
| `edge/worker/src/types_v2.ts` | 修改 | `FinalizeV2Request` 新增 `mode` 字段 |
| `desktop/src/views/FeedbackView.tsx` | 修改 | 新增 Transcript section、SplitButton、normalizeApiReport 扩展 |
| `desktop/src/components/TranscriptSection.tsx` | 新建 | 虚拟化 transcript 列表 + speaker filter + evidence 联动 |
| `desktop/src/components/ui/SplitButton.tsx` | 新建 | 通用 SplitButton 组件 |
| `desktop/src/types/desktop-api.d.ts` | 修改 | `finalizeV2` 参数新增 `mode` |
| `desktop/preload.js` | 修改 | `finalizeV2` IPC 传递 `mode` |
| `desktop/main.js` | 修改 | `finalizeV2` handler 传递 `mode` |
| `desktop/package.json` | 修改 | 新增 `@tanstack/react-virtual` |

### 6. 不做的事

- 不拆 stage 到独立文件（保持在 DO 类内作为 private 方法）
- 不做 transcript 语音回放（没有音频关联）
- 不做 transcript 编辑/标注（MVP 只读）
- 不做 transcript 导出（已有 Export Markdown 覆盖）
- 不改 caption-mode 首次 finalization 流程（只改 re-generate 路径）
- 不做 captionBuffer 版本控制（覆盖写入即可）
