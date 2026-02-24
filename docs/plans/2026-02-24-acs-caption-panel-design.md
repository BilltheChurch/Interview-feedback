# ACS 实时字幕面板设计

**日期**: 2026-02-24
**状态**: 已批准

## 背景

ACS Teams Caption 数据流已验证可用（`waitForConnected()` 修复后，`CaptionsReceived` 事件正常触发）。但当前 Desktop 端缺少两部分：
1. **数据存储**：caption 只转发给 Worker，不在本地保存，UI 无法显示
2. **显示组件**：SidecarView 中没有字幕面板

## 设计

### 1. 数据层：sessionStore 新增 caption 环形缓冲

```typescript
export type CaptionEntry = {
  id: string;           // `cap_${timestamp}_${index}`
  speaker: string;      // Teams 显示名
  text: string;         // 最终文本（仅 Final）
  timestamp: number;    // epoch ms
  language: string;     // e.g. 'zh-cn'
};

// Store 新增
captions: CaptionEntry[];           // 环形缓冲，最多 MAX_CAPTIONS 条
addCaption: (entry: Omit<CaptionEntry, 'id'>) => void;
```

- `MAX_CAPTIONS = 200`，超出时移除最旧条目
- 只存储 `resultType === 'Final'` 的 caption（Partial 频率太高）
- `reset()` 时清空

### 2. 编排层：双通道分发

`useSessionOrchestrator.ts` 的 caption callback 中：

```
ACSCaptionService.onCaption(caption)
  ├─ 通道1: wsService.send({ type: 'caption', ... })    // 现有，给 Worker
  └─ 通道2: if (resultType === 'Final') store.addCaption(...)  // 新增，给 UI
```

### 3. UI 层：CaptionPanel 组件

**位置**：SidecarView 笔记编辑器左侧，可折叠分栏

```
┌─ Header ─────────────────────────────────────────┐
│ [●] Session [Teams ●42]  04:53 Intro 1/5  [End] │
├──────────────────────────────────────────────────┤
│ CaptionPanel │ Notes Editor          │ Drawer    │
│ (240px,      │ (flex-1, hero)        │ (180px)   │
│  collapsible)│                       │           │
│              │                       │           │
│ Ziyan Xu:    │ Type notes here...    │ Audio     │
│  "你好..."   │                       │ Flow      │
│ Speaker B:   │                       │ Speakers  │
│  "请介绍..." │                       │ Activity  │
│              │                       │           │
├──────────────┴───────────────────────┤           │
│ [★] [⚠] [?] [🔗]  0 memos          │           │
└──────────────────────────────────────┴───────────┘
```

**组件行为**：
- `acsStatus === 'off'` → 完全隐藏，Notes 占满宽度
- `acsStatus !== 'off'` → 显示面板（默认展开 240px）
- 面板可折叠（按钮切换，折叠后变成 36px 图标栏）
- 自动滚动到最新 caption（有 sticky-to-bottom 逻辑）
- 用户手动上滚时暂停自动滚动，出现"跳到最新"按钮
- 相邻同一说话人的 caption 合并为一个气泡
- 不同说话人用颜色区分（最多 6 种颜色循环）

**新文件**：`desktop/src/components/CaptionPanel.tsx`

### 4. Header 布局修复

`SidecarView.tsx` SidecarHeader 组件：
- ACS 徽章加 `shrink-0` 防止被 flex 挤掉
- Session name `max-w-[140px]` 减小到 `max-w-[120px]`
- 左侧容器加 `overflow-hidden`

### 5. 修改文件清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `stores/sessionStore.ts` | 修改 | 新增 `CaptionEntry`, `captions[]`, `addCaption()` |
| `hooks/useSessionOrchestrator.ts` | 修改 | caption callback 新增 Final → store 写入 |
| `views/SidecarView.tsx` | 修改 | 集成 CaptionPanel，修复 header 布局 |
| `components/CaptionPanel.tsx` | 新建 | 字幕显示面板组件 |

### 6. 不做的事

- 不持久化 caption 到 localStorage（transient，随 session 结束清空）
- 不做 caption 搜索/过滤（MVP 不需要）
- 不显示 Partial caption（避免 UI 闪烁）
- 不修改 Worker 端逻辑（数据流不变）
