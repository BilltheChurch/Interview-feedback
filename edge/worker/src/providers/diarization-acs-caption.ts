/**
 * ACS Caption Diarization Provider.
 *
 * Uses Teams displayName from ACS captions for speaker identity.
 * No SV embedding extraction or clustering needed — Teams provides
 * speaker attribution directly via the meeting roster.
 *
 * This replaces the CAM++ SV + global clustering pipeline when
 * operating in ACS caption mode.
 */

import type { DiarizationProvider, CaptionEvent } from "./types";

/** Resolved caption with speaker identity. */
export interface ResolvedCaption {
  speaker_id: string;
  speaker_name: string;
  text: string;
  language: string;
  timestamp_ms: number;
}

/**
 * Diarization provider using Teams displayName for speaker identity.
 * No SV or clustering needed — Teams provides speaker attribution directly.
 */
export class ACSCaptionDiarizationProvider implements DiarizationProvider {
  readonly name = "acs-caption";
  readonly mode = "streaming" as const;

  private speakerMap = new Map<string, string>();

  /**
   * Resolve a display name to a stable speaker_id.
   * Assigns sequential IDs (spk_0, spk_1, ...) on first encounter.
   */
  resolveSpeaker(displayName: string): string {
    if (!this.speakerMap.has(displayName)) {
      this.speakerMap.set(displayName, `spk_${this.speakerMap.size}`);
    }
    return this.speakerMap.get(displayName)!;
  }

  /**
   * Get the complete displayName -> speaker_id mapping.
   */
  getSpeakerMap(): Record<string, string> {
    return Object.fromEntries(this.speakerMap);
  }

  /**
   * Resolve an array of caption events into utterances with speaker_ids.
   * Each caption gets a stable speaker_id based on its displayName.
   */
  resolveCaptions(captions: CaptionEvent[]): ResolvedCaption[] {
    return captions.map((c) => ({
      speaker_id: this.resolveSpeaker(c.speaker),
      speaker_name: c.speaker,
      text: c.text,
      language: c.language,
      timestamp_ms: c.timestamp_ms,
    }));
  }
}
