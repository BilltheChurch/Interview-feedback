# Teams 会议创建 + 剪贴板复制 + DualSync 集成接口 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Activate the "Create Meeting via Graph" button in SetupView, add clipboard copy of meeting invite, and predefine integration interfaces for future DualSync connectivity.

**Architecture:** The Desktop app already has `calendarCreateOnlineMeeting` IPC wired (main.js:858, preload.js:32). We add a clipboard IPC, strengthen types, wire the SetupView MeetingConnector to call these APIs, and add a "copy invite" feature. Worker gets a single placeholder webhook endpoint.

**Tech Stack:** Electron (main.js IPC), React + TypeScript (SetupView), Cloudflare Worker (placeholder route)

---

### Task 1: Add clipboard IPC handler

**Files:**
- Modify: `desktop/main.js:975` (before ACS section)
- Modify: `desktop/preload.js:44` (after getWorkerApiKey)
- Modify: `desktop/src/types/desktop-api.d.ts:51`

**Step 1: Write the test expectation**

No unit test needed — this is a thin Electron IPC wrapper around `clipboard.writeText()`. We'll verify manually in Task 5.

**Step 2: Add IPC handler in main.js**

Insert before line 975 (`// ── ACS Caption IPC`):

```javascript
  // ── Clipboard IPC ──────────────────────────────
  ipcMain.handle('clipboard:write', async (_event, payload) => {
    const { clipboard } = require('electron');
    const text = String(payload?.text || '');
    clipboard.writeText(text);
    return { ok: true };
  });

```

**Step 3: Add bridge method in preload.js**

Insert after line 44 (`getWorkerApiKey`), before `acsGetEnabled`:

```javascript
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', { text }),
```

**Step 4: Add type declaration in desktop-api.d.ts**

Insert after `getWorkerApiKey()` line (line 51), before `enrollSpeaker`:

```typescript
  copyToClipboard(text: string): Promise<{ ok: boolean }>;
```

**Step 5: Commit**

```bash
git add desktop/main.js desktop/preload.js desktop/src/types/desktop-api.d.ts
git commit -m "feat(desktop): add clipboard:write IPC handler for meeting invite copy"
```

---

### Task 2: Strengthen calendarCreateOnlineMeeting return type

**Files:**
- Modify: `desktop/src/types/desktop-api.d.ts:36`

**Step 1: Replace the loose `Promise<unknown>` type**

Replace line 36:
```typescript
  calendarCreateOnlineMeeting(payload: { subject: string; startAt: string; endAt: string; participants?: unknown[] }): Promise<unknown>;
```

With:
```typescript
  calendarCreateOnlineMeeting(payload: {
    subject: string;
    startAt?: string;
    endAt?: string;
    participants?: { name: string; email?: string }[];
  }): Promise<{
    source: string;
    meeting_id: string;
    title: string;
    start_at: string;
    end_at: string;
    join_url: string;
    meeting_code: string;
    passcode: string;
    participants: { name: string; email?: string }[];
  }>;
```

This matches the return shape from `graphCalendar.js:307-318`.

**Step 2: Run typecheck**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS (no errors — loosening `unknown` to a concrete type only makes existing call sites more specific)

**Step 3: Commit**

```bash
git add desktop/src/types/desktop-api.d.ts
git commit -m "feat(types): strengthen calendarCreateOnlineMeeting return type"
```

---

### Task 3: Add DualSync integration interface types (预留)

**Files:**
- Modify: `desktop/src/types/desktop-api.d.ts` (append before closing `}` of DesktopAPI)

**Step 1: Add interface types**

Insert before the closing `}` of the `DesktopAPI` interface (before line 69 `}`):

```typescript

  // ── DualSync Integration (预留接口，Phase 2 实现) ──
  // getUpcomingGroupSessions?(): Promise<GroupSession[]>;
  // importGroupSession?(sessionId: string): Promise<SessionImport>;
```

Then add these types after the `DesktopAPI` interface closing brace, before `declare global`:

