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
