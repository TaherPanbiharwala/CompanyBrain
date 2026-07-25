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

// `nodeEnvExplicit` is not decoration: NODE_ENV parses to 'development' when the variable is
// ABSENT, so it is the only thing separating "a developer chose development" from "nobody set
// anything". Every config below must state it, and the type now forces that.
const dev = { NODE_ENV: 'development', nodeEnvExplicit: true, DEV_AUTH: 1 } as const;
const devOff = { NODE_ENV: 'development', nodeEnvExplicit: true, DEV_AUTH: 0 } as const;
const prodOn = { NODE_ENV: 'production', nodeEnvExplicit: true, DEV_AUTH: 1 } as const;
/** What an absent NODE_ENV actually looks like after parseConfig — the case that used to slip through. */
const unset = { NODE_ENV: 'development', nodeEnvExplicit: false, DEV_AUTH: 1 } as const;

describe('devAuthEnabled — allowlist gate (fail-closed on env)', () => {
  it('on only when NODE_ENV is a dev env AND DEV_AUTH == 1', () => {
    expect(devAuthEnabled(dev)).toBe(true);
    expect(devAuthEnabled({ NODE_ENV: 'test', nodeEnvExplicit: true, DEV_AUTH: 1 })).toBe(true);
    expect(devAuthEnabled(devOff)).toBe(false);
    expect(devAuthEnabled(prodOn)).toBe(false);
  });
  it('fails CLOSED for misspelled / non-dev NODE_ENV even with DEV_AUTH=1', () => {
    for (const NODE_ENV of ['', 'prod', 'Production', 'PRODUCTION', 'staging', 'ci']) {
      expect(devAuthEnabled({ NODE_ENV, nodeEnvExplicit: true, DEV_AUTH: 1 })).toBe(false);
    }
  });
  it('fails CLOSED when NODE_ENV was never set — the case the old test only claimed to cover', () => {
    // The previous version of this suite represented "unset" as NODE_ENV: '' and passed. But '' is
    // not what an absent variable produces: zod's .default('development') does, and 'development'
    // is in the allowlist. So the gate was OPEN for exactly the input its own title named.
    expect(devAuthEnabled(unset)).toBe(false);
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
  it('throws when DEV_AUTH=1 in ANY non-dev env (production, misspelled, staging)', () => {
    for (const NODE_ENV of ['production', '', 'prod', 'Production', 'staging', 'ci']) {
      expect(() => assertDevAuthSafe({ NODE_ENV, nodeEnvExplicit: true, DEV_AUTH: 1 })).toThrow();
    }
  });
  it('THROWS when NODE_ENV was never set — previously it booted and warned', () => {
    // The reachable deployment: DEV_AUTH=1 carried in from a .env, NODE_ENV never exported (the
    // default in a container). Before this fix the process started, printed a console.warn, and
    // every cookie-less request could forge identity through x-cb-* headers.
    expect(() => assertDevAuthSafe(unset)).toThrow(/unset/);
  });
  it('does not throw in a recognized dev env (warns only)', () => {
    expect(() => assertDevAuthSafe(dev)).not.toThrow();
    expect(() => assertDevAuthSafe({ NODE_ENV: 'test', nodeEnvExplicit: true, DEV_AUTH: 1 })).not.toThrow();
  });
  it('does not throw when the flag is off (any env)', () => {
    expect(() => assertDevAuthSafe({ NODE_ENV: 'production', nodeEnvExplicit: true, DEV_AUTH: 0 })).not.toThrow();
    expect(() => assertDevAuthSafe({ NODE_ENV: '', nodeEnvExplicit: true, DEV_AUTH: 0 })).not.toThrow();
  });
});
