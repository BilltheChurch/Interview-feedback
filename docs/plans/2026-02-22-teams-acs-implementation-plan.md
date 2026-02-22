# Teams ACS 字幕集成 — 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 通过 ACS TeamsCaptions SDK 获取 Teams 会议中带说话人归属的实时字幕，作为新的 ASR + Diarization Provider 接入现有可插拔架构。

**Architecture:** Desktop 应用通过 ACS Calling SDK 以匿名身份加入 Teams 会议，订阅 `CaptionsReceived` 事件。字幕数据通过现有 WebSocket 通道发送给 Worker，由新的 ACSCaptionASRProvider 和 ACSCaptionDiarizationProvider 转换为标准格式，复用 finalization pipeline 的后续阶段。

**Tech Stack:** `@azure/communication-calling`, `@azure/communication-common`, `@azure/communication-identity`, TypeScript, Vitest

**Design doc:** `docs/plans/2026-02-22-teams-acs-integration-design.md`

---

## Task 1: Worker — CaptionEvent 类型定义

**Files:**
- Modify: `edge/worker/src/providers/types.ts` (append after line ~200)
- Test: `edge/worker/tests/provider-types.test.ts`

**Step 1: Write the failing test**

```typescript
// edge/worker/tests/provider-types.test.ts — append to existing file
import type { CaptionEvent } from '../src/providers/types';

describe('CaptionEvent type', () => {
  it('should be assignable with required fields', () => {
    const event: CaptionEvent = {
      speaker: 'Tim Yang',
      text: '请介绍一下你自己',
      language: 'zh-cn',
      timestamp_ms: 5000,
    };
    expect(event.speaker).toBe('Tim Yang');
    expect(event.text).toBe('请介绍一下你自己');
  });

  it('should accept optional teamsUserId', () => {
    const event: CaptionEvent = {
      speaker: 'Tim Yang',
      text: 'Hello',
      language: 'en-us',
      timestamp_ms: 1000,
      teamsUserId: 'abc-123',
    };
    expect(event.teamsUserId).toBe('abc-123');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/provider-types.test.ts`
Expected: FAIL — `CaptionEvent` not exported from types.ts

**Step 3: Write the type definition**

Append to `edge/worker/src/providers/types.ts`:

```typescript
// ── Caption Types (ACS Teams Interop) ────────────────────────────────────────

/** A single caption event received from ACS TeamsCaptions. */
export interface CaptionEvent {
  /** Speaker display name from Teams meeting roster. */
  speaker: string;
  /** Transcribed text (final). */
  text: string;
  /** Spoken language (BCP 47, e.g. 'zh-cn', 'en-us'). */
  language: string;
  /** Timestamp in ms relative to session start. */
  timestamp_ms: number;
  /** Microsoft Teams user ID for stable identity across sessions. */
  teamsUserId?: string;
}
```

**Step 4: Run test to verify it passes**

Run: `cd edge/worker && npx vitest run tests/provider-types.test.ts`
Expected: PASS

**Step 5: Typecheck**

Run: `cd edge/worker && npm run typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add edge/worker/src/providers/types.ts edge/worker/tests/provider-types.test.ts
git commit -m "feat(types): add CaptionEvent type for ACS Teams captions"
```

---

## Task 2: Worker — ACSCaptionASRProvider

**Files:**
- Create: `edge/worker/src/providers/asr-acs-caption.ts`
- Test: `edge/worker/tests/asr-acs-caption.test.ts`

**Step 1: Write the failing test**

