import { describe, it, expect } from 'bun:test';
import { bucketBytes, summarizeParams } from '../src/api/redact.ts';
import { operationsByName } from '../src/api/operations.ts';

describe('bucketBytes — 1KB rounding (kills length side-channel)', () => {
  it('rounds up to the nearest 1024', () => {
    expect(bucketBytes(0)).toBe(0);
    expect(bucketBytes(1)).toBe(1024);
    expect(bucketBytes(1024)).toBe(1024);
    expect(bucketBytes(1025)).toBe(2048);
  });
});

describe('summarizeParams — shapes, never values', () => {
  const echo = operationsByName.echo; // params: z.object({ message })

  it('names declared keys, counts unknown keys, emits no value', () => {
    const s = summarizeParams(echo, { message: 'SUPERSECRET', bogus: 42 });
    expect(s?.kind).toBe('object');
    expect(s?.declared_keys).toEqual(['message']);
    expect(s?.unknown_key_count).toBe(1); // 'bogus' counted, never named
    expect(JSON.stringify(s)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(s)).not.toContain('bogus');
    expect(JSON.stringify(s)).not.toContain('42');
  });

  it('with no op, all submitted keys are unknown (count only)', () => {
    const s = summarizeParams(undefined, { a: 1, b: 2 });
    expect(s?.declared_keys).toEqual([]);
    expect(s?.unknown_key_count).toBe(2);
  });

  it('null → kind null; undefined → null summary', () => {
    expect(summarizeParams(echo, null)).toEqual({ kind: 'null' });
    expect(summarizeParams(echo, undefined)).toBeNull();
  });
});
