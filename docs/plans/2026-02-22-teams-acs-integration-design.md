# Teams ACS 字幕集成设计

**日期：** 2026-02-22
**状态：** 已批准
**方案：** 方案 A — ACS Caption Provider（新增 Provider 接入现有架构）

---

## 1. 概述

### 1.1 目标

通过 Azure Communication Services (ACS) 的 TeamsCaptions 功能，在 Teams 会议中获取带说话人归属的实时字幕，作为新的 ASR + Diarization Provider 接入现有可插拔架构。

### 1.2 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 架构定位 | 新增 Provider | 复用现有 pipeline，非 Teams 场景不受影响 |
| ACS 连接端 | Desktop 应用直连 | 无需额外服务器，面试官可控 |
| 音频采集 | 保留双流 | ACS 字幕做 Tier 1，本地音频做 Tier 2 和 SV |
| 加入模式 | BYOI 匿名加入 | 无需管理员 PowerShell 配置，无需 token exchange |
| Azure 账户 | 个人账户 | 跨租户加入公司 Teams 会议，完全独立于公司 IT |

### 1.3 ACS 资源

- **资源名称：** `chorus-captions`
- **区域：** Asia Pacific
- **Endpoint：** `https://chorus-captions.asiapacific.communication.azure.com/`
- **订阅类型：** Pay-As-You-Go（个人租户）
- **成本估算：** ~$0.50/场面试（VoIP $0.004/分钟 + Captions 按分钟计费）

---

## 2. 架构

### 2.1 数据流

```
Desktop (Electron)
├─ AudioService (现有)
│   └─ 麦克风 + 系统音频 → WebSocket → Worker → R2 存储
│
├─ ACSCaptionService (新增)
│   ├─ CommunicationIdentityClient → 创建匿名用户 token
│   ├─ CallAgent.join(meetingLink) → 以"Chorus 助手"身份加入 Teams 会议
│   ├─ call.feature(Features.Captions) → 订阅 CaptionsReceived 事件
│   └─ 每条 Final 字幕 → WebSocket → Worker（type: 'caption'）
│
└─ useSessionOrchestrator (修改)
    └─ 检测 meetingLink 是否为 Teams → 决定是否启动 ACS

Worker (Durable Object)
├─ WebSocket 收到 type:'caption' → 存入 captionBuffer[]
├─ Finalization:
│   ├─ captionSource === 'acs-teams' → 跳过 drain/replay/local_asr
│   ├─ ACSCaptionASRProvider → captionBuffer → Utterance[]
│   ├─ ACSCaptionDiarizationProvider → displayName → speaker_id
│   └─ reconcile → stats → events → report → persist（与现有流程一致）
└─ Tier 2: 本地音频仍存入 R2，可用 Whisper+pyannote 重新处理
```

### 2.2 Provider 选择逻辑

```
Session 开始:
  if (meetingLink 包含 teams.microsoft.com && ACS_ENABLED) {
    → 启动 ACSCaptionService
    → Worker: captionSource = 'acs-teams'
    → ASR Provider = ACSCaptionASRProvider
    → Diarization Provider = ACSCaptionDiarizationProvider
  } else {
    → 现有管线（FunASR/Groq/LocalWhisper + CAM++ SV + 聚类）
  }
```

---

## 3. Desktop 端设计

### 3.1 新增：ACSCaptionService

**文件：** `desktop/src/services/ACSCaptionService.ts`

Service 单例，与 AudioService、WebSocketService 同级。

**生命周期：**

```
connect(meetingLink, wsService)
  1. CommunicationIdentityClient.createUserAndToken(["voip"])
  2. CallClient.createCallAgent(tokenCredential, { displayName: "Chorus 助手" })
  3. callAgent.join({ meetingLink })
  4. call.feature(Features.Captions).captions → 订阅 CaptionsReceived
  5. 每条 Final 字幕 → wsService.send({ type: 'caption', ... })

disconnect()
  1. call.hangUp()
  2. callAgent.dispose()
```

**WebSocket 消息格式：**

```typescript
interface CaptionMessage {
  type: 'caption';
  speaker: string;         // displayName（来自 Teams 会议 roster）
  text: string;            // spokenText（最终文本）
  language: string;        // spokenLanguage（如 'zh-cn', 'en-us'）
  timestamp: number;       // ms since epoch
  resultType: 'Partial' | 'Final';
  teamsUserId?: string;    // microsoftTeamsUserId（稳定标识，可选）
}
```

### 3.2 依赖项

```
@azure/communication-calling    // ACS Calling SDK
@azure/communication-common     // Token credentials
@azure/communication-identity   // 创建匿名用户 + token
```

