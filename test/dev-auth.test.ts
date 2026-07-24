// Unit test for the dev-auth security boundary (review AM9) — no DB. Parameterized config lets us
// exercise the prod-gate without touching process.env.
import { describe, it, expect } from 'bun:test';
import type { Request } from 'express';
import { devAuthEnabled, resolveDevContext, assertDevAuthSafe } from '../src/api/dev-auth.ts';
import { ContextError } from '../src/core/context.ts';

const P = crypto.randomUUID();
const W = crypto.randomUUID();

function mockReq(headers: Record<string, string>): Request {
  return { header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}
const goodHeaders = { 'x-cb-principal': P, 'x-cb-workspace': W, 'x-cb-role': 'admin' };

const dev = { NODE_ENV: 'development', DEV_AUTH: 1 } as const;
const devOff = { NODE_ENV: 'development', DEV_AUTH: 0 } as const;
const prodOn = { NODE_ENV: 'production', DEV_AUTH: 1 } as const;

describe('devAuthEnabled — allowlist gate (fail-closed on env)', () => {
  it('on only when NODE_ENV is a dev env AND DEV_AUTH == 1', () => {
    expect(devAuthEnabled(dev)).toBe(true);
    expect(devAuthEnabled({ NODE_ENV: 'test', DEV_AUTH: 1 })).toBe(true);
    expect(devAuthEnabled(devOff)).toBe(false);
    expect(devAuthEnabled(prodOn)).toBe(false);
  });
  it('fails CLOSED for unset / misspelled / non-dev NODE_ENV even with DEV_AUTH=1', () => {
    for (const NODE_ENV of ['', 'prod', 'Production', 'PRODUCTION', 'staging', 'ci']) {
      expect(devAuthEnabled({ NODE_ENV, DEV_AUTH: 1 })).toBe(false);
    }
  });
});

describe('resolveDevContext — fail-closed', () => {
  it('dev + full headers → ctx', () => {
    const ctx = resolveDevContext(mockReq(goodHeaders), dev);
    expect(ctx?.principal).toBe(P);
    expect(ctx?.workspaceId).toBe(W);
    expect(ctx?.role).toBe('admin');
  });
  it('production → null (even with headers + flag)', () => {
    expect(resolveDevContext(mockReq(goodHeaders), prodOn)).toBeNull();
  });
  it('flag off → null', () => {
    expect(resolveDevContext(mockReq(goodHeaders), devOff)).toBeNull();
  });
  it('missing workspace header → null', () => {
    expect(resolveDevContext(mockReq({ 'x-cb-principal': P }), dev)).toBeNull();
  });
  it('malformed principal → ContextError(bad_principal)', () => {
    let code: string | undefined;
    try {
      resolveDevContext(mockReq({ 'x-cb-principal': 'not-a-uuid', 'x-cb-workspace': W }), dev);
    } catch (e) {
      code = (e as ContextError).code;
    }
    expect(code).toBe('bad_principal');
  });
});

describe('assertDevAuthSafe — boot guard', () => {
  it('throws when DEV_AUTH=1 in ANY non-dev env (production, unset, misspelled, staging)', () => {
    for (const NODE_ENV of ['production', '', 'prod', 'Production', 'staging', 'ci']) {
      expect(() => assertDevAuthSafe({ NODE_ENV, DEV_AUTH: 1 })).toThrow();
    }
  });
  it('does not throw in a recognized dev env (warns only)', () => {
    expect(() => assertDevAuthSafe(dev)).not.toThrow();
    expect(() => assertDevAuthSafe({ NODE_ENV: 'test', DEV_AUTH: 1 })).not.toThrow();
  });
  it('does not throw when the flag is off (any env)', () => {
    expect(() => assertDevAuthSafe({ NODE_ENV: 'production', DEV_AUTH: 0 })).not.toThrow();
    expect(() => assertDevAuthSafe({ NODE_ENV: '', DEV_AUTH: 0 })).not.toThrow();
  });
});
