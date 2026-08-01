// Registry-parameterized structural guard (review AM11): every op auto-inherits these checks, so
// M3's ops can't silently violate the invariants. This is the seed of the CI-forever guard.
import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { operations } from '../src/api/operations.ts';
import { summarizeParams } from '../src/api/redact.ts';

const VALID_ROLES = new Set(['member', 'admin', 'owner']);

describe('operation registry — structural invariants (every op)', () => {
  for (const op of operations) {
    it(`${op.name}: params is a z.object`, () => {
      expect(op.params instanceof z.ZodObject).toBe(true);
    });
    it(`${op.name}: name + description present`, () => {
      expect(op.name.length).toBeGreaterThan(0);
      expect(op.description.length).toBeGreaterThan(0);
    });
    it(`${op.name}: requiredRole (if set) is valid, mutating is boolean|undefined`, () => {
      if (op.requiredRole !== undefined) expect(VALID_ROLES.has(op.requiredRole)).toBe(true);
      expect(['boolean', 'undefined']).toContain(typeof op.mutating);
    });
    it(`${op.name}: a sample call's shape summary leaks no param value`, () => {
      const sentinel = `SENTINEL_${op.name}`;
      const sample = Object.fromEntries(Object.keys(op.params.shape).map((k) => [k, sentinel]));
      const summary = summarizeParams(op, sample);
      expect(JSON.stringify(summary)).not.toContain(sentinel);
    });
  }
});

// CONTEXT.md states the op count as a number, and CONTEXT.md is the file the next session loads
// INSTEAD of re-reading the repo. A count that disagrees with the registry is precisely the drift it
// exists to prevent — and it had already drifted once (it read 12 after get_page made it 13).
describe('CONTEXT.md tracks the registry', () => {
  it('the stated op count equals operations.length', async () => {
    const md = await Bun.file(new URL('../CONTEXT.md', import.meta.url)).text();
    const m = /ops in `operations\.ts`\s*\|\s*\*\*(\d+)\*\*/.exec(md);
    expect(m, 'the op-count row is gone from CONTEXT.md — this scan is vacuous').not.toBeNull();
    expect(Number(m![1]), 'CONTEXT.md disagrees with the registry').toBe(operations.length);
  });
});
