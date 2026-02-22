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
