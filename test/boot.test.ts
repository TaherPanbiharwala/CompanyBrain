// Deployment-shape gates. NEW FILE — `assertDeploymentSafe` had one caller (src/index.ts) and zero
// tests on either branch, which is how gate (3) came to be skipped entirely by an unset NODE_ENV
// while its own comment claimed to cover that case.
//
// Gate (3) is the MORE severe half of the isDevEnv defect, not the lesser one. The dev-auth stub at
// least requires DEV_AUTH=1 to be set on purpose; this needs nothing. An unset NODE_ENV made the
// whole block unreachable, so the app booted with SESSION_SECRET='', DATABASE_AUTH_URL='' and both
// Google credentials empty, /health reported ok, and the first real login 500'd — some of them only
// after the user had already authenticated at Google.
//
// No database, no network. Every case is a plain config literal.
import { describe, it, expect } from 'bun:test';
import { assertDeploymentSafe } from '../src/boot.ts';

/** A deployed shape that passes gates (1) and (2), so each test below isolates gate (3). */
const deployed = {
  TRUST_PROXY: 'loopback',
  APP_BASE_URL: 'https://brain.example.com',
  appBaseIsLoopback: false,
  appBaseIsHttps: true,
  SESSION_SECRET: 'x'.repeat(32),
  DATABASE_AUTH_URL: 'postgres://cb_auth@host/db',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
} as const;

const prod = { ...deployed, NODE_ENV: 'production', nodeEnvExplicit: true } as const;
/** The bug: NODE_ENV absent. zod's `.default('development')` supplies the string, so the VALUE is
 *  indistinguishable from a real dev box — only `nodeEnvExplicit` can tell them apart. */
const unset = { ...deployed, NODE_ENV: 'development', nodeEnvExplicit: false } as const;
const dev = { ...deployed, NODE_ENV: 'development', nodeEnvExplicit: true } as const;

describe('assertDeploymentSafe — loopback exemption', () => {
  it('a loopback dev box is exempt from every gate, however unconfigured', () => {
    expect(() =>
      assertDeploymentSafe({
        NODE_ENV: 'development',
        nodeEnvExplicit: true,
        TRUST_PROXY: '',
        APP_BASE_URL: 'http://localhost:3000',
        appBaseIsLoopback: true,
        appBaseIsHttps: false,
        SESSION_SECRET: '',
        DATABASE_AUTH_URL: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
      }),
    ).not.toThrow();
  });
});

describe('assertDeploymentSafe — network shape (gates 1 and 2)', () => {
  it('refuses a non-loopback deployment with TRUST_PROXY unset', () => {
    expect(() => assertDeploymentSafe({ ...prod, TRUST_PROXY: '' })).toThrow(/TRUST_PROXY/);
  });

  it('refuses plain http off loopback', () => {
    expect(() =>
      assertDeploymentSafe({ ...prod, appBaseIsHttps: false, APP_BASE_URL: 'http://brain.example.com' }),
    ).toThrow(/Secure attribute and the __Host- prefix/);
  });
});

describe('assertDeploymentSafe — required secrets (gate 3)', () => {
  it('passes when a production deployment is fully configured', () => {
    expect(() => assertDeploymentSafe(prod)).not.toThrow();
  });

  it('names every missing secret at once, not just the first', () => {
    const err = (() => {
      try {
        assertDeploymentSafe({ ...prod, SESSION_SECRET: '', DATABASE_AUTH_URL: '', GOOGLE_CLIENT_ID: '' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(Error);
    // One boot, one complete list — otherwise the operator fixes one variable per restart.
    expect(err!.message).toMatch(/SESSION_SECRET/);
    expect(err!.message).toMatch(/DATABASE_AUTH_URL/);
    expect(err!.message).toMatch(/GOOGLE_CLIENT_ID/);
  });

  it('rejects a SESSION_SECRET that is present but too short', () => {
    expect(() => assertDeploymentSafe({ ...prod, SESSION_SECRET: 'short' })).toThrow(/>= 32 chars/);
  });

  it('THE REGRESSION: an UNSET NODE_ENV does not exempt a deployment from gate 3', () => {
    // This is the whole reason the file exists. Before isDevEnv, `DEV_ENVS.has(cfg.NODE_ENV)` saw
    // the string 'development' that zod's default supplies and skipped the block — so this exact
    // config booted clean with no secrets at all.
    expect(() => assertDeploymentSafe({ ...unset, SESSION_SECRET: '', DATABASE_AUTH_URL: '' })).toThrow(
      /sign-in flow is not fully configured/,
    );
  });

  it('says "unset" rather than reporting a NODE_ENV nobody set', () => {
    // Reporting `NODE_ENV=development` would send the operator looking for where they set it.
    expect(() => assertDeploymentSafe({ ...unset, SESSION_SECRET: '' })).toThrow(/\(unset — it defaults to "development"\)/);
  });

  it('an EXPLICIT development NODE_ENV is still exempt — the gate keys on explicitness, not the value', () => {
    // `dev` and `unset` carry the identical NODE_ENV string and differ only in nodeEnvExplicit.
    // That difference is the entire control; if this pair ever agrees, the fix has been undone.
    expect(dev.NODE_ENV).toBe(unset.NODE_ENV);
    expect(() => assertDeploymentSafe({ ...dev, SESSION_SECRET: '', DATABASE_AUTH_URL: '' })).not.toThrow();
  });
});