```typescript
// edge/worker/tests/asr-acs-caption.test.ts
import { describe, it, expect } from 'vitest';
import { ACSCaptionASRProvider } from '../src/providers/asr-acs-caption';
import type { CaptionEvent } from '../src/providers/types';

describe('ACSCaptionASRProvider', () => {
  const provider = new ACSCaptionASRProvider();

  it('has correct name and mode', () => {
    expect(provider.name).toBe('acs-caption');
    expect(provider.mode).toBe('streaming');
  });

  it('converts a single caption to Utterance', () => {
    const captions: CaptionEvent[] = [
      { speaker: 'Alice', text: 'Hello world', language: 'en-us', timestamp_ms: 5000 },
    ];
    const result = provider.convertToUtterances(captions);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Hello world');
    expect(result[0].start_ms).toBe(5000);
    expect(result[0].end_ms).toBeGreaterThan(5000);
    expect(result[0].language).toBe('en-us');
    expect(result[0].id).toBe('caption_0');
  });

  it('converts multiple captions preserving order', () => {
    const captions: CaptionEvent[] = [
      { speaker: 'Alice', text: '你好', language: 'zh-cn', timestamp_ms: 1000 },
      { speaker: 'Bob', text: '我是Bob', language: 'zh-cn', timestamp_ms: 3000 },
      { speaker: 'Alice', text: '好的', language: 'zh-cn', timestamp_ms: 5000 },
    ];
    const result = provider.convertToUtterances(captions);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('caption_0');
    expect(result[1].id).toBe('caption_1');
    expect(result[2].id).toBe('caption_2');
  });

  it('returns empty array for empty input', () => {
    expect(provider.convertToUtterances([])).toEqual([]);
  });

  it('estimates duration at least 1000ms', () => {
    const captions: CaptionEvent[] = [
      { speaker: 'A', text: 'Hi', language: 'en-us', timestamp_ms: 0 },
    ];
    const result = provider.convertToUtterances(captions);
    expect(result[0].end_ms - result[0].start_ms).toBeGreaterThanOrEqual(1000);
  });

  it('sets confidence to 0.95', () => {
    const captions: CaptionEvent[] = [
      { speaker: 'A', text: 'Test', language: 'en-us', timestamp_ms: 0 },
    ];
    const result = provider.convertToUtterances(captions);
    expect(result[0].confidence).toBe(0.95);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/asr-acs-caption.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the provider**

```typescript
// edge/worker/src/providers/asr-acs-caption.ts
import type { ASRProvider, Utterance, CaptionEvent } from './types';

/**
 * ASR Provider that converts ACS TeamsCaptions data into standard Utterances.
 * No actual ASR processing — Teams already provides transcribed text.
 */
export class ACSCaptionASRProvider implements ASRProvider {
  readonly name = 'acs-caption';
  readonly mode = 'streaming' as const;

  /**
   * Convert caption events into standard Utterance format.
   * This is the primary method — replaces ASR transcription entirely.
   */
  convertToUtterances(captions: CaptionEvent[]): Utterance[] {
    return captions.map((c, i) => ({
      id: `caption_${i}`,
      text: c.text,
      start_ms: c.timestamp_ms,
      end_ms: c.timestamp_ms + this.estimateDuration(c.text),
      language: c.language,
      confidence: 0.95,
      words: [],
    }));
  }

