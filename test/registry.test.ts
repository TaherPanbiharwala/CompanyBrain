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

// Offline, no DB: these are pure zod-schema properties, and the whole point of catching them here is
// that they never needed a database to catch. An adversarial review found both bugs live in the
// SHIPPED schema — this pins the fix so it cannot silently regress back to either shape.
describe('ingest / ingest_file — metadata size cap and author normalization (migration 0014)', () => {
  const ingest = operations.find((op) => op.name === 'ingest')!;
  const ingestFile = operations.find((op) => op.name === 'ingest_file')!;

  it('rejects a CJK-heavy metadata payload whose UTF-8 byte size exceeds 10KB even though .length does not', () => {
    // '日'.repeat(4900): .length 4900 — comfortably under the OLD (wrong) 10_000-code-unit check —
    // but ~14,700 UTF-8 bytes, ~47% over the column's actual 10KB bound. This is the exact bypass an
    // adversarial review found and reproduced by execution.
    const oversized = { note: '日'.repeat(4900) };
    expect(JSON.stringify(oversized).length, 'fixture no longer demonstrates the code-unit/byte gap').toBeLessThan(10_000);
    const result = ingest.params.safeParse({ slug: 'x', title: 'x', body: 'x', metadata: oversized });
    expect(result.success, 'an over-byte-limit payload parsed as valid').toBe(false);
  });

  it('accepts metadata comfortably under 10KB in both units, on both ingest ops', () => {
    const small = { source: 'test', author: 'Jane Doe' };
    expect(ingest.params.safeParse({ slug: 'x', title: 'x', body: 'x', metadata: small }).success).toBe(true);
    expect(
      ingestFile.params.safeParse({ filename: 'x.txt', slug: 'x', content_base64: 'eA==', metadata: small }).success,
    ).toBe(true);
  });

  it('trims a padded author and rejects a whitespace-only one, on every op that accepts it', () => {
    for (const op of [ingest, ingestFile]) {
      const withPadding = op === ingest
        ? { slug: 'x', title: 'x', body: 'x', author: '  Jane Doe  ' }
        : { filename: 'x.txt', slug: 'x', content_base64: 'eA==', author: '  Jane Doe  ' };
      const parsed = op.params.safeParse(withPadding);
      expect(parsed.success, `${op.name}: a padded author was rejected`).toBe(true);
      if (parsed.success) expect(parsed.data.author, `${op.name}: author was not trimmed`).toBe('Jane Doe');

      const whitespaceOnly = op === ingest
        ? { slug: 'x', title: 'x', body: 'x', author: '   ' }
        : { filename: 'x.txt', slug: 'x', content_base64: 'eA==', author: '   ' };
      expect(op.params.safeParse(whitespaceOnly).success, `${op.name}: a whitespace-only author was accepted`).toBe(false);
    }
  });
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
