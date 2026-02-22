# Chorus Comprehensive Analysis Report

**Date:** 2026-02-22
**Status:** Complete
**Scope:** Code review, feature inventory, competitive analysis, Teams API research

---

## 1. Feature Inventory

### 1.1 Inference Service (FastAPI) — 13 Endpoints, 95 Tests

| Category | Endpoints | Description |
|----------|-----------|-------------|
| Health | `GET /health` | Service health with model info |
| Speaker Verification | `POST /sv/extract_embedding`, `/sv/score` | CAM++ 512-dim embeddings, cosine similarity |
| Speaker Resolution | `POST /speaker/resolve`, `/speaker/enroll` | Online clustering + enrollment matching |
| Analysis | `POST /analysis/events`, `/analysis/report`, `/analysis/synthesize`, `/analysis/regenerate-claim` | Event detection, memo-first reports, LLM synthesis |
| Batch (Tier 2) | `POST /batch/transcribe`, `/batch/diarize`, `/batch/process` | Whisper large-v3 + pyannote full pipeline |
| ASR Routes | `POST /asr/transcribe` | Local Whisper transcription endpoint |

**Key Capabilities:**
- Audio normalization: 16kHz/mono/PCM16 with 30s ffmpeg timeout
- VAD segmentation via Silero VAD
- Speaker verification via ModelScope CAM++ (512-dim embeddings)
- Online agglomerative clustering for speaker identification
- Name extraction from transcripts (EN + ZH regex patterns)
- LLM synthesis via DashScope qwen-flash (memo-first approach with deep citations)
- Tier 2 batch processing: faster-whisper + pyannote.audio full diarization pipeline
- Auto-detects GPU: MPS (macOS), CUDA (Linux), CPU fallback

### 1.2 Edge Worker (Cloudflare) — 28+ Routes, 59 Tests

| Category | Routes | Description |
|----------|--------|-------------|
| Session Management | `POST /session/start`, `/session/stop`, `/session/finalize-v2` | Full lifecycle |
| WebSocket | `GET /ws/audio` | Dual-stream real-time audio ingest |
| Speaker | `POST /speaker/enroll`, `GET /speaker/profiles` | Voice enrollment |
| Results | `GET /result/v2/:id`, `/result/v2/:id/report` | Tier 1 + Tier 2 results |
| Calendar | `GET /calendar/upcoming` | Meeting schedule |
| History | `GET /sessions`, `GET /sessions/:id/report` | Session archive |
| Admin | `POST /admin/cleanup`, `GET /admin/stats` | Maintenance |

**9-Stage Finalization Pipeline v2:**
1. **freeze** — Lock session state
2. **drain** — Flush remaining ASR buffers
3. **replay** — Re-process missed audio chunks
4. **local_asr** — Tier 1 Whisper transcription (batches of 5)
5. **reconcile** — Speaker binding resolution (priority: locked → cluster → enrollment → name)
6. **stats** — Compute session statistics
7. **events** — Detect support cues, interruptions, decisions
8. **report** — Memo-first LLM synthesis with evidence enrichment
9. **persist** — Store results in R2 + schedule Tier 2 alarm

**Provider Architecture (4 pluggable types):**

| Type | Providers | Default |
|------|-----------|---------|
| ASR | FunASR (streaming), Groq (both), OpenAI (batch), Local Whisper (batch) | FunASR |
| Diarization | pyannote-rs (streaming), pyannote-full (batch) | pyannote-rs |
| Speaker Verification | CAM++ via inference | CAM++ |
| LLM | DashScope (qwen-flash), OpenAI, Ollama | DashScope |

**Cost Profiles:**
- Cloud default: FunASR + DashScope ~$8/month
- Optimized: Groq + OpenAI ~$1/month
- Fully local: Local Whisper + Ollama $0/month

### 1.3 Desktop App (Electron + React) — 50+ IPC Methods, 63 Tests

| View | Features |
|------|----------|
| **Home** | Calendar integration (MS Graph + Google), upcoming meetings, quick start |
| **Setup** | 3-step wizard (participants, audio test, enrollment) |
| **Sidecar** | Real-time notes (TipTap), timer, audio levels, speaker indicators |
| **Feedback** | Radar chart, competency scores, evidence citations, claim drill-down |
| **History** | Date-grouped sessions, search, re-open reports |
| **Settings** | Audio devices, provider config, OAuth accounts, theme |

