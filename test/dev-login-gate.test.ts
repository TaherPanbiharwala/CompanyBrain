// POST /auth/dev-login mints a REAL session for any email with no identity verification, so it is
// an authentication bypass by construction. These tests pin all five gates.
//
// Gate 2 (DEV_LOGIN=0) is the normal "off" state and simply leaves the route unmounted. Every OTHER
// gate failing while DEV_LOGIN=1 means someone enabled it somewhere it must never run — that is a
// BOOT failure, not a 404, because a process that reached "listening" in that state is dangerous.
//
// Config is passed in explicitly (the devAuthEnabled(cfg = config) pattern) rather than mutating
// process.env, which would need Bun's module cache busted per combination.
//
// The `env` second argument these once took is gone: gates 3+4 are now isDevEnv(cfg), so
// `nodeEnvExplicit` on the config carries what process.env used to be consulted for. That
// consolidation is the point — the same question had three implementations and two were wrong.
import { describe, it, expect } from 'bun:test';
import { devLoginEnabled, assertDevLoginSafe } from '../src/api/dev-auth.ts';

type Cfg = Parameters<typeof devLoginEnabled>[0];

/** All five gates satisfied. */
const OK: Cfg = {
  NODE_ENV: 'development',
  nodeEnvExplicit: true,
  DEV_AUTH: 1,
  DEV_LOGIN: 1,
  appBaseIsLoopback: true,
  appBaseUrlExplicit: true,
};

describe('devLoginEnabled — all five gates must pass', () => {
  it('enabled only when everything lines up', () => {
    expect(devLoginEnabled(OK)).toBe(true);
    expect(devLoginEnabled({ ...OK, NODE_ENV: 'test' })).toBe(true);
  });

  it('gate 1: DEV_AUTH must also be 1', () => {
    expect(devLoginEnabled({ ...OK, DEV_AUTH: 0 })).toBe(false);
  });
  it('gate 2: its own dedicated flag', () => {
    expect(devLoginEnabled({ ...OK, DEV_LOGIN: 0 })).toBe(false);
  });
  it('gate 3: NODE_ENV must be EXPLICIT, not the parsed default', () => {
    // config.NODE_ENV defaults to 'development', so without this gate an unconfigured box passes.
    // NOTE the shape: NODE_ENV still READS 'development' — that is exactly the trap. Only
    // nodeEnvExplicit distinguishes "somebody said development" from "nobody said anything".
    expect(devLoginEnabled({ ...OK, nodeEnvExplicit: false })).toBe(false);
  });
  it('gate 4: NODE_ENV must be in the dev allowlist', () => {
    for (const NODE_ENV of ['production', 'staging', 'prod', 'ci', '']) {
      expect(devLoginEnabled({ ...OK, NODE_ENV, nodeEnvExplicit: NODE_ENV !== '' })).toBe(false);
    }
  });
  it('gate 5a: APP_BASE_URL must be EXPLICIT (its default is loopback, so it would pass silently)', () => {
    expect(devLoginEnabled({ ...OK, appBaseUrlExplicit: false })).toBe(false);
  });
  it('gate 5b: …and must actually be loopback', () => {
    expect(devLoginEnabled({ ...OK, appBaseIsLoopback: false })).toBe(false);
  });
});

describe('assertDevLoginSafe — boot guard', () => {
  it('is a no-op when the feature is simply off', () => {
    expect(() => assertDevLoginSafe({ ...OK, DEV_LOGIN: 0 })).not.toThrow();
    // …even somewhere it would be catastrophic, because nothing is enabled.
    expect(() => assertDevLoginSafe({ ...OK, DEV_LOGIN: 0, NODE_ENV: 'production' })).not.toThrow();
  });

  it('does not throw when all five gates pass (warns instead)', () => {
    expect(() => assertDevLoginSafe(OK)).not.toThrow();
  });

  it('REFUSES TO BOOT when DEV_LOGIN=1 in production', () => {
    expect(() => assertDevLoginSafe({ ...OK, NODE_ENV: 'production' })).toThrow(/DEV_LOGIN/);
  });
  it('REFUSES TO BOOT when DEV_LOGIN=1 but NODE_ENV was never set', () => {
    expect(() => assertDevLoginSafe({ ...OK, nodeEnvExplicit: false })).toThrow(/EXPLICITLY/);
  });
  it('REFUSES TO BOOT when DEV_LOGIN=1 without DEV_AUTH', () => {
    expect(() => assertDevLoginSafe({ ...OK, DEV_AUTH: 0 })).toThrow(/DEV_AUTH/);
  });
  it('REFUSES TO BOOT when APP_BASE_URL is not explicitly set', () => {
    expect(() => assertDevLoginSafe({ ...OK, appBaseUrlExplicit: false })).toThrow(/APP_BASE_URL/);
  });
  it('REFUSES TO BOOT when APP_BASE_URL is a real (non-loopback) host', () => {
    expect(() => assertDevLoginSafe({ ...OK, appBaseIsLoopback: false })).toThrow(/loopback/);
  });
  it('the message names every failing gate, not just the first', () => {
    let msg = '';
    try {
      assertDevLoginSafe({ ...OK, DEV_AUTH: 0, NODE_ENV: 'production', appBaseIsLoopback: false });
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/DEV_AUTH/);
    expect(msg).toMatch(/NODE_ENV/);
    expect(msg).toMatch(/APP_BASE_URL/);
  });
});
