import { CallClient, Features } from '@azure/communication-calling';
import type { Call, CallAgent, CaptionsCommon, TeamsCaptions, TeamsCaptionsInfo } from '@azure/communication-calling';
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

export type StatusChangeCallback = (status: CaptionStatus) => void;

/**
 * Service singleton for ACS Teams caption integration.
 * Joins a Teams meeting as anonymous external user and subscribes to captions.
 *
 * Key design: We must NOT call muteIncomingAudio() — Teams removes participants
 * with zero active media streams after ~2-3 minutes. Instead, we suppress incoming
 * audio locally by muting the Electron <audio> elements that the SDK creates.
 */
export class ACSCaptionService {
  private static instance: ACSCaptionService;
  private callClient: CallClient | null = null;
  private callAgent: CallAgent | null = null;
  private call: Call | null = null;
  private status: CaptionStatus = 'disconnected';
  private onCaption: CaptionCallback | null = null;
  private onStatusChange: StatusChangeCallback | null = null;
  private audioSuppressor: MutationObserver | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private meetingLink: string = '';
  private token: string = '';
  private displayName: string = '';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  static getInstance(): ACSCaptionService {
    if (!ACSCaptionService.instance) {
      ACSCaptionService.instance = new ACSCaptionService();
    }
    return ACSCaptionService.instance;
  }

  getStatus(): CaptionStatus {
    return this.status;
  }

  private setStatus(s: CaptionStatus): void {
    this.status = s;
    this.onStatusChange?.(s);
  }

  /**
   * Connect to a Teams meeting and start receiving captions.
   */
  async connect(
    meetingLink: string,
    token: string,
    onCaption: CaptionCallback,
    displayName = 'Chorus \u52a9\u624b',
    onStatusChange?: StatusChangeCallback,
  ): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') return;

    this.onStatusChange = onStatusChange ?? null;
    this.setStatus('connecting');
    this.onCaption = onCaption;
    this.meetingLink = meetingLink;
    this.token = token;
    this.displayName = displayName;
    this.reconnectAttempts = 0;