**Key Desktop Features:**
- Dual-stream audio capture (mic + system via Web Audio API)
- PiP overlay for background monitoring
- Zustand session store + service singletons
- OAuth login (Microsoft Graph + Google Calendar)
- Rich text notes editor (TipTap)
- Enrollment wizard with voice verification
- Animation system (motion/react)
- HashRouter for Electron file:// protocol

### 1.4 Test Coverage Summary

| Component | Tests | Time |
|-----------|-------|------|
| Desktop | 63 | ~2s |
| Inference | 95 | ~0.8s |
| Edge Worker | 59 | ~0.3s |
| **Total** | **217** | **~3.1s** |

> Note: docs/providers.md mentions 434 total tests including provider-specific tests added with the diarization upgrade.

---

## 2. Code Review Findings

### 2.1 Critical Issues (2)

| ID | Issue | File | Impact |
|----|-------|------|--------|
| CR-1 | **index.ts is 7,438 lines** — single largest maintainability risk. Mixes routing, WebSocket handling, Durable Object state, finalization pipeline, and business logic in one file | `edge/worker/src/index.ts` | Maintainability, testability, review difficulty |
| CR-2 | **Global mutable `_shared_client` not thread-safe** — httpx.AsyncClient shared across 64-thread pool without lock; race conditions possible during client replacement | `inference/app/services/dashscope_llm.py` | Data corruption, connection pool exhaustion |

### 2.2 Important Issues (8)

| ID | Issue | File |
|----|-------|------|
| IR-1 | API key in WebSocket URL query parameter (visible in logs, history) | `desktop/src/services/WebSocketService.ts` |
| IR-2 | ScriptProcessorNode is deprecated — should migrate to AudioWorkletNode | `desktop/src/services/AudioService.ts` |
| IR-3 | Generic `apiRequest` IPC without URL validation — SSRF risk | `desktop/preload.js` |
| IR-4 | Duplicate interface definitions between index.ts and types_v2.ts | `edge/worker/src/` |
| IR-5 | No schema validation on WebSocket JSON payloads | `edge/worker/src/index.ts` |
| IR-6 | enqueueMutation errors not logged server-side | `edge/worker/src/index.ts` |
| IR-7 | Reconnection doesn't verify DO session state match after reconnect | `desktop/src/services/WebSocketService.ts` |
| IR-8 | displayStream video tracks kept alive but disabled (resource waste) | `desktop/src/services/AudioService.ts` |

### 2.3 Suggestions (6)

| ID | Suggestion | File |
|----|-----------|------|
| SG-1 | Verbose SYNTH-DIAG logging at INFO level should be DEBUG | `inference/app/services/report_synthesizer.py` |
| SG-2 | Non-sequential prompt rule numbering (1-11, then 15-17) | `inference/app/services/report_synthesizer.py` |
| SG-3 | Queue drop warning flag never resets between sessions | `desktop/src/services/AudioService.ts` |
| SG-4 | Decompose index.ts into 5+ modules (router, ws-handler, durable-object, finalization, admin) | `edge/worker/src/index.ts` |
| SG-5 | Add input validation middleware for WebSocket messages using zod or similar | `edge/worker/src/index.ts` |
| SG-6 | Add `_shared_client_lock = asyncio.Lock()` for thread-safe client access | `inference/app/services/dashscope_llm.py` |

### 2.4 Previously Identified Issues (from 2026-02-15 Assessment)

The 6 Critical security issues (MF-1 through MF-6) and 10 Reliability issues (SF-1 through SF-10) from the production assessment remain relevant. See `docs/plans/2026-02-15-production-assessment.md` for details.

---

## 3. Competitive Analysis

### 3.1 Market Landscape (8 Competitors Analyzed)

| Product | Capture | Speaker ID | Key Differentiator | Funding/Status |
|---------|---------|------------|-------------------|----------------|
| **BrightHire** | Bot (Recall.ai) | Per-speaker streams | Greenhouse ATS auto-fill, 3M+ interviews | Acquired by Zoom |
| **Metaview** | Bot | Meeting metadata | Question-organized notes, AI Filters, resume+JD context | $35M Series B |
| **Pillar** | Bot | Meeting metadata | Real-time interviewer coaching, live prompts | Acquired by Employ |
| **HireVue** | Self-recorded video | Face+voice analysis | Game-based assessments, 40M+ candidates | $100M+ revenue |
| **HireLogic** | Phone/video integration | Auto-attribution | Virtual interviewer AI, passive analysis | Growing |
| **Fireflies** | Bot | AI diarization | 100+ languages, voice assistant, CRM integration | $1B unicorn |
| **Final Round AI** | Browser extension | N/A | Real-time answer suggestions for candidates (!) | Controversial |
| **Granola** | Local (native Swift) | Me/Them only | Native UX, no-bot, Recipes ecosystem | $67M |

