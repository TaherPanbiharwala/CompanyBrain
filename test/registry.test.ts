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
