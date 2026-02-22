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
   */
  async connect(
    meetingLink: string,
    token: string,
    onCaption: CaptionCallback,
    displayName = 'Chorus \u52a9\u624b',
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
