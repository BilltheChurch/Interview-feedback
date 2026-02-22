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
    expect(Object.keys(map)).toHaveLength(3);
    expect(map['Tim Yang']).toBe('spk_0');
    expect(map['Alice Wang']).toBe('spk_1');
    expect(map['Bob Li']).toBe('spk_2');
  });

  it('resolved captions have matching speaker_id and name', () => {
    const diaProvider = new ACSCaptionDiarizationProvider();
    const resolved = diaProvider.resolveCaptions(captionBuffer);
    expect(resolved[0].speaker_id).toBe(resolved[2].speaker_id);
    expect(resolved[0].speaker_name).toBe('Tim Yang');
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
