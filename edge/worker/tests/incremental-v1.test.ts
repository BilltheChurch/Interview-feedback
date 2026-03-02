import { describe, it, expect } from 'vitest';
import {
  buildStartFrameV1,
  buildFinalizePayloadV1,
  MAX_QUEUE_CHUNKS,
  shouldDropChunk,
} from '../src/incremental_v1';

describe('V1 StartFrame builder', () => {
  it('should produce a valid V1 StartFrame', () => {
    const frame = buildStartFrameV1({
      sessionId: 'sess-1',
      incrementId: 'uuid-001',
      incrementIndex: 0,
      audioStartMs: 0,
      audioEndMs: 180000,
      language: 'en',
      runAnalysis: true,
      totalFrames: 100,
    });

    expect(frame.v).toBe(1);
    expect(frame.type).toBe('start');
    expect(frame.audio_start_ms).toBe(0);
    expect(frame).not.toHaveProperty('start_ms'); // P0 fix
  });
});

describe('V1 Finalize payload builder', () => {
  it('should use r2_audio_refs NOT audio_b64', () => {
    const payload = buildFinalizePayloadV1({
      sessionId: 'sess-1',
      r2AudioRefs: [
        { key: 'chunks/sess-1/000.pcm', startMs: 0, endMs: 10000 },
      ],
      totalAudioMs: 10000,
      locale: 'en-US',
    });

    expect(payload.v).toBe(1);
    expect(payload).not.toHaveProperty('audio_b64');
    expect(payload.r2_audio_refs).toHaveLength(1);
  });
});

describe('Queue backpressure', () => {
  it('should enforce MAX_QUEUE_CHUNKS', () => {
    expect(MAX_QUEUE_CHUNKS).toBeGreaterThan(0);
    expect(MAX_QUEUE_CHUNKS).toBeLessThanOrEqual(1000);
  });

  it('should drop oldest when queue full', () => {
    const result = shouldDropChunk(MAX_QUEUE_CHUNKS + 1, MAX_QUEUE_CHUNKS);
    expect(result.drop).toBe(true);
    expect(result.reason).toContain('backpressure');
  });

  it('should allow when under limit', () => {
    const result = shouldDropChunk(10, MAX_QUEUE_CHUNKS);
    expect(result.drop).toBe(false);
  });
});