### 3.2 Chorus Competitive Advantages

1. **Bot-free + real speaker diarization** — Only product combining local capture with per-speaker voice verification (CAM++ embeddings + online clustering). Granola only does Me/Them.
2. **Pluggable provider architecture** — 4 ASR, 2 diarization, 3 LLM providers. Competitors typically hardcoded to single providers.
3. **Bilingual EN + ZH** — Most competitors English-only or limited multilingual.
4. **Audio retention** — R2 storage enables Tier 2 re-processing. Granola discards audio.
5. **In-person/hybrid support** — Works for face-to-face, phone, any platform. Most competitors video-only.
6. **Cost flexibility** — $0/month fully local to $8/month cloud. BrightHire charges $300-500/seat/year.

### 3.3 Competitive Gaps

| Gap | Impact | Priority | Competitors with this |
|-----|--------|----------|----------------------|
| No ATS integration | Can't auto-fill Greenhouse/Lever scorecards | Critical | BrightHire, Metaview, Pillar |
| No interviewer coaching | Missing talk-time ratio, bias detection, question analysis | High | Pillar, HireVue |
| No compliance certs | SOC 2 is table stakes for enterprise | High | Granola, BrightHire |
| Single-file analysis | No cross-interview patterns or candidate comparison | Medium | Metaview (AI Filters), HireVue |
| No team collaboration | Can't share/discuss results with hiring team | Medium | BrightHire, Metaview |
| No video analysis | Missing facial expression, body language | Low | HireVue |

### 3.4 Real-time & Accuracy Assessment

**Real-time Status: Largely Resolved**
- Tier 1 finalization achieves <30s target via streaming ASR + cached embeddings + fast clustering
- Dual-stream capture eliminates echo issues
- Circuit breaker + failover routing prevents ASR downtime
- Chunk-based streaming with sequence tracking ensures no audio loss

**Accuracy Status: Significantly Improved, Work Remains**
- Two-tier model: Tier 1 (fast, ~85% WER) + Tier 2 (Whisper large-v3, ~95% WER)
- Global agglomerative clustering improves cross-window speaker consistency
- Name extraction (EN + ZH) auto-labels speakers
- Memo-first report generation with evidence validation
- **Remaining gap:** Single ASR provider for streaming (FunASR). Adding Deepgram/Groq for English would improve accuracy.

---

## 4. Teams API Research: Botless Real-Time Captions

### 4.1 The Opportunity

The user discovered that Teams' "Live Captions" accessibility feature shows speaker-attributed transcription during meetings. If programmatically accessible, this could bypass the entire ASR + diarization pipeline for Teams meetings, providing:
- Pre-diarized transcription (speaker name + text)
- Real-time delivery during the meeting
- Zero additional infrastructure cost

### 4.2 Dead Ends (Ruled Out First)

**CART API (Send-Only):** The Teams "Send real-time captions" API (`POST https://api.captions.office.microsoft.com/cartcaption`) is **SEND-only** — designed for CART providers to push human-typed captions INTO meetings. There is no corresponding GET endpoint to read AI-generated captions. **Ruled out.**