    await this.joinMeeting();
  }

  private async joinMeeting(): Promise<void> {
    try {
      // Pre-warm media permissions in Electron. The ACS SDK needs WebRTC
      // getUserMedia to succeed before it can establish a peer connection.
      try {
        console.log('[ACSCaptionService] Pre-warming media permissions...');
        const warmupStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        warmupStream.getTracks().forEach(t => t.stop());
        console.log('[ACSCaptionService] Media permissions granted');
      } catch (mediaErr) {
        console.warn('[ACSCaptionService] Media pre-warm failed:', mediaErr);
      }

      this.callClient = new CallClient();
      const credential = new AzureCommunicationTokenCredential(this.token);
      this.callAgent = await this.callClient.createCallAgent(credential, {
        displayName: this.displayName,
      });

      // Suppress incoming audio BEFORE joining — intercept <audio> elements
      // that the ACS SDK creates and mute them locally. This keeps the media
      // pipeline active (Teams won't kick us) while preventing audible output.
      this.startAudioSuppression();

      // Join with mic muted. Do NOT pass localAudioStreams:[] — the SDK must
      // set up its internal media pipeline for the call to transition from None.
      console.log('[ACSCaptionService] Joining meeting:', this.meetingLink.slice(0, 80));
      this.call = this.callAgent.join(
        { meetingLink: this.meetingLink },
        { audioOptions: { muted: true } },
      );

      console.log('[ACSCaptionService] Initial call state:', this.call.state);

      // ── Wait for call to reach Connected state ──
      // CRITICAL: captions.kind and startCaptions() are only reliable AFTER
      // the call is Connected. The SDK docs explicitly state that startCaptions()
      // resolving does NOT mean captions have started.
      await this.waitForConnected();

      // ── Set up captions AFTER connection is established ──
      await this.setupCaptions();

      this.setStatus('connected');
    } catch (err) {
      this.setStatus('error');
      console.error('[ACSCaptionService] connect failed:', err);
      throw err;
    }
  }

  /**
   * Wait for the call to reach Connected state. Handles Connecting, InLobby,
   * and Disconnected transitions. Times out after 60s.
   */
  private waitForConnected(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.call) {
        reject(new Error('No call object'));
        return;
      }

      // Already connected (unlikely but handle it)
      if (this.call.state === 'Connected') {
        console.log('[ACSCaptionService] Call already Connected');
        this.reconnectAttempts = 0;
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Call did not reach Connected state within 60s'));
      }, 60_000);

      const handler = () => {
        const s = this.call?.state;
        console.log('[ACSCaptionService] Call state:', s);

        if (s === 'Connected') {
          console.log('[ACSCaptionService] Call connected successfully');
          this.reconnectAttempts = 0;
          cleanup();
          resolve();
        } else if (s === 'InLobby') {
          console.log('[ACSCaptionService] In lobby — waiting for organizer to admit');
          // Don't resolve or reject — keep waiting
        } else if (s === 'Disconnected') {
          const reason = (this.call as any)?.callEndReason;
          console.warn('[ACSCaptionService] Call disconnected before connecting:', {
            code: reason?.code,
            subCode: reason?.subCode,
            message: reason?.message,
          });
          cleanup();
          reject(new Error(`Call disconnected: code=${reason?.code} subCode=${reason?.subCode}`));
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.call?.off('stateChanged', handler);
      };

      this.call.on('stateChanged', handler);
    });
  }

  /**
   * Set up caption subscription AFTER call is Connected.
   * At this point captions.kind is reliable and startCaptions will work.
   */
  private async setupCaptions(): Promise<void> {
    if (!this.call) throw new Error('No call object for caption setup');

    const captionsFeature = this.call.feature(Features.Captions);
    const captions = captionsFeature.captions;

    console.log('[ACSCaptionService] Captions kind:', captions.kind,
      'isCaptionsFeatureActive:', (captions as any).isCaptionsFeatureActive);

    // Subscribe to the correct caption object based on kind
    this.subscribeToCaptions(captions);

    // Listen for kind changes — the SDK may switch from Captions to TeamsCaptions
    captionsFeature.on('CaptionsKindChanged', () => {
      const newCaptions = captionsFeature.captions;
      console.log('[ACSCaptionService] CaptionsKindChanged — new kind:', newCaptions.kind);
      this.subscribeToCaptions(newCaptions);
      // Must call startCaptions on the NEW object after kind change
      (newCaptions as TeamsCaptions).startCaptions({ spokenLanguage: 'zh-cn' }).catch((err) => {
        console.warn('[ACSCaptionService] startCaptions after kind change failed:', err);
      });
    });

    // Start captions — this submits the request; CaptionsActiveChanged confirms activation
    console.log('[ACSCaptionService] Calling startCaptions...');
    await (captions as TeamsCaptions).startCaptions({ spokenLanguage: 'zh-cn' });
    console.log('[ACSCaptionService] startCaptions resolved, waiting for CaptionsActiveChanged...');

    // Also register disconnect handler now that we're connected
    this.call.on('stateChanged', () => {
      const s = this.call?.state;
      if (s === 'Disconnected') {
        const reason = (this.call as any)?.callEndReason;
        console.warn('[ACSCaptionService] Call disconnected:', {
          code: reason?.code,
          subCode: reason?.subCode,
          message: reason?.message,
        });
        this.handleDisconnect();
      }
    });
  }

  /**
   * Subscribe to CaptionsReceived and CaptionsActiveChanged on the given captions object.
   */
  private subscribeToCaptions(captions: CaptionsCommon): void {
    if (captions.kind === 'TeamsCaptions') {
      const teamsCaptions = captions as TeamsCaptions;
      teamsCaptions.on('CaptionsReceived', this.handleCaption);
      teamsCaptions.on('CaptionsActiveChanged', () => {
        console.log('[ACSCaptionService] CaptionsActiveChanged — active:',
          (teamsCaptions as any).isCaptionsFeatureActive);
      });
      console.log('[ACSCaptionService] Subscribed to TeamsCaptions events');
    } else {
      console.warn('[ACSCaptionService] Captions kind is:', captions.kind, '(not TeamsCaptions) — subscribing via cast');
      (captions as any).on('CaptionsReceived', this.handleCaption);
      (captions as any).on('CaptionsActiveChanged', () => {
        console.log('[ACSCaptionService] CaptionsActiveChanged (non-Teams) — active:',
          (captions as any).isCaptionsFeatureActive);
      });
    }
  }

  /**
   * Suppress ACS SDK incoming audio by muting any <audio> elements it creates.
   * The SDK inserts hidden <audio> elements into the DOM for WebRTC media playback.
   * We mute these locally so the user doesn't hear double audio (they're already
   * in the meeting via Teams client), while keeping the WebRTC media streams
   * active so Teams doesn't remove us as an idle participant.
   */
  private startAudioSuppression(): void {
    // Mute any existing <audio> elements
    this.muteAllAudioElements();

    // Watch for new <audio> elements added by the SDK
    this.audioSuppressor = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLAudioElement) {
            node.muted = true;
            node.volume = 0;
          }
          // Also check children of added nodes
          if (node instanceof HTMLElement) {
            node.querySelectorAll('audio').forEach((audio) => {
              audio.muted = true;
              audio.volume = 0;
            });
          }
        }
      }
    });

    this.audioSuppressor.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private muteAllAudioElements(): void {
    document.querySelectorAll('audio').forEach((audio) => {
      audio.muted = true;
      audio.volume = 0;
    });
  }

  private stopAudioSuppression(): void {
    this.audioSuppressor?.disconnect();
    this.audioSuppressor = null;
  }

  /**
   * Handle unexpected disconnection with auto-reconnect.
   */
  private handleDisconnect(): void {
    // Don't reconnect if we intentionally disconnected
    if (this.status === 'disconnected') return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[ACSCaptionService] Max reconnect attempts reached, giving up');
      this.setStatus('error');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectAttempts * 5_000; // 5s, 10s, 15s backoff
    console.log(`[ACSCaptionService] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.cleanupCallResources();

    this.reconnectTimer = setTimeout(async () => {
      if (this.status === 'disconnected') return; // User disconnected during wait
      try {
        this.setStatus('connecting');
        await this.joinMeeting();
      } catch (err) {
        console.error('[ACSCaptionService] Reconnect failed:', err);
        this.handleDisconnect();
      }
    }, delay);
  }

  private cleanupCallResources(): void {
    try {
      if (this.call) {
        this.call.hangUp().catch(() => {});
        this.call = null;
      }
      if (this.callAgent) {
        this.callAgent.dispose().catch(() => {});
        this.callAgent = null;
      }
      this.callClient = null;
    } catch {
      // Cleanup errors are non-fatal
    }
  }

  /** Disconnect from Teams meeting. */
  async disconnect(): Promise<void> {
    // Mark as disconnected FIRST to prevent auto-reconnect
    this.setStatus('disconnected');
    this.onCaption = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopAudioSuppression();

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
  }

  private handleCaption = (data: TeamsCaptionsInfo) => {
    console.log('[ACSCaptionService] CaptionsReceived:', {
      speaker: data.speaker?.displayName,
      text: data.spokenText?.slice(0, 50),
      resultType: data.resultType,
      kind: (data as any).kind,
      captionText: (data as any).captionText?.slice(0, 50),
    });
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