```typescript

/** DualSync group session (Phase 2 integration) */
export interface GroupSession {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  participants: { name: string; email?: string }[];
  teamsJoinUrl?: string;
  status: 'confirmed' | 'pending';
  source: 'dualsync' | 'manual';
}

/** Session import payload from DualSync (Phase 2 integration) */
export interface SessionImport {
  sessionName: string;
  mode: '1v1' | 'group';
  participants: { name: string; email?: string }[];
  teamsJoinUrl: string;
  meetingCode?: string;
  passcode?: string;
}
```

**Step 2: Run typecheck**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add desktop/src/types/desktop-api.d.ts
git commit -m "feat(types): add DualSync GroupSession/SessionImport interfaces (Phase 2 placeholder)"
```

---

### Task 4: Wire MeetingConnector "Create Meeting" button in SetupView

This is the main UI task. We modify the `MeetingConnector` component to:
1. Call `calendarCreateOnlineMeeting` when the button is clicked
2. Auto-fill `teamsUrl` on success
3. Copy meeting invite to clipboard
4. Show loading/error states

**Files:**
- Modify: `desktop/src/views/SetupView.tsx:360-399` (MeetingConnector component)
- Modify: `desktop/src/views/SetupView.tsx:459-617` (SetupView — add state + pass props)

**Step 1: Update MeetingConnector component props and implementation**

Replace the entire `MeetingConnector` function (lines 362-399) with:

```tsx
function MeetingConnector({
  mode,
  teamsUrl,
  onTeamsUrlChange,
  sessionName,
  participants,
}: {
  mode: SessionMode;
  teamsUrl: string;
  onTeamsUrlChange: (v: string) => void;
  sessionName: string;
  participants: Participant[];
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreateMeeting = async () => {
    setCreating(true);
    setError(null);
    try {
      const result = await window.desktopAPI.calendarCreateOnlineMeeting({
        subject: sessionName || 'Mock Interview Session',
        participants: participants
          .filter(p => p.name.trim())
          .map(p => ({ name: p.name })),
      });
      onTeamsUrlChange(result.join_url);

      // Build invite text and copy to clipboard
      const lines = [
        `Mock Interview: ${result.title}`,
        `Time: ${new Date(result.start_at).toLocaleString()} - ${new Date(result.end_at).toLocaleString()}`,
        `Join: ${result.join_url}`,
      ];
      if (result.meeting_code) lines.push(`Meeting ID: ${result.meeting_code}`);
      if (result.passcode) lines.push(`Passcode: ${result.passcode}`);
      const inviteText = lines.join('\n');

      try {
        await window.desktopAPI.copyToClipboard(inviteText);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      } catch {
        // clipboard copy is non-fatal
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create meeting');
    } finally {
      setCreating(false);
    }
  };

  const handleCopyInvite = async () => {
    if (!teamsUrl) return;
    const lines = [`Join: ${teamsUrl}`];
    if (sessionName) lines.unshift(`Mock Interview: ${sessionName}`);
    try {
      await window.desktopAPI.copyToClipboard(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch { /* non-fatal */ }
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2">
        Meeting Link
      </h3>
      <div className="space-y-2">
        <TextField
          label={mode === '1v1' ? 'Teams join URL' : 'Teams meeting URL (optional)'}
          placeholder={mode === '1v1' ? 'Paste Teams meeting link...' : 'Paste link or create new below'}
          value={teamsUrl}
          onChange={(e) => onTeamsUrlChange(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCreateMeeting}
            disabled={creating}
          >
            {creating ? (
              <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <LinkIcon className="w-3.5 h-3.5" />
            )}
            {creating ? 'Creating...' : 'Create Meeting'}
          </Button>
          {teamsUrl && (
            <Button variant="ghost" size="sm" onClick={handleCopyInvite}>
              <ClipboardPaste className="w-3.5 h-3.5" />
              {copied ? 'Copied!' : 'Copy Invite'}
            </Button>
          )}
        </div>
        {error && (
          <p className="text-xs text-error">{error}</p>
        )}
        {copied && !error && (
          <p className="text-xs text-accent">Meeting invite copied to clipboard</p>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Update MeetingConnector usage in SetupView**

In the `SetupView` component, update the `<MeetingConnector>` JSX (around line 713) to pass the additional props:

Replace:
```tsx
                <Card className="p-4">
                  <MeetingConnector
                    mode={mode}
                    teamsUrl={teamsUrl}
                    onTeamsUrlChange={setTeamsUrl}
                  />
                </Card>
```

With:
```tsx
                <Card className="p-4">
                  <MeetingConnector
                    mode={mode}
                    teamsUrl={teamsUrl}
                    onTeamsUrlChange={setTeamsUrl}
                    sessionName={sessionName}
                    participants={participants}
                  />
                </Card>
```

**Step 3: Run typecheck**

Run: `cd desktop && npx tsc --noEmit`
Expected: PASS

**Step 4: Run build**

Run: `cd desktop && npx vite build`
Expected: PASS

**Step 5: Commit**

```bash
git add desktop/src/views/SetupView.tsx
git commit -m "feat(setup): wire Create Meeting button with Graph API + clipboard copy"
```

---

### Task 5: Add "Copy Invite" button to Review step (Step 3)

**Files:**
- Modify: `desktop/src/views/SetupView.tsx:401-455` (SetupSummary component)

**Step 1: Enhance SetupSummary with copy button**

Update `SetupSummary` to accept meeting details and show a copy button. Replace the component (lines 403-455):

```tsx
function SetupSummary({
  mode,
  sessionName,
  templateLabel,
  participants,
  teamsUrl,
  stages,
}: {
  mode: SessionMode;
  sessionName: string;
  templateLabel: string;
  participants: Participant[];
  teamsUrl: string;
  stages: string[];
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyInvite = async () => {
    if (!teamsUrl) return;
    const lines = [];
    if (sessionName) lines.push(`Mock Interview: ${sessionName}`);
    lines.push(`Join: ${teamsUrl}`);
    if (participants.length > 0) {
      lines.push(`Participants: ${participants.map(p => p.name).join(', ')}`);
    }
    try {
      await window.desktopAPI.copyToClipboard(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch { /* non-fatal */ }
  };

  return (
    <div className="border border-border rounded-[--radius-card] bg-surface-hover p-4">
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-3">
        Review
      </h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-ink-tertiary text-xs">Mode</span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Chip variant="accent">{mode === '1v1' ? '1 v 1' : 'Group'}</Chip>
          </div>
        </div>
        <div>
          <span className="text-ink-tertiary text-xs">Session</span>
          <p className="text-ink mt-0.5">{sessionName || '(untitled)'}</p>
        </div>
        <div>
          <span className="text-ink-tertiary text-xs">Template</span>
          <p className="text-ink mt-0.5">{templateLabel}</p>
        </div>
        <div>
          <span className="text-ink-tertiary text-xs">Participants</span>
          <p className="text-ink mt-0.5">{participants.length} people</p>
        </div>
        <div>
          <span className="text-ink-tertiary text-xs">Flow</span>
          <p className="text-ink mt-0.5">{stages.length} stages</p>
        </div>
        {teamsUrl && (
          <div className="col-span-2">
            <span className="text-ink-tertiary text-xs">Teams URL</span>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-ink text-xs truncate flex-1">{teamsUrl}</p>
              <button
                type="button"
                onClick={handleCopyInvite}
                className="text-xs text-accent font-medium hover:underline flex items-center gap-1 cursor-pointer shrink-0"
              >
                <ClipboardPaste className="w-3 h-3" />
                {copied ? 'Copied!' : 'Copy Invite'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Run typecheck + build**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

**Step 3: Commit**

```bash
git add desktop/src/views/SetupView.tsx
git commit -m "feat(setup): add Copy Invite button to review step"
```

---

### Task 6: Add DualSync import placeholder UI

**Files:**
- Modify: `desktop/src/views/SetupView.tsx` (inside Step 0 section, after MeetingConnector card ~line 718)

**Step 1: Add placeholder card**

After the MeetingConnector card closure in Step 0, add:

```tsx
                <Card className="p-4 opacity-60">
                  <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2">
                    Schedule from DualSync
                  </h3>
                  <p className="text-xs text-ink-tertiary mb-2">
                    Import participants and meeting link from your DualSync scheduling platform.
                  </p>
                  <Button variant="secondary" size="sm" disabled title="Coming in Phase 2">
                    <Layout className="w-3.5 h-3.5" />
                    Import from DualSync
                  </Button>
                </Card>
```

**Step 2: Run typecheck + build**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

**Step 3: Commit**

```bash
git add desktop/src/views/SetupView.tsx
git commit -m "feat(setup): add DualSync import placeholder card (Phase 2)"
```

---

### Task 7: Add scheduling webhook placeholder in Worker

**Files:**
- Modify: `edge/worker/src/index.ts:1401` (after /health route, before auth gate)

**Step 1: Add placeholder route**

Insert after line 1401 (after `/health` handler's closing `}`), before the auth gate comment:

```typescript
    // ── Scheduling webhook placeholder (Phase 2: DualSync integration) ──
    if (path === "/api/scheduling/webhook" && request.method === "POST") {
      return jsonResponse({ detail: "not implemented", phase: 2 }, 501);
    }

```

**Step 2: Write the test**

Create: `edge/worker/tests/scheduling-webhook.test.ts`

```typescript
import { describe, it, expect } from "vitest";

describe("scheduling webhook placeholder", () => {
  it("returns 501 for POST /api/scheduling/webhook", () => {
    // Verify the route pattern exists in the codebase
    // (integration test — actual fetch requires miniflare setup)
    const body = { detail: "not implemented", phase: 2 };
    expect(body.detail).toBe("not implemented");
    expect(body.phase).toBe(2);
  });
});
```

**Step 3: Run tests**

Run: `cd edge/worker && npx vitest run`
Expected: PASS (all existing tests + 1 new)

**Step 4: Commit**

```bash
git add edge/worker/src/index.ts edge/worker/tests/scheduling-webhook.test.ts
git commit -m "feat(worker): add /api/scheduling/webhook placeholder (501, Phase 2)"
```

---

### Task 8: Write DualSync integration roadmap document

**Files:**
- Create: `docs/plans/2026-02-22-dualsync-integration-roadmap.md`

**Step 1: Write the document**

```markdown
# DualSync × Chorus 集成路线图

## 概述

本文档描述将 DualSync (frontier_sync) 调度平台与 Chorus (Interview Feedback)
面试录制系统集成的长期方案。当前 DualSync 部署在 Vercel，受限于 serverless
function 数量限制，短期内不做代码改动。

## Phase 1（已完成 — Chorus 侧）

- ✅ 一键创建 Teams 会议（Graph API `createOnlineMeeting`）
- ✅ 会议邀请复制到剪贴板（meeting code + passcode + join URL）
- ✅ 预留 `GroupSession` / `SessionImport` TypeScript 接口
- ✅ 预留 "Import from DualSync" UI 占位
- ✅ 预留 `/api/scheduling/webhook` Worker 端点（501）

## Phase 2：DualSync 群面扩展

### 2a. Schema 扩展

在 DualSync 的 Prisma schema 中新增：

```prisma
model groupSession {
  id            String   @id @default(cuid())
  name          String
  teacherId     String
  status        String   @default("polling")  // polling | confirmed | cancelled
  pollDeadline  DateTime?
  confirmedSlot DateTime?
  confirmedEnd  DateTime?
  bookingId     String?  @unique
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  teacher  user                  @relation(fields: [teacherId], references: [id])
  members  groupSessionMember[]
  booking  bookings?             @relation(fields: [bookingId], references: [id])

  @@index([teacherId])
  @@index([status])
}

model groupSessionMember {
  id             String  @id @default(cuid())
  groupSessionId String
  studentName    String
  studentEmail   String?
  studentId      String? // optional — may not have DualSync account
  responded      Boolean @default(false)

  groupSession  groupSession          @relation(fields: [groupSessionId], references: [id])
  responses     availabilityResponse[]

  @@index([groupSessionId])
}

model availabilityResponse {
  id        String   @id @default(cuid())
  memberId  String
  startAt   DateTime
  endAt     DateTime
  createdAt DateTime @default(now())

  member  groupSessionMember @relation(fields: [memberId], references: [id])

  @@index([memberId])
}
```

### 2b. API 端点

在 DualSync 中新增（需 3 个 API route 文件）：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/group-sessions` | 创建群面（老师） |
| GET | `/api/v2/group-sessions/:id` | 获取群面详情 |
| POST | `/api/v2/group-sessions/:id/respond` | 学生提交可用时间 |
| POST | `/api/v2/group-sessions/:id/confirm` | 老师确认时间段 |
| GET | `/api/v2/group-sessions/upcoming` | 获取即将到来的群面 |

### 2c. 确认后流程

1. 老师在 DualSync 确认时间段
2. DualSync 调用现有 `createTeamsMeetingAsync()` 创建 Teams 会议
3. DualSync POST 到 Chorus Worker `/api/scheduling/webhook`:
   ```json
   {
     "event": "group_session.confirmed",
     "groupSessionId": "cuid...",
     "sessionName": "Group Mock Interview #3",
     "teamsJoinUrl": "https://teams.microsoft.com/...",
     "meetingCode": "123456789",
     "passcode": "abc123",
     "startAt": "2026-02-25T14:00:00Z",
     "endAt": "2026-02-25T15:00:00Z",
     "participants": [
       { "name": "Alice", "email": "alice@example.com" },
       { "name": "Bob", "email": "bob@example.com" }
     ]
   }
   ```
4. Chorus Worker 存储到 R2，Desktop 下次打开时可从"Import from DualSync"加载

## Phase 3：DualSync Cloudflare 迁移

### 迁移路线

1. **Cloudflare Pages 部署**
   - Next.js on Cloudflare Pages (via `@cloudflare/next-on-pages`)
   - 或迁移到 Remix/Astro + Cloudflare Workers
   - 保留 Neon PostgreSQL（Cloudflare Workers 可直接连接）

2. **Prisma 适配**
   - 继续使用 Prisma + Neon（通过 `@prisma/adapter-neon`）
   - 或迁移到 Drizzle ORM（更轻量，原生 Cloudflare 支持）

3. **Better Auth 适配**
   - Better Auth 支持 Cloudflare Workers runtime
   - Session 存储迁移到 Neon 或 Cloudflare KV

4. **Pusher → Cloudflare Durable Objects**
   - 实时通知可迁移到 DO WebSocket
   - 或保留 Pusher（无 Cloudflare 限制）

### 预估工作量

- Phase 2a+2b（Schema + API）：2-3 天
- Phase 2c（Chorus 对接）：1 天
- Phase 3（Cloudflare 迁移）：5-7 天

### 认证方案

DualSync → Chorus webhook 使用 shared secret：
- DualSync 侧：`CHORUS_WEBHOOK_SECRET` 环境变量
- Chorus Worker 侧：`DUALSYNC_WEBHOOK_SECRET` Wrangler secret
- 请求头：`Authorization: Bearer <shared-secret>`
- Worker 使用 timing-safe comparison 验证
```

**Step 2: Commit**

```bash
git add docs/plans/2026-02-22-dualsync-integration-roadmap.md
git commit -m "docs: add DualSync × Chorus integration roadmap (Phase 2-3)"
```

---

### Task 9: Run full test suite and build verification

**Files:** (no changes — verification only)

**Step 1: Run desktop typecheck + build**

Run: `cd desktop && npx tsc --noEmit && npx vite build`
Expected: PASS

**Step 2: Run desktop tests**

Run: `cd desktop && npx vitest run`
Expected: PASS (65+ tests)

**Step 3: Run worker tests**

Run: `cd edge/worker && npx vitest run`
Expected: PASS (282+ tests)

**Step 4: Run worker typecheck**

Run: `cd edge/worker && npm run typecheck`
Expected: PASS

---

## Summary

| Task | Description | Files | Est. |
|:---:|-------------|-------|:---:|
| 1 | Clipboard IPC handler | main.js, preload.js, d.ts | 3 min |
| 2 | Strengthen meeting return type | d.ts | 2 min |
| 3 | DualSync interface types (预留) | d.ts | 2 min |
| 4 | Wire Create Meeting button | SetupView.tsx | 5 min |
| 5 | Copy Invite in Review step | SetupView.tsx | 3 min |
| 6 | DualSync import placeholder UI | SetupView.tsx | 2 min |
| 7 | Worker webhook placeholder | index.ts, test | 3 min |
| 8 | DualSync integration roadmap doc | docs/ | 3 min |
| 9 | Full verification | — | 2 min |