### 3.3 安全要求

- **ACS Connection String** 包含 access key，必须通过 Electron main process IPC 传递
- **禁止**使用 `VITE_` 前缀（否则暴露在客户端 bundle 中）
- main.js 新增 IPC handler：`system:getAcsToken` → 在主进程中创建 token 并返回给 renderer

### 3.4 修改：useSessionOrchestrator

在 `startSession()` 中新增 Teams 检测逻辑：

```typescript
const isTeamsMeeting = meetingLink?.includes('teams.microsoft.com');
if (isTeamsMeeting && desktopAPI.getAcsEnabled()) {
  await ACSCaptionService.getInstance().connect(meetingLink, wsService);
  // 通知 Worker 切换到 caption 模式
  wsService.send({ type: 'session_config', captionSource: 'acs-teams' });
}
```

---

## 4. Worker 端设计

### 4.1 SessionState 扩展

```typescript
interface SessionState {
  // ... 现有字段 ...
  captionSource: 'none' | 'acs-teams';   // 字幕数据来源
  captionBuffer: CaptionEvent[];          // Final 字幕缓冲区
  captionSpeakerMap: Record<string, string>; // displayName → speaker_id
}

interface CaptionEvent {
  speaker: string;
  text: string;
  language: string;
  timestamp_ms: number;
  teamsUserId?: string;
}
```

### 4.2 WebSocket 消息处理

在 Durable Object 的 WebSocket message handler 中新增 `caption` 类型：

```typescript
case 'caption': {
  if (msg.resultType === 'Final') {
    this.state.captionBuffer.push({
      speaker: msg.speaker,
      text: msg.text,
      language: msg.language,
      timestamp_ms: msg.timestamp - this.state.sessionStartTime,
      teamsUserId: msg.teamsUserId,
    });
  }
  break;
}
```

### 4.3 新增：ACSCaptionASRProvider

**文件：** `edge/worker/src/providers/asr-acs-caption.ts`

```typescript
export class ACSCaptionASRProvider implements ASRProvider {
  readonly name = 'acs-caption';
  readonly mode = 'streaming';

  // 将 CaptionEvent[] 转换为标准 Utterance[]
  convertToUtterances(captions: CaptionEvent[]): Utterance[] {
    return captions.map((c, i) => ({
      id: `caption_${i}`,
      text: c.text,
      start_ms: c.timestamp_ms,
      end_ms: c.timestamp_ms + this.estimateDuration(c.text),
      speaker: c.speaker,
      language: c.language,
      confidence: 0.95,
      words: [],  // Teams 不提供逐词时间戳
    }));
  }

  private estimateDuration(text: string): number {
    // 中文约 4 字/秒，英文约 2.5 词/秒
    const charCount = text.length;
    return Math.max(1000, charCount * 250); // 至少 1 秒
  }
}
```

### 4.4 新增：ACSCaptionDiarizationProvider

**文件：** `edge/worker/src/providers/diarization-acs-caption.ts`

```typescript
export class ACSCaptionDiarizationProvider implements DiarizationProvider {
  readonly name = 'acs-caption';
  private speakerMap = new Map<string, string>();

  resolveSpeaker(displayName: string): string {
    if (!this.speakerMap.has(displayName)) {
      this.speakerMap.set(displayName, `spk_${this.speakerMap.size}`);
    }
    return this.speakerMap.get(displayName)!;
  }

  getSpeakerMap(): Record<string, string> {
    return Object.fromEntries(this.speakerMap);
  }
}
```

### 4.5 Finalization Pipeline 修改

当 `captionSource === 'acs-teams'` 时：

| 阶段 | 行为变化 |
|------|---------|
| 1. freeze | 不变 |
| 2. drain | **跳过** — 字幕已是最终文本 |
| 3. replay | **跳过** — 无音频回放需求 |
| 4. local_asr | **替换** — 用 ACSCaptionASRProvider 转换 captionBuffer |
| 5. reconcile | **简化** — displayName 直接映射为 speaker_id |
| 6. stats | 不变 |
| 7. events | 不变 |
| 8. report | 不变 |
| 9. persist | 不变（音频仍存储到 R2 用于 Tier 2） |

---

## 5. 配置

### 5.1 Desktop `.env`

```bash
# ACS 连接（个人 Azure 账户）
ACS_CONNECTION_STRING=endpoint=https://chorus-captions.asiapacific.communication.azure.com/;accesskey=xxxxx
ACS_ENABLED=true
```

### 5.2 Worker `wrangler.jsonc`

```jsonc
{
  "vars": {
    "CAPTION_PROVIDER": "acs-teams",
    "CAPTION_FALLBACK_TO_ASR": "true"
  }
}
```

