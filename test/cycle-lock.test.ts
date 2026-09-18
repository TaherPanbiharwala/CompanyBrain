// Pure-function coverage of the ported liveness classifier — no database. Same shape as gbrain's
// own db-lock tests: cross-host, alive/EPERM, too-young, dead-eligible, unknown-probe-error cases.
import { describe, it, expect } from 'bun:test';
import { classifyHolderLiveness, isHolderDeadLocally, resolveStealGraceSeconds, cycleLockKey, HOLDER_TAKEOVER_GRACE_MS } from '../src/core/cycle/lock.ts';

function killThrowing(code: string): (pid: number, signal: number) => void {
  return () => {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };
}

describe('classifyHolderLiveness', () => {
  it('cross-host holder is never eligible for local takeover, regardless of age', () => {
    const result = classifyHolderLiveness(123, 'other-host', 999_999_999, { localHost: 'this-host' });
    expect(result).toBe('cross_host');
  });

  it('a probe that succeeds (process alive) reports alive', () => {
    const result = classifyHolderLiveness(123, 'this-host', 0, { localHost: 'this-host', processKill: () => {} });
    expect(result).toBe('alive');
  });

  it('EPERM (pid exists, not ours) is treated as alive — never steal a live-but-foreign process', () => {
    const result = classifyHolderLiveness(123, 'this-host', 999_999_999, { localHost: 'this-host', processKill: killThrowing('EPERM') });
    expect(result).toBe('alive');
  });

  it('ESRCH (provably dead) younger than the grace window is too_young, not eligible', () => {
    const result = classifyHolderLiveness(123, 'this-host', HOLDER_TAKEOVER_GRACE_MS - 1, {
      localHost: 'this-host',
      processKill: killThrowing('ESRCH'),
    });
    expect(result).toBe('too_young');
  });

  it('ESRCH past the grace window is dead_eligible', () => {
    const result = classifyHolderLiveness(123, 'this-host', HOLDER_TAKEOVER_GRACE_MS + 1, {
      localHost: 'this-host',
      processKill: killThrowing('ESRCH'),
    });
    expect(result).toBe('dead_eligible');
  });

  it('an unrecognized probe error is unknown — conservative, never eligible', () => {
    const result = classifyHolderLiveness(123, 'this-host', HOLDER_TAKEOVER_GRACE_MS + 1, {
      localHost: 'this-host',
      processKill: killThrowing('EIO'),
    });
    expect(result).toBe('unknown');
  });

  it('isHolderDeadLocally is true only for dead_eligible', () => {
    expect(isHolderDeadLocally(1, 'h', HOLDER_TAKEOVER_GRACE_MS + 1, { localHost: 'h', processKill: killThrowing('ESRCH') })).toBe(true);
    expect(isHolderDeadLocally(1, 'h', HOLDER_TAKEOVER_GRACE_MS - 1, { localHost: 'h', processKill: killThrowing('ESRCH') })).toBe(false);
    expect(isHolderDeadLocally(1, 'other', 999_999_999, { localHost: 'h' })).toBe(false);
  });
});

describe('resolveStealGraceSeconds', () => {
  it('scales with the TTL (refresh fires ~ttl/6, grace is ~2 ticks), with a 60s floor', () => {
    expect(resolveStealGraceSeconds(30)).toBe(600); // 30*60/6=300, *2=600
    expect(resolveStealGraceSeconds(1)).toBe(60); // 1*60/6=10 -> floor 15, *2=30 -> floor 60
  });

  it('CB_CYCLE_LOCK_STEAL_GRACE_SECONDS overrides the computed value and its own 60s floor', () => {
    const prev = process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS;
    try {
      process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS = '3';
      expect(resolveStealGraceSeconds(30)).toBe(3); // would otherwise be 600
    } finally {
      if (prev === undefined) delete process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS;
      else process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS = prev;
    }
  });

  it('ignores a non-positive or non-integer override and falls back to the computed value', () => {
    const prev = process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS;
    try {
      process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS = '0';
      expect(resolveStealGraceSeconds(30)).toBe(600);
      process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS = 'not-a-number';
      expect(resolveStealGraceSeconds(30)).toBe(600);
    } finally {
      if (prev === undefined) delete process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS;
      else process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS = prev;
    }
  });
});

describe('cycleLockKey', () => {
  it('namespaces by workspace id', () => {
    expect(cycleLockKey('abc-123')).toBe('cycle:abc-123');
  });
});
