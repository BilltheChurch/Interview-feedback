import type { ASRProvider, Utterance, CaptionEvent } from './types';

/**
 * ASR Provider that converts ACS TeamsCaptions data into standard Utterances.
 * No actual ASR processing — Teams already provides transcribed text.
 */
export class ACSCaptionASRProvider implements ASRProvider {
  readonly name = 'acs-caption';
  readonly mode = 'streaming' as const;

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

  private estimateDuration(text: string): number {
    return Math.max(1000, text.length * 250);
  }
}
