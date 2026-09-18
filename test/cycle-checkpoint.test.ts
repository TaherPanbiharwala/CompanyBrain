// fingerprintParams: pure, offline. The DB round-trip (load/save/clear against op_checkpoints)
// lives in test/cycle.live.test.ts since it needs a real database.
import { describe, it, expect } from 'bun:test';
import { fingerprintParams } from '../src/core/cycle/checkpoint.ts';

describe('fingerprintParams', () => {
  it('is deterministic for the same params', () => {
    expect(fingerprintParams({ a: 1, b: 'x' })).toBe(fingerprintParams({ a: 1, b: 'x' }));
  });

  it('is independent of key order (canonicalized before hashing)', () => {
    expect(fingerprintParams({ a: 1, b: 2 })).toBe(fingerprintParams({ b: 2, a: 1 }));
  });

  it('differs when a param value changes — an unrelated param change starts a fresh checkpoint', () => {
    expect(fingerprintParams({ a: 1 })).not.toBe(fingerprintParams({ a: 2 }));
  });

  it('differs for nested objects with reordered keys the same way as top-level', () => {
    const f1 = fingerprintParams({ outer: { x: 1, y: 2 } });
    const f2 = fingerprintParams({ outer: { y: 2, x: 1 } });
    expect(f1).toBe(f2);
  });

  it('returns a fixed-length hex string', () => {
    const fp = fingerprintParams({});
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});