### 5.3 Electron `main.js` 新增 IPC

```javascript
// 安全地在主进程中创建 ACS token
ipcMain.handle('system:getAcsToken', async () => {
  const connectionString = process.env.ACS_CONNECTION_STRING;
  if (!connectionString) return null;
  const client = new CommunicationIdentityClient(connectionString);
  const { token, expiresOn } = await client.createUserAndToken(["voip"]);
  return { token, expiresOn };
});

ipcMain.handle('system:getAcsEnabled', () => {
  return !!process.env.ACS_CONNECTION_STRING && process.env.ACS_ENABLED === 'true';
});
```

---

## 6. Unmixed Audio（4 Dominant Speakers）

### 6.1 场景适配

- 面试官音频：本地麦克风采集（现有 AudioService）
- 面试者音频：ACS Unmixed Audio（最多 4 个 dominant speakers）
- 小组面试通常 4 名面试者 → 4 dominant speakers 刚好覆盖

### 6.2 实现（Phase 2）

Unmixed audio 作为可选增强，在 ACS 字幕验证通过后再加入：

```typescript
// Phase 2: 获取 unmixed audio 用于 SV
const unmixedAudio = call.feature(Features.AudioStream);
unmixedAudio.on('AudioReceived', (stream) => {
  // stream.participant — 说话人
  // stream.data — PCM 音频
  // → 可用于 CAM++ SV 提取 embedding
});
```

---

## 7. 后备策略

### 7.1 ACS 字幕不可用时

```
if (CAPTION_FALLBACK_TO_ASR === 'true') {
  // 自动回退到现有管线
  captionSource = 'none';
  ASR Provider → FunASR / Groq / Local Whisper;
  Diarization → CAM++ SV + 全局聚类;
}
```

**触发回退的条件：**
- ACS 连接失败（网络、token 过期等）
- Teams 会议不允许匿名加入
- 非 Teams 会议（Zoom、线下等）

### 7.2 长期策略

如果本地 ASR/SV/Diarization 的 E2E 测试持续失败，可以将 ACS 字幕设为唯一 Tier 1 来源，但需要评估非 Teams 场景的覆盖方案。

---

## 8. 新增/修改文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `desktop/src/services/ACSCaptionService.ts` | ACS SDK 连接管理 + 字幕订阅 |
| `edge/worker/src/providers/asr-acs-caption.ts` | 字幕→Utterance 转换 |
| `edge/worker/src/providers/diarization-acs-caption.ts` | displayName→speaker_id 映射 |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `desktop/src/hooks/useSessionOrchestrator.ts` | 检测 Teams 链接 → 启动 ACS |
| `desktop/main.js` | IPC: `system:getAcsToken`, `system:getAcsEnabled` |
| `desktop/preload.js` | IPC bridge: 暴露 ACS 方法 |
| `desktop/package.json` | 新增 3 个 @azure 依赖 |
| `edge/worker/src/index.ts` | caption 消息处理 + sessionState 扩展 |
| `edge/worker/src/providers/types.ts` | CaptionEvent 类型定义 |
| `edge/worker/src/types_v2.ts` | captionSource 字段 |
| `edge/worker/wrangler.jsonc` | CAPTION_PROVIDER 变量 |

---

## 9. 测试计划

| 测试 | 验证内容 |
|------|---------|
| 单元测试：ACSCaptionASRProvider | captionBuffer → Utterance[] 转换正确性 |
| 单元测试：ACSCaptionDiarizationProvider | displayName → speaker_id 映射稳定性 |
| 单元测试：Pipeline 阶段跳过 | captionSource='acs-teams' 时正确跳过 drain/replay/local_asr |
| 集成测试：WebSocket caption 消息 | Worker 正确接收和存储 caption 消息 |
| E2E 测试：Teams 会议加入 | ACS 匿名用户成功加入 Teams 会议并收到字幕 |
| E2E 测试：完整 pipeline | 字幕数据 → finalization → report 生成 |
| 回退测试：ACS 不可用 | 自动回退到现有 ASR 管线 |

---

## 附录：参考文档

- [ACS Closed Captions Teams Interop](https://learn.microsoft.com/en-us/azure/communication-services/how-tos/calling-sdk/closed-captions-teams-interop-how-to)
- [ACS Teams Meeting Join](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting)
- [ACS Pricing](https://azure.microsoft.com/en-us/pricing/details/communication-services/)
- [Teams Interop Pricing](https://learn.microsoft.com/en-us/azure/communication-services/concepts/pricing)
- 内部文档：`docs/providers.md`, `docs/source/Teams_API集成指南.md`