**TeamsJS SDK:** The `@microsoft/teams-js` SDK has no `registerCaptionHandler` or `onCaptionsReceived` API. Confirmed by [GitHub issue #8356](https://github.com/MicrosoftDocs/msteams-docs/issues/8356) which was closed without providing such an API. **Ruled out.**

### 4.3 Six Viable Approaches Investigated

#### Approach A: Azure Communication Services (ACS) TeamsCaptions — RECOMMENDED

**How it works:** Join a Teams meeting as an ACS participant, subscribe to `TeamsCaptionsInfo` events via the Calling SDK.

**Integration code:**
```typescript
import { CallClient, Features, TeamsCaptions } from '@azure/communication-calling';
import { AzureCommunicationTokenCredential } from '@azure/communication-common';

// 1. Join Teams meeting via ACS Calling SDK
const callAgent = await callClient.createCallAgent(tokenCredential);
const call = callAgent.join({ meetingLink: teamsJoinUrl });

// 2. Get captions feature
const captionsFeature = call.feature(Features.Captions);
const teamsCaptions = captionsFeature.captions as TeamsCaptions;

// 3. Subscribe to real-time captions
teamsCaptions.on('CaptionsReceived', (data: TeamsCaptionsInfo) => {
    // data.speaker.displayName          -- Speaker's name!
    // data.speaker.identifier.kind      -- 'microsoftTeamsUser' | 'communicationUser' | 'phoneNumber'
    // data.spokenText                   -- Original spoken text
    // data.captionText                  -- Transcribed/translated text
    // data.timestamp                    -- When the speech occurred
    // data.resultType                   -- 'Partial' or 'Final'
    // data.spokenLanguage               -- Speaker's language
    // data.captionLanguage              -- Output language
});

// 4. Start captions
await teamsCaptions.startCaptions({ spokenLanguage: 'en-us' });
```

**Full `TeamsCaptionsInfo` data structure:**

| Property | Type | Description |
|----------|------|-------------|
| `speaker.displayName` | string | Speaker's display name |
| `speaker.identifier.kind` | enum | `communicationUser`, `microsoftTeamsUser`, or `phoneNumber` |
| `speaker.identifier.microsoftTeamsUserId` | string | Teams user MRI |
| `spokenText` | string | Original speech text |
| `captionText` | string | Transcribed/translated text |
| `timestamp` | Date | When speech was made |
| `resultType` | enum | `Partial` (live) or `Final` (complete sentence) |
| `captionLanguage` | string | BCP 47 language code |
| `spokenLanguage` | string | Speaker's language |

**Pros:**
- Official Microsoft SDK (supported, documented, stable)
- Speaker attribution built-in (displayName from meeting roster)
- Real-time streaming (partial + final results)
- No bot required (ACS participant is an SDK client, not a bot)
- Supports 34 languages
- SDK available: `@azure/communication-calling`, `@azure/communication-common`
- Available on Web, iOS, Android, Windows

**Cons:**
- Requires ACS resource ($0.004/min for PSTN, free for VoIP calling)
- Meeting organizer must enable captions
- ACS participant appears in participant list (visible but not as intrusive as a bot)
- Captions may have ~2-5s latency vs raw audio
- No individual audio streams (text only)
- Translated captions require Teams Premium license on meeting organizer

**Verdict:** Best official approach. Provides exactly the speaker-attributed transcription needed. The ACS participant is less intrusive than a bot since it can be named "Chorus Assistant" or similar.

**Sources:**
- [Enable closed captions for Teams interop - ACS](https://learn.microsoft.com/en-us/azure/communication-services/how-tos/calling-sdk/closed-captions-teams-interop-how-to)
- [Teams meeting interoperability](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting)

#### Approach B: ACS Unmixed Audio Streams

**How it works:** ACS Calling SDK (v1.15+) can receive **separate PCM streams per speaker** via unmixed audio.

**Critical limitation:** Limited to **4 dominant speakers** at any given time. When a new speaker becomes dominant, the least recent one is swapped out.

**Verdict:** Could supplement Approach A by providing per-speaker audio for our own ASR/SV pipeline, but the 4-speaker limit makes it impractical for larger interviews.

#### Approach C: Graph API Meeting Transcripts — POST-HOC ONLY

**How it works:** After meeting ends, fetch transcripts via Microsoft Graph API.

**API:**
```
GET /me/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content
```
Returns VTT format: `<v Speaker Name>spoken text</v>`

**Change notifications available:**
```
POST /v1.0/subscriptions
Resource: communications/onlineMeetings/getAllTranscripts
```

**Pros:**
- Fully invisible (no participant added)
- Complete transcript with speaker attribution (VTT format)
- High accuracy (Microsoft's ASR)
- Can subscribe to webhook for transcript availability

**Cons:**
- **Not real-time** — only available after meeting ends
- Requires admin consent (Application permissions: `OnlineMeetings.Read`)
- Transcript may take minutes to process
- `callRecords` API can take up to 2 hours post-call

**Verdict:** Excellent for Tier 2 re-processing. Could replace Whisper batch processing for Teams meetings but doesn't help with real-time Tier 1.

**Sources:**
- [Get callTranscript - Microsoft Graph v1.0](https://learn.microsoft.com/en-us/graph/api/calltranscript-get)
- [Get change notifications for transcripts](https://learn.microsoft.com/en-us/graph/teams-changenotifications-callrecording-and-calltranscript)

#### Approach D: DOM Scraping via Browser Extension — TRULY INVISIBLE

**How it works:** Browser extension injects content script into Teams web client, reads Live Captions DOM elements via MutationObserver.

**Existing tools:** [MS Teams Live Captions Saver](https://github.com/Zerg00s/Live-Captions-Saver) (open-source), [Tactiq](https://tactiq.io/) ($12/month commercial)

**Technical approach:**
```javascript
// MutationObserver on captions container
const observer = new MutationObserver((mutations) => {
  for (const node of mutations[0].addedNodes) {
    const speaker = node.querySelector('.speaker-name')?.textContent;
    const text = node.querySelector('.caption-text')?.textContent;
    // Send to Chorus backend via WebSocket
  }
});
observer.observe(captionsContainer, { childList: true, subtree: true });
```

**Pros:**
- Completely invisible to other participants
- Real-time captions as they appear
- No API costs
- Speaker attribution from DOM

**Cons:**
- **Extremely fragile** — Microsoft can change DOM structure anytime
- Only works in Teams web client (not desktop app — Teams migrated from Electron to WebView2 in 2025)
- Violates Teams ToS
- Maintenance nightmare (every Teams update could break it)
- No SDK or API contract

**Verdict:** Technically feasible as a prototype/demo but not production-viable. Too fragile and risky for a commercial product. Existing open-source implementations prove the concept works.

#### Approach E: Recall.ai Desktop Recording SDK

**How it works:** npm package (`@recall.ai/desktop-sdk`) that captures system audio at OS level.

**Pros:**
- Works with Teams, Zoom, Google Meet
- No bot, no participant added, truly invisible
- Raw audio access + real-time transcription via webhooks
- Captures participant metadata (names, join/leave events)

**Cons:**
- Third-party dependency (cost unknown, likely per-seat)
- Still requires our own ASR + diarization for speaker attribution
- macOS + Windows only

**Verdict:** Good capture alternative but doesn't solve the transcription/diarization problem. Provides raw audio, not pre-attributed captions.

#### Approach F: Bot Media SDK (Full Unmixed Audio)

**How it works:** Graph Communications Bot Media SDK can receive unmixed meeting audio via `ReceiveUnmixedMeetingAudio`.

**Verdict:** Requires a registered bot that joins the meeting — defeats the "no bot" requirement. Included for completeness only.

### 4.4 Comparison Matrix

| Approach | Real-Time | Speaker Attribution | No Visible Participant | No Bot | Platform |
|----------|-----------|--------------------|-----------------------|--------|----------|
| CART API | Yes (send only) | N/A | Yes | Yes | Any |
| TeamsJS SDK | N/A (no receive API) | N/A | N/A | N/A | Teams App |
| **A: ACS TeamsCaptions** | **Yes** | **Yes (full)** | **No (external user)** | **Yes** | Web/iOS/Android/Win |
| B: ACS Unmixed Audio | Yes | Yes (4 dominant) | No | Yes | Web/iOS/Android/Win |
| C: Graph Transcripts | No (post-meeting) | Yes (VTT) | **Yes** | **Yes** | Any |
| D: DOM Scraping | Yes | Yes | **Yes** | **Yes** | Web Teams only |
| E: Recall.ai SDK | Yes | Via own ASR | **Yes** | **Yes** | Desktop only |
| F: Bot Media SDK | Yes | Yes (full unmixed) | No (bot) | No | Server-side |

### 4.5 Recommended Strategy

**Dual-path approach:**

1. **Real-time (Tier 1):** ACS TeamsCaptions for speaker-attributed live transcription
   - Eliminates need for ASR + diarization for Teams meetings
   - Falls back to existing pipeline (FunASR + CAM++) for non-Teams meetings
   - Speaker attribution comes free from meeting roster

2. **Post-meeting (Tier 2):** Graph API transcripts for high-accuracy re-processing
   - Replaces Whisper batch processing for Teams meetings
   - Falls back to existing Tier 2 (Whisper + pyannote) for non-Teams meetings
   - Subscribe to change notifications for automatic pickup

**Implementation estimate:** ACS prototype ~3-5 days, Graph API integration ~2-3 days.

### 4.6 Per-Speaker Audio Streams

Microsoft has explicitly stated: audio and video sessions can only be accessed using `Microsoft.Graph.Communications.Calls.Media`, which **requires bots**. There is no API to get raw audio from a Teams meeting without a bot or participant.

ACS unmixed audio provides separate PCM streams but is limited to 4 dominant speakers — insufficient for group interviews.

### 4.7 Key Finding: Not Truly "Botless" but Minimally Intrusive

Microsoft deliberately does not provide a "silent wiretap" API. Every official real-time approach requires some form of visible participant. However:
- ACS participant can be named "Chorus Note Taker" (human-readable, professional)
- It's just a text caption subscriber, not recording audio
- Much less intrusive than Recall.ai bots that join as "RecallBot" with video/audio
- Can be auto-admitted via meeting settings (bypass lobby)

The only truly invisible approaches are:
1. **DOM scraping** of live captions (fragile, web-only, ToS violation)
2. **System audio capture** via Recall.ai SDK (requires own ASR)
3. **Post-meeting Graph API** transcripts (not real-time)

---

## 5. Architecture Health Summary

### 5.1 Strengths
- Pluggable provider architecture is well-designed and future-proof
- Two-tier processing model is architecturally sound
- Failover/circuit breaker pattern provides reliability
- 217+ tests with good coverage across all 3 components
- Clean separation of concerns (mostly) between inference, worker, and desktop

### 5.2 Top Technical Debt Items

| Priority | Item | Effort |
|----------|------|--------|
| 1 | Decompose `index.ts` (7,438 lines) | 3-5 days |
| 2 | Fix 6 security issues from production assessment | 3-5 days |
| 3 | Thread-safe httpx client in dashscope_llm.py | 1 hour |
| 4 | Migrate ScriptProcessorNode → AudioWorkletNode | 2-3 days |
| 5 | Add URL validation to `apiRequest` IPC (SSRF) | 2 hours |
| 6 | Move API key from WS query param to IPC | 1 day |

### 5.3 Strategic Recommendations

1. **Short-term (1-2 weeks):** Fix Critical security issues + decompose index.ts
2. **Medium-term (1 month):** ACS TeamsCaptions integration + Graph API transcripts
3. **Long-term (Q2-Q3):** ATS integration (Greenhouse) + SOC 2 certification

---

## Appendix: Research Sources

### Code Review
- 4 parallel agents analyzing all 3 components (inference, edge worker, desktop)
- Internal docs: `production-assessment.md`, `speaker-diarization-upgrade-design.md`, `providers.md`

### Competitive Analysis
- BrightHire, Metaview, Pillar, HireVue, HireLogic, Fireflies, Final Round AI, Granola
- Product websites, pricing pages, documentation, and engineering blog posts

### Teams API Research
- [ACS Closed Captions for Teams Interop](https://learn.microsoft.com/en-us/azure/communication-services/how-tos/calling-sdk/closed-captions-teams-interop-how-to)
- [ACS Teams Meeting Interoperability](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting)
- [ACS Capabilities for Teams External Users](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/guest/meeting-capabilities)
- [Graph API callTranscript](https://learn.microsoft.com/en-us/graph/api/calltranscript-get)
- [Graph Change Notifications for Transcripts](https://learn.microsoft.com/en-us/graph/teams-changenotifications-callrecording-and-calltranscript)
- [Teams Meeting Apps APIs](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/meeting-apps-apis)
- [CART Captions in Teams](https://support.microsoft.com/en-us/office/use-cart-captions-in-a-microsoft-teams-meeting-human-generated-captions-2dd889e8-32a8-4582-98b8-6c96cf14eb47)
- [MS Teams Live Captions Saver (GitHub)](https://github.com/Zerg00s/Live-Captions-Saver)
- [Tactiq Bot-Free Transcription](https://tactiq.io/chrome-extension)
- [Recall.ai Desktop Recording SDK](https://www.recall.ai/product/desktop-recording-sdk)
- [GitHub Issue #8356 - Caption API Request](https://github.com/MicrosoftDocs/msteams-docs/issues/8356)
- [Teams Audio Stream Access Q&A](https://learn.microsoft.com/en-us/answers/questions/559959/microsoft-team-live-video-and-audio-stream-access)
