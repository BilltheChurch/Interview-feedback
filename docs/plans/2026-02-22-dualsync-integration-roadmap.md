# DualSync × Chorus 集成路线图

## 概述

本文档描述将 DualSync (frontier_sync) 调度平台与 Chorus (Interview Feedback)
面试录制系统集成的长期方案。当前 DualSync 部署在 Vercel，受限于 serverless
function 数量限制，短期内不做代码改动。

## Phase 1（已完成 — Chorus 侧）

- 一键创建 Teams 会议（Graph API `createOnlineMeeting`）
- 会议邀请复制到剪贴板（meeting code + passcode + join URL）
- 预留 `GroupSession` / `SessionImport` TypeScript 接口
- 预留 "Import from DualSync" UI 占位
- 预留 `/api/scheduling/webhook` Worker 端点（501）

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
  studentId      String?
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
3. DualSync POST 到 Chorus Worker `/api/scheduling/webhook`：
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
4. Chorus Worker 存储到 R2，Desktop 下次打开时可从 "Import from DualSync" 加载

## Phase 3：DualSync Cloudflare 迁移

### 迁移路线

1. **Cloudflare Pages 部署**
   - Next.js on Cloudflare Pages（via `@cloudflare/next-on-pages`）
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
