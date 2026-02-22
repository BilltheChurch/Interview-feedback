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
