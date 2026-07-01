import { describe, it, expect } from 'vitest';
import { formatSessionTime } from './formatTime';

describe('formatSessionTime', () => {
  it('formats 0 as 00:00', () => {
    expect(formatSessionTime(0)).toBe('00:00');
  });

  it('formats 65000ms (1m5s) as 01:05', () => {
    expect(formatSessionTime(65000)).toBe('01:05');
  });

  it('floors sub-second remainders', () => {
    expect(formatSessionTime(999)).toBe('00:00');
    expect(formatSessionTime(59999)).toBe('00:59');
  });

  it('formats minute boundaries', () => {
    expect(formatSessionTime(60000)).toBe('01:00');
    expect(formatSessionTime(600000)).toBe('10:00');
  });

  it('clamps negatives to 00:00', () => {
    expect(formatSessionTime(-5000)).toBe('00:00');
  });
});