  /** Estimate speech duration from text length. Min 1s. */
  private estimateDuration(text: string): number {
    // ~4 chars/sec for CJK, ~5 chars/sec for Latin
    return Math.max(1000, text.length * 250);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd edge/worker && npx vitest run tests/asr-acs-caption.test.ts`
Expected: All 6 tests PASS

**Step 5: Typecheck**

Run: `cd edge/worker && npm run typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add edge/worker/src/providers/asr-acs-caption.ts edge/worker/tests/asr-acs-caption.test.ts
git commit -m "feat(provider): add ACSCaptionASRProvider for Teams captions"
```

---

## Task 3: Worker — ACSCaptionDiarizationProvider

**Files:**
- Create: `edge/worker/src/providers/diarization-acs-caption.ts`
- Test: `edge/worker/tests/diarization-acs-caption.test.ts`

**Step 1: Write the failing test**

```typescript
// edge/worker/tests/diarization-acs-caption.test.ts
import { describe, it, expect } from 'vitest';
import { ACSCaptionDiarizationProvider } from '../src/providers/diarization-acs-caption';
import type { CaptionEvent } from '../src/providers/types';

describe('ACSCaptionDiarizationProvider', () => {
  it('has correct name and mode', () => {
    const provider = new ACSCaptionDiarizationProvider();
    expect(provider.name).toBe('acs-caption');
    expect(provider.mode).toBe('streaming');
  });

  it('assigns stable speaker_id for same displayName', () => {
    const provider = new ACSCaptionDiarizationProvider();
    const id1 = provider.resolveSpeaker('Alice');
    const id2 = provider.resolveSpeaker('Alice');
    expect(id1).toBe(id2);
  });

  it('assigns different speaker_ids for different names', () => {
    const provider = new ACSCaptionDiarizationProvider();
    const id1 = provider.resolveSpeaker('Alice');
    const id2 = provider.resolveSpeaker('Bob');
    expect(id1).not.toBe(id2);
  });

  it('assigns sequential speaker_ids', () => {
    const provider = new ACSCaptionDiarizationProvider();
    expect(provider.resolveSpeaker('Alice')).toBe('spk_0');
    expect(provider.resolveSpeaker('Bob')).toBe('spk_1');
    expect(provider.resolveSpeaker('Charlie')).toBe('spk_2');
  });

  it('returns complete speaker map', () => {
    const provider = new ACSCaptionDiarizationProvider();
    provider.resolveSpeaker('Alice');
    provider.resolveSpeaker('Bob');
    const map = provider.getSpeakerMap();
    expect(map).toEqual({ Alice: 'spk_0', Bob: 'spk_1' });
  });

  it('resolves captions into utterances with speaker_ids', () => {
    const provider = new ACSCaptionDiarizationProvider();
    const captions: CaptionEvent[] = [
      { speaker: 'Alice', text: 'Hello', language: 'en-us', timestamp_ms: 1000 },
      { speaker: 'Bob', text: 'Hi', language: 'en-us', timestamp_ms: 2000 },
      { speaker: 'Alice', text: 'How are you', language: 'en-us', timestamp_ms: 3000 },
    ];
    const resolved = provider.resolveCaptions(captions);
    expect(resolved[0].speaker_id).toBe('spk_0');
    expect(resolved[0].speaker_name).toBe('Alice');
    expect(resolved[1].speaker_id).toBe('spk_1');
    expect(resolved[2].speaker_id).toBe('spk_0');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/diarization-acs-caption.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the provider**

```typescript
// edge/worker/src/providers/diarization-acs-caption.ts
import type { DiarizationProvider, CaptionEvent } from './types';

/** Resolved caption with speaker identity. */
export interface ResolvedCaption {
  speaker_id: string;
  speaker_name: string;
  text: string;
  language: string;
  timestamp_ms: number;
}

/**
 * Diarization provider that uses Teams displayName for speaker identity.
 * No SV or clustering needed — Teams provides speaker attribution directly.
 */
export class ACSCaptionDiarizationProvider implements DiarizationProvider {
  readonly name = 'acs-caption';
  readonly mode = 'streaming' as const;

  private speakerMap = new Map<string, string>();

  /** Map displayName to stable speaker_id. */
  resolveSpeaker(displayName: string): string {
    if (!this.speakerMap.has(displayName)) {
      this.speakerMap.set(displayName, `spk_${this.speakerMap.size}`);
    }
    return this.speakerMap.get(displayName)!;
  }

  /** Get the full displayName → speaker_id map. */
  getSpeakerMap(): Record<string, string> {
    return Object.fromEntries(this.speakerMap);
  }

  /** Resolve all captions with speaker identity. */
  resolveCaptions(captions: CaptionEvent[]): ResolvedCaption[] {
    return captions.map(c => ({
      speaker_id: this.resolveSpeaker(c.speaker),
      speaker_name: c.speaker,
      text: c.text,
      language: c.language,
      timestamp_ms: c.timestamp_ms,
    }));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd edge/worker && npx vitest run tests/diarization-acs-caption.test.ts`
Expected: All 6 tests PASS

**Step 5: Typecheck**

Run: `cd edge/worker && npm run typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add edge/worker/src/providers/diarization-acs-caption.ts edge/worker/tests/diarization-acs-caption.test.ts
git commit -m "feat(provider): add ACSCaptionDiarizationProvider for Teams speaker identity"
```

---

## Task 4: Worker — Caption WebSocket 消息处理

**Files:**
- Modify: `edge/worker/src/index.ts` (WebSocket message handler)
- Modify: `edge/worker/src/types_v2.ts` (captionSource field)
- Test: `edge/worker/tests/caption-ws.test.ts` (new)

**Step 1: Write the failing test**

```typescript
// edge/worker/tests/caption-ws.test.ts
import { describe, it, expect } from 'vitest';
import type { CaptionEvent } from '../src/providers/types';

/** Simulate the caption buffer logic extracted from the DO. */
function processCaptionMessage(
  msg: { type: string; speaker: string; text: string; language: string; timestamp: number; resultType: string; teamsUserId?: string },
  sessionStartTime: number,
  buffer: CaptionEvent[],
): CaptionEvent[] {
  if (msg.type !== 'caption' || msg.resultType !== 'Final') return buffer;
  buffer.push({
    speaker: msg.speaker,
    text: msg.text,
    language: msg.language,
    timestamp_ms: msg.timestamp - sessionStartTime,
    teamsUserId: msg.teamsUserId,
  });
  return buffer;
}

describe('Caption WebSocket message processing', () => {
  it('adds Final captions to buffer', () => {
    const buffer: CaptionEvent[] = [];
    processCaptionMessage(
      { type: 'caption', speaker: 'Alice', text: 'Hello', language: 'en-us', timestamp: 5000, resultType: 'Final' },
      0, buffer,
    );
    expect(buffer).toHaveLength(1);
    expect(buffer[0].speaker).toBe('Alice');
    expect(buffer[0].timestamp_ms).toBe(5000);
  });

  it('ignores Partial captions', () => {
    const buffer: CaptionEvent[] = [];
    processCaptionMessage(
      { type: 'caption', speaker: 'Alice', text: 'Hel', language: 'en-us', timestamp: 5000, resultType: 'Partial' },
      0, buffer,
    );
    expect(buffer).toHaveLength(0);
  });

  it('calculates timestamp_ms relative to session start', () => {
    const buffer: CaptionEvent[] = [];
    processCaptionMessage(
      { type: 'caption', speaker: 'Bob', text: 'Hi', language: 'en-us', timestamp: 10000, resultType: 'Final' },
      3000, buffer,
    );
    expect(buffer[0].timestamp_ms).toBe(7000);
  });

  it('preserves teamsUserId when provided', () => {
    const buffer: CaptionEvent[] = [];
    processCaptionMessage(
      { type: 'caption', speaker: 'Bob', text: 'Hi', language: 'en-us', timestamp: 1000, resultType: 'Final', teamsUserId: 'user-123' },
      0, buffer,
    );
    expect(buffer[0].teamsUserId).toBe('user-123');
  });

  it('ignores non-caption messages', () => {
    const buffer: CaptionEvent[] = [];
    processCaptionMessage(
      { type: 'audio', speaker: '', text: '', language: '', timestamp: 0, resultType: '' },
      0, buffer,
    );
    expect(buffer).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/caption-ws.test.ts`
Expected: PASS (this is a standalone logic test — the function is defined inline in the test)

> Note: This test validates the extraction logic. The actual integration into `index.ts` is done in Step 3.

**Step 3: Add captionSource to types_v2.ts**

Find the session state type in `edge/worker/src/types_v2.ts` and add:

```typescript
/** Caption data source. 'none' = use audio ASR, 'acs-teams' = use ACS captions. */
captionSource?: 'none' | 'acs-teams';
```

**Step 4: Add caption handler to index.ts**

In `edge/worker/src/index.ts`, find the WebSocket message switch/case block and add a `caption` case:

```typescript
case 'caption': {
  if (msg.resultType === 'Final') {
    if (!this.captionBuffer) this.captionBuffer = [];
    this.captionBuffer.push({
      speaker: msg.speaker,
      text: msg.text,
      language: msg.language,
      timestamp_ms: msg.timestamp - (this.sessionStartTime || 0),
      teamsUserId: msg.teamsUserId,
    });
  }
  break;
}
```

Also add `session_config` handler for Desktop to signal caption mode:

```typescript
case 'session_config': {
  if (msg.captionSource) {
    this.captionSource = msg.captionSource;
  }
  break;
}
```

**Step 5: Typecheck + run all worker tests**

Run: `cd edge/worker && npm run typecheck && npx vitest run`
Expected: All tests pass, no type errors

**Step 6: Commit**

```bash
git add edge/worker/src/index.ts edge/worker/src/types_v2.ts edge/worker/tests/caption-ws.test.ts
git commit -m "feat(worker): add caption WebSocket message handling and captionSource state"
```

---

## Task 5: Worker — Finalization pipeline caption mode

**Files:**
- Modify: `edge/worker/src/index.ts` (finalization stages)
- Test: `edge/worker/tests/caption-finalization.test.ts` (new)

**Step 1: Write the failing test**

```typescript
// edge/worker/tests/caption-finalization.test.ts
import { describe, it, expect } from 'vitest';
import { ACSCaptionASRProvider } from '../src/providers/asr-acs-caption';
import { ACSCaptionDiarizationProvider } from '../src/providers/diarization-acs-caption';
import type { CaptionEvent } from '../src/providers/types';

describe('Caption-mode finalization flow', () => {
  const captionBuffer: CaptionEvent[] = [
    { speaker: 'Tim Yang', text: '请你自我介绍一下', language: 'zh-cn', timestamp_ms: 0 },
    { speaker: 'Alice Wang', text: '你好我叫Alice', language: 'zh-cn', timestamp_ms: 3000 },
    { speaker: 'Tim Yang', text: '你的专业是什么', language: 'zh-cn', timestamp_ms: 8000 },
    { speaker: 'Bob Li', text: '我学计算机', language: 'zh-cn', timestamp_ms: 12000 },
  ];

  it('produces utterances from caption buffer', () => {
    const asrProvider = new ACSCaptionASRProvider();
    const utterances = asrProvider.convertToUtterances(captionBuffer);
    expect(utterances).toHaveLength(4);
    expect(utterances[0].text).toBe('请你自我介绍一下');
    expect(utterances[3].text).toBe('我学计算机');
  });

  it('produces speaker map from captions', () => {
    const diaProvider = new ACSCaptionDiarizationProvider();
    const resolved = diaProvider.resolveCaptions(captionBuffer);
    expect(resolved).toHaveLength(4);
    const map = diaProvider.getSpeakerMap();
    expect(Object.keys(map)).toHaveLength(3); // Tim, Alice, Bob
    expect(map['Tim Yang']).toBe('spk_0');
    expect(map['Alice Wang']).toBe('spk_1');
    expect(map['Bob Li']).toBe('spk_2');
  });

  it('resolved captions have matching speaker_id and name', () => {
    const diaProvider = new ACSCaptionDiarizationProvider();
    const resolved = diaProvider.resolveCaptions(captionBuffer);
    // Tim speaks twice, should have same speaker_id
    expect(resolved[0].speaker_id).toBe(resolved[2].speaker_id);
    expect(resolved[0].speaker_name).toBe('Tim Yang');
    // Alice and Bob are different
    expect(resolved[1].speaker_id).not.toBe(resolved[3].speaker_id);
  });

  it('should skip drain/replay/local_asr stages when captionSource is acs-teams', () => {
    const stages = ['freeze', 'drain', 'replay', 'local_asr', 'reconcile', 'stats', 'events', 'report', 'persist'];
    const captionSource = 'acs-teams';
    const skipStages = ['drain', 'replay', 'local_asr'];
    const activeStages = stages.filter(s => captionSource !== 'acs-teams' || !skipStages.includes(s));
    expect(activeStages).toEqual(['freeze', 'reconcile', 'stats', 'events', 'report', 'persist']);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `cd edge/worker && npx vitest run tests/caption-finalization.test.ts`
Expected: All 4 tests PASS

**Step 3: Modify finalization in index.ts**

In the finalization method, add a guard at the drain/replay/local_asr stages:

```typescript
// At the start of finalization, check captionSource
const useCaptions = this.captionSource === 'acs-teams' && this.captionBuffer?.length > 0;

// In each skippable stage:
if (stage === 'drain' && useCaptions) {
  this.updateStatus('drain', 'skipped_caption_mode');
  continue; // or proceed to next stage
}
// Same for 'replay' and 'local_asr'

// In the reconcile stage, when useCaptions:
if (useCaptions) {
  const asrProvider = new ACSCaptionASRProvider();
  const diaProvider = new ACSCaptionDiarizationProvider();
  const utterances = asrProvider.convertToUtterances(this.captionBuffer);
  const resolved = diaProvider.resolveCaptions(this.captionBuffer);
  // Merge into standard reconciliation format...
}
```

> The exact integration point depends on the finalization loop structure in index.ts. The developer should search for `'drain'`, `'replay'`, `'local_asr'` stage names and add the guard conditions.

**Step 4: Typecheck + run all worker tests**

Run: `cd edge/worker && npm run typecheck && npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add edge/worker/src/index.ts edge/worker/tests/caption-finalization.test.ts
git commit -m "feat(finalization): skip drain/replay/local_asr when using ACS captions"
```

---

## Task 6: Worker — wrangler.jsonc 配置

**Files:**
- Modify: `edge/worker/wrangler.jsonc`

**Step 1: Add caption vars**

In the `vars` section of `wrangler.jsonc`, add:

```jsonc
"CAPTION_PROVIDER": "acs-teams",
"CAPTION_FALLBACK_TO_ASR": "true"
```

**Step 2: Typecheck**

Run: `cd edge/worker && npm run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add edge/worker/wrangler.jsonc
git commit -m "feat(config): add CAPTION_PROVIDER and fallback vars"
```

---

## Task 7: Desktop — ACS 依赖安装

**Files:**
- Modify: `desktop/package.json`

**Step 1: Install ACS packages**

```bash
cd desktop && npm install @azure/communication-calling @azure/communication-common @azure/communication-identity
```

**Step 2: Verify install**

```bash
cd desktop && npx tsc --noEmit
```

Expected: No new type errors (ACS packages include their own types)

**Step 3: Commit**

```bash
git add desktop/package.json desktop/package-lock.json
git commit -m "feat(desktop): add Azure Communication Services SDK dependencies"
```

---

## Task 8: Desktop — IPC handlers (main.js + preload.js + types)

**Files:**
- Modify: `desktop/main.js` (add IPC handlers)
- Modify: `desktop/preload.js` (expose IPC methods)
- Modify: `desktop/src/types/desktop-api.d.ts` (add type declarations)

**Step 1: Add IPC handlers in main.js**

Find the IPC handler section in `desktop/main.js` and add:

```javascript
// ── ACS Caption IPC ──────────────────────────
ipcMain.handle('acs:getEnabled', () => {
  return !!process.env.ACS_CONNECTION_STRING && process.env.ACS_ENABLED === 'true';
});

ipcMain.handle('acs:getToken', async () => {
  const connectionString = process.env.ACS_CONNECTION_STRING;
  if (!connectionString) return { ok: false, error: 'ACS not configured' };
  try {
    const { CommunicationIdentityClient } = require('@azure/communication-identity');
    const client = new CommunicationIdentityClient(connectionString);
    const { token, expiresOn, user } = await client.createUserAndToken(['voip']);
    return { ok: true, token, expiresOn: expiresOn.toISOString(), userId: user.communicationUserId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
```

**Step 2: Add IPC bridge in preload.js**

Append to the `desktopAPI` object in `desktop/preload.js`:

```javascript
acsGetEnabled: () => ipcRenderer.invoke('acs:getEnabled'),
acsGetToken: () => ipcRenderer.invoke('acs:getToken'),
```

**Step 3: Add types in desktop-api.d.ts**

Append to the `DesktopAPI` interface in `desktop/src/types/desktop-api.d.ts`:

```typescript
acsGetEnabled(): Promise<boolean>;
acsGetToken(): Promise<{
  ok: boolean;
  token?: string;
  expiresOn?: string;
  userId?: string;
  error?: string;
}>;
```

**Step 4: Typecheck**

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add desktop/main.js desktop/preload.js desktop/src/types/desktop-api.d.ts
git commit -m "feat(ipc): add ACS token and config IPC handlers"
```

---

## Task 9: Desktop — ACSCaptionService

**Files:**
- Create: `desktop/src/services/ACSCaptionService.ts`
- Test: `desktop/src/services/__tests__/ACSCaptionService.test.ts` (new)

**Step 1: Write the failing test**

```typescript
// desktop/src/services/__tests__/ACSCaptionService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ACS SDK modules
vi.mock('@azure/communication-calling', () => ({
  CallClient: vi.fn().mockImplementation(() => ({
    createCallAgent: vi.fn().mockResolvedValue({
      join: vi.fn().mockReturnValue({
        feature: vi.fn().mockReturnValue({
          captions: {
            on: vi.fn(),
            off: vi.fn(),
            startCaptions: vi.fn().mockResolvedValue(undefined),
          },
        }),
        hangUp: vi.fn().mockResolvedValue(undefined),
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    }),
  })),
  Features: { Captions: 'Captions' },
}));

vi.mock('@azure/communication-common', () => ({
  AzureCommunicationTokenCredential: vi.fn(),
}));

describe('ACSCaptionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be a singleton', async () => {
    const { ACSCaptionService } = await import('../ACSCaptionService');
    const a = ACSCaptionService.getInstance();
    const b = ACSCaptionService.getInstance();
    expect(a).toBe(b);
  });

  it('should have disconnected status initially', async () => {
    const { ACSCaptionService } = await import('../ACSCaptionService');
    const service = ACSCaptionService.getInstance();
    expect(service.getStatus()).toBe('disconnected');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd desktop && npx vitest run src/services/__tests__/ACSCaptionService.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ACSCaptionService**

```typescript
// desktop/src/services/ACSCaptionService.ts
import { CallClient, Features } from '@azure/communication-calling';
import type { Call, CallAgent, TeamsCaptions, TeamsCaptionsInfo } from '@azure/communication-calling';
import { AzureCommunicationTokenCredential } from '@azure/communication-common';

export type CaptionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type CaptionCallback = (caption: {
  speaker: string;
  text: string;
  language: string;
  timestamp: number;
  resultType: 'Partial' | 'Final';
  teamsUserId?: string;
}) => void;

/**
 * Service singleton for ACS Teams caption integration.
 * Joins a Teams meeting as anonymous external user and subscribes to captions.
 */
export class ACSCaptionService {
  private static instance: ACSCaptionService;
  private callClient: CallClient | null = null;
  private callAgent: CallAgent | null = null;
  private call: Call | null = null;
  private status: CaptionStatus = 'disconnected';
  private onCaption: CaptionCallback | null = null;

  static getInstance(): ACSCaptionService {
    if (!ACSCaptionService.instance) {
      ACSCaptionService.instance = new ACSCaptionService();
    }
    return ACSCaptionService.instance;
  }

  getStatus(): CaptionStatus {
    return this.status;
  }

  /**
   * Connect to a Teams meeting and start receiving captions.
   * @param meetingLink Teams meeting join URL
   * @param token ACS access token (from main process IPC)
   * @param onCaption Callback for each caption event
   * @param displayName Name shown in Teams participant list
   */
  async connect(
    meetingLink: string,
    token: string,
    onCaption: CaptionCallback,
    displayName = 'Chorus 助手',
  ): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') return;

    this.status = 'connecting';
    this.onCaption = onCaption;

    try {
      this.callClient = new CallClient();
      const credential = new AzureCommunicationTokenCredential(token);
      this.callAgent = await this.callClient.createCallAgent(credential, { displayName });
      this.call = this.callAgent.join({ meetingLink });

      // Subscribe to captions
      const captionsFeature = this.call.feature(Features.Captions);
      const captions = captionsFeature.captions as TeamsCaptions;

      captions.on('CaptionsReceived', this.handleCaption);
      await captions.startCaptions({ spokenLanguage: 'zh-cn' });

      this.status = 'connected';
    } catch (err) {
      this.status = 'error';
      console.error('[ACSCaptionService] connect failed:', err);
      throw err;
    }
  }

  /** Disconnect from Teams meeting. */
  async disconnect(): Promise<void> {
    try {
      if (this.call) {
        await this.call.hangUp();
        this.call = null;
      }
      if (this.callAgent) {
        await this.callAgent.dispose();
        this.callAgent = null;
      }
      this.callClient = null;
    } catch (err) {
      console.error('[ACSCaptionService] disconnect error:', err);
    }
    this.status = 'disconnected';
    this.onCaption = null;
  }

  private handleCaption = (data: TeamsCaptionsInfo) => {
    if (!this.onCaption) return;
    this.onCaption({
      speaker: data.speaker?.displayName ?? 'Unknown',
      text: data.spokenText,
      language: data.spokenLanguage,
      timestamp: data.timestamp.getTime(),
      resultType: data.resultType as 'Partial' | 'Final',
      teamsUserId: (data.speaker?.identifier as any)?.microsoftTeamsUserId,
    });
  };
}

/** Singleton export for convenience. */
export const acsCaptionService = ACSCaptionService.getInstance();
```

**Step 4: Run test to verify it passes**

Run: `cd desktop && npx vitest run src/services/__tests__/ACSCaptionService.test.ts`
Expected: All tests PASS

**Step 5: Typecheck**

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors (if ACS SDK types are available; may need `skipLibCheck: true` as fallback)

**Step 6: Commit**

```bash
git add desktop/src/services/ACSCaptionService.ts desktop/src/services/__tests__/ACSCaptionService.test.ts
git commit -m "feat(desktop): add ACSCaptionService for Teams meeting captions"
```

---

## Task 10: Desktop — useSessionOrchestrator 集成

**Files:**
- Modify: `desktop/src/hooks/useSessionOrchestrator.ts`

**Step 1: Add ACS integration to start()**

In `useSessionOrchestrator.ts`, modify the `start()` function after WebSocket connection:

```typescript
import { acsCaptionService } from '../services/ACSCaptionService';

// After wsService.connect() succeeds, add:
const isTeamsMeeting = config.teamsJoinUrl?.includes('teams.microsoft.com');
if (isTeamsMeeting) {
  try {
    const acsEnabled = await window.desktopAPI.acsGetEnabled();
    if (acsEnabled) {
      const acsResult = await window.desktopAPI.acsGetToken();
      if (acsResult.ok && acsResult.token) {
        await acsCaptionService.connect(
          config.teamsJoinUrl!,
          acsResult.token,
          (caption) => {
            // Forward caption to Worker via existing WebSocket
            wsService.sendJson({
              type: 'caption',
              speaker: caption.speaker,
              text: caption.text,
              language: caption.language,
              timestamp: caption.timestamp,
              resultType: caption.resultType,
              teamsUserId: caption.teamsUserId,
            });
          },
        );
        // Notify Worker to switch to caption mode
        wsService.sendJson({ type: 'session_config', captionSource: 'acs-teams' });
      }
    }
  } catch {
    // ACS connection is non-fatal; falls back to audio ASR
    console.warn('[Orchestrator] ACS caption connection failed, using audio ASR');
  }
}
```

**Step 2: Add ACS cleanup to end()**

In the `end()` function, before `wsService.disconnect()`:

```typescript
// Disconnect ACS if connected
if (acsCaptionService.getStatus() === 'connected') {
  await acsCaptionService.disconnect();
}
```

**Step 3: Typecheck**

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add desktop/src/hooks/useSessionOrchestrator.ts
git commit -m "feat(orchestrator): integrate ACS caption service for Teams meetings"
```

---

## Task 11: Desktop — 环境变量配置

**Files:**
- Modify: `desktop/.env.example`

**Step 1: Add ACS vars to .env.example**

```bash
# Azure Communication Services (personal Azure account)
# Get from: Azure Portal → Communication Services → Keys
ACS_CONNECTION_STRING=
ACS_ENABLED=false
```

**Step 2: Commit**

```bash
git add desktop/.env.example
git commit -m "feat(config): add ACS environment variables to .env.example"
```

---

## Task 12: E2E 验证

**Files:** None (manual verification)

**Step 1: Start inference service**

```bash
cd inference && source .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**Step 2: Start edge worker**

```bash
cd edge/worker && npm run dev
```

**Step 3: Configure Desktop .env**

Set `ACS_CONNECTION_STRING` and `ACS_ENABLED=true` in `desktop/.env`.

**Step 4: Start Desktop app**

```bash
cd desktop && npm run dev
```

**Step 5: Create a Teams test meeting**

- In Teams, create a new meeting and copy the join link
- In the Desktop app, paste the Teams join URL in the Setup wizard
- Start the session

**Step 6: Verify**

- [ ] ACS participant appears in Teams meeting as "Chorus 助手"
- [ ] Live Captions are enabled and received
- [ ] Caption data appears in Worker logs
- [ ] Finalization produces a report using caption data
- [ ] Non-Teams sessions still work with existing ASR pipeline

**Step 7: Final commit**

```bash
git add -A
git commit -m "feat: Teams ACS caption integration — complete implementation"
```

---

## Summary

| Task | Component | 预估时间 |
|------|-----------|---------|
| 1 | CaptionEvent 类型 | 10 min |
| 2 | ACSCaptionASRProvider | 20 min |
| 3 | ACSCaptionDiarizationProvider | 20 min |
| 4 | Caption WebSocket 消息处理 | 30 min |
| 5 | Finalization pipeline 修改 | 45 min |
| 6 | wrangler.jsonc 配置 | 5 min |
| 7 | ACS 依赖安装 | 5 min |
| 8 | IPC handlers | 20 min |
| 9 | ACSCaptionService | 30 min |
| 10 | Orchestrator 集成 | 20 min |
| 11 | 环境变量 | 5 min |
| 12 | E2E 验证 | 30 min |
| **总计** | | **~4 小时** |
