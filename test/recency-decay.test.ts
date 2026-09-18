import { describe, expect, it } from 'bun:test';
import { recencyFactor } from '../src/search/recency-decay.ts';

describe('gbrain fallback recency decay', () => {
  const on = { mode: 'on', halflifeDays: 90, coefficient: 0.3 } as const;

  it('is neutral when off, missing, or disabled by either numeric knob', () => {
    expect(recencyFactor('2024-01-01', '2024-02-01', { ...on, mode: 'off' })).toBe(1);
    expect(recencyFactor(null, '2024-02-01', on)).toBe(1);
    expect(recencyFactor('2024-01-01', '2024-02-01', { ...on, halflifeDays: 0 })).toBe(1);
    expect(recencyFactor('2024-01-01', '2024-02-01', { ...on, coefficient: 0 })).toBe(1);
  });

  it('halves the component at one half-life and applies strong at 1.5x', () => {
    expect(recencyFactor('2024-01-01', '2024-03-31', on)).toBeCloseTo(1.15, 10);
    expect(recencyFactor('2024-01-01', '2024-03-31', { ...on, mode: 'strong' })).toBeCloseTo(1.225, 10);
  });

  it('clamps future dates to age zero', () => {
    expect(recencyFactor('2025-01-01', '2024-01-01', on)).toBeCloseTo(1.3, 10);
  });
});
