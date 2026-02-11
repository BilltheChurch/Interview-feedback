# Teams / Microsoft Graph 集成指南（v4.1）

**更新日期**：2026-02-11  
**目标**：在不引入 Teams Bot 的前提下，尽可能拿到“参会者姓名/邮箱列表”，用于 enrollment 与 speaker 绑定。

> 重要现实：Graph API 对“实时会议内参与者 roster”的能力有限，很多能力是**会后**（例如出席报告、通话记录）才可获取。  
> 因此本项目采用 **“会前名单 + 会中 enrollment（SV 模型：`iic/speech_campplus_sv_zh_en_16k-common_advanced`）”** 的闭环：即使名单不完美，也能靠 enrollment 的语音确认完成绑定。

---

## 1. 你需要的权限（Azure 应用）

### 1.1 推荐权限（最小可用）
- `User.Read`（委托）：读取当前登录老师的基本信息
- `OnlineMeetings.Read` 或 `OnlineMeetings.Read.All`（委托/应用）：读取会议对象（视你的业务是否需要跨用户）
- `Calendars.Read`（委托，可选）：从日历抓取会议邀请里的参会者（对“会前名单”最有用）
- `Directory.Read.All`（应用级，可选）：如果你要在租户内搜索用户（仅管理员同意）

> 你有全局管理员权限，建议走 **应用级 + admin consent**，避免老师每次授权失败。

---

## 2. 两种“拿参会者名单”的策略

### 策略 A：会前名单（推荐，MVP 主路径）
**来源**：会议邀请（Outlook/Teams 日历事件）  
**实现**：
1. 老师在 App 内用 Microsoft 登录（OAuth2）
2. 读取老师日历事件（按时间窗口或按 meeting url/subject 匹配）
3. 从 event 的 `attendees` 字段得到参会人 email/displayName
4. 让老师在 UI 里“确认/删减/补充”（因为学生可能用个人邮箱/来宾）

**优点**
- 会议开始前就能拿到名单，支持引导 enrollment 顺序
- 不依赖会议进行中 Graph 的限制

**缺点**
- 如果老师是转发会议链接、或学生临时加入，名单可能不完整

### 策略 B：会中/会后名单（增强）
你可以按能力逐步加：
- 会后“出席报告/通话记录”补全映射（用于复盘精修、统计）
- 如果组织策略允许，可用更高权限的 communications/Call Records API

> 但注意：你当前产品要求“面试结束立即反馈”，因此会后补全只能做“修正/归档”，不能作为核心链路。

---

## 3. 会前名单实现步骤（一步一步 + 验证）

### 3.1 Azure 端配置
1. Entra ID → **应用注册** → 新建应用
2. 添加平台：`Desktop + Mobile`（Electron 可以走 system browser）
3. 添加重定向 URI（示例）：`http://localhost:1717/callback`（开发期）
4. 添加权限：
   - Microsoft Graph → Delegated permissions：`User.Read`, `Calendars.Read`
   - （可选）`OnlineMeetings.Read`
5. 管理员点击 **Grant admin consent**

✅ **验证**：用 Graph Explorer 以老师身份运行
- `GET /me`
- `GET /me/events?$top=5`

### 3.2 Electron 端登录（推荐 MSAL）
- 使用 `@azure/msal-node`（配合 system browser）或 `@azure/msal-electron`
- 获得 access token 后调用 Graph API

✅ **验证**：能拿到 `access_token`，并且 `/me` 返回 200

### 3.3 从日历事件提取参会者
- 查询事件（时间窗口）
- 找到对应会议（匹配 `onlineMeeting.joinUrl` 或主题/时间）
- 读取 `attendees`：
  - email
  - displayName
  - type（required/optional）

✅ **验证**：
- 至少拿到老师 + 1 个学生
- UI 中显示参会者列表，可编辑

---

## 4. enrollment 与名单绑定（核心闭环）

### 4.1 enrollment 的产品规则
- 系统提示：请按列表顺序每人说 5–8 秒英文自我介绍
- 每个人说完立即显示：
  - 已捕获音频 ✅
  - 暂存 embedding ✅
  - 绑定结果（姓名 → speaker_id）✅/⚠️

### 4.2 名单不全时怎么办（必须有 UI）
- UI 提供：
  - “新增一个人”（手动输入 displayName）
  - “暂时跳过”（稍后再 enroll）
  - “unknown speaker” 的占位（后续修正）

---

## 5. 安全与合规（MVP 要求）
- Token 仅存本机 keychain（不要写入明文配置）
- Cloudflare 仅接收：
  - meeting_id
  - 语音 chunk（加密传输）
  - 最小化的参会者字段（displayName/email）

