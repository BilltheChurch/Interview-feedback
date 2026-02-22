# Teams 会议创建 + DualSync 集成接口 设计文档

## 目标

在 Chorus Desktop 的 Session Setup 中实现一键创建 Teams 会议功能，并为未来与 DualSync 调度平台的集成预留标准化接口。

## 背景

- Chorus Desktop 已有 Microsoft Graph OAuth 登录（MSAL Node），权限包含 `OnlineMeetings.ReadWrite`
- `graphCalendar.js` 已实现 `createOnlineMeeting()` 方法，返回 `joinUrl`, `meetingCode`, `passcode`
- SetupView 的 `MeetingConnector` 组件已有 "Create Meeting via Graph" 按钮占位符但未接线
- DualSync (frontier_sync) 是独立的课程预约平台，已有 Teams 会议创建、用户管理、Pusher 通知
- DualSync 部署在 Vercel，受 serverless function 数量限制，短期内不做改动

## 架构决策

### 策略：接口优先，渐进集成

```
Phase 1 (现在)                          Phase 2 (以后)
─────────────                          ──────────────
Chorus Desktop:                        DualSync:
  ✅ 创建 Teams 会议                     - 群面可用时间投票
  ✅ 复制会议邀请到剪贴板                  - groupSessions schema
  ✅ 预留 SchedulingProvider 接口         - Cloudflare 迁移
  ✅ 预留 "Import from DualSync" UI      - Chorus webhook 回调
                                        - 对接预留接口
```

## Phase 1 详细设计

### 1. IPC: createTeamsMeeting

**主进程** (`main.js`):
- 新增 `graph:createMeeting` IPC handler
- 调用现有 `graphCalendar.createOnlineMeeting()`
- 返回结构化的会议信息

```typescript
// desktop-api.d.ts
createTeamsMeeting(options: {
  subject: string;
  startAt?: string;   // ISO, default: now + 5min
  endAt?: string;     // ISO, default: now + 65min
  participants?: { name: string; email?: string }[];
}): Promise<{
  ok: boolean;
  meetingId?: string;
  joinUrl?: string;
  meetingCode?: string;
  passcode?: string;
  error?: string;
}>
```

### 2. IPC: copyToClipboard

**主进程** (`main.js`):
- 新增 `clipboard:write` IPC handler
- 使用 Electron 的 `clipboard.writeText()`

```typescript
// desktop-api.d.ts
copyToClipboard(text: string): Promise<void>
```

### 3. SetupView MeetingConnector 增强

**激活"创建会议"按钮**:
- 点击触发 `window.desktopAPI.createTeamsMeeting()`
- 加载状态（spinner）
- 成功：自动填充 teamsUrl + 自动复制到剪贴板 + toast
- 失败：显示错误信息

**剪贴板格式**:
```
Mock Interview: [Session Name]
Time: [start] - [end]
Join: [joinUrl]
Meeting ID: [meetingCode]
Passcode: [passcode]
```

**Review 步骤增强**:
- Teams URL 旁新增"复制邀请"按钮

### 4. DualSync 集成接口（预留）

**类型定义** (`desktop-api.d.ts`):
```typescript
interface GroupSession {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  participants: { name: string; email?: string }[];
  teamsJoinUrl?: string;
  status: 'confirmed' | 'pending';
  source: 'dualsync' | 'manual';
}

interface SessionImport {
  sessionName: string;
  mode: '1v1' | 'group';
  participants: { name: string; email?: string }[];
  teamsJoinUrl: string;
  meetingCode?: string;
  passcode?: string;
}
```

**UI 占位**:
- SetupView Step 1: "Import from DualSync" 按钮 (disabled, "Coming soon" tooltip)

**Worker 占位**:
- `POST /api/scheduling/webhook` → 501 Not Implemented

### 5. DualSync 迁移/集成方案（仅文档）

单独的 `dualsync-integration-roadmap.md` 文档，包含：
- Vercel → Cloudflare 迁移路线图
- 群面 schema 扩展设计
- Chorus 对接 API 规范

## 文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `desktop/main.js` | 修改 | 新增 2 个 IPC handler |
| `desktop/preload.js` | 修改 | 桥接 2 个新方法 |
| `desktop/src/types/desktop-api.d.ts` | 修改 | 新增类型声明 |
| `desktop/src/views/SetupView.tsx` | 修改 | MeetingConnector + Review 增强 |
| `edge/worker/src/index.ts` | 修改 | 预留 webhook 端点 |
| `docs/plans/dualsync-integration-roadmap.md` | 新建 | DualSync 迁移/集成方案 |

## 非目标

- 不在 DualSync 侧做任何代码改动
- 不实现可用时间投票功能（Phase 2）
- 不实现日历同步功能（Phase 2）
- 不实现自动录制设置（Graph API `recordAutomatically` 参数已在 createOnlineMeeting 中，但需要 Teams 租户管理员权限，不在本次范围）
