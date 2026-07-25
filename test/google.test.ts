// The Google callback path, driven against a real in-process issuer (see helpers/fake-issuer.ts) so
// openid-client's own signature/iss/aud/exp/nonce validation actually runs.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { completeAuth, safeReturnTo, setOidcConfigForTests } from '../src/auth/google.ts';
import * as jose from 'jose';
import { createFakeIssuer, callbackUrl, FAKE_ISSUER, FAKE_CLIENT_ID, type FakeIssuer } from './helpers/fake-issuer.ts';

const STATE = 'test-state-value';
const NONCE = 'test-nonce-value';
const CHECKS = { codeVerifier: 'test-code-verifier-01234567890123456789012345', state: STATE, nonce: NONCE };

let issuer: FakeIssuer;

beforeAll(async () => {
  issuer = await createFakeIssuer();
  setOidcConfigForTests(issuer.config);
});
afterAll(() => setOidcConfigForTests(null));

/** Mint a token with `overrides` applied, queue it, and run the real exchange. */
async function attempt(overrides: Record<string, unknown> = {}, state = STATE, nonce = NONCE) {
  issuer.setNextIdToken(await issuer.mintIdToken({ nonce, ...overrides }));
  return completeAuth(callbackUrl(state), { ...CHECKS, nonce });
}

describe('completeAuth — accepts a well-formed identity', () => {
  it('returns sub/email/name from a valid signed token', async () => {
    const id = await attempt();
    expect(id.sub).toBe('1234567890');
    expect(id.email).toBe('user@example.com');
    expect(id.emailVerified).toBe(true);
    expect(id.name).toBe('Test User');
    expect(id.hd).toBeUndefined(); // consumer account
  });

  it('surfaces a Workspace hd claim, lowercased', async () => {
    const id = await attempt({ hd: 'BigCo.com', email: 'user@bigco.com' });
    expect(id.hd).toBe('bigco.com');
  });
});

describe('completeAuth — the email_verified trust gate (RT-1)', () => {
  // The original gate was `x === true || 'true'`, which parses as `(x === true) || 'true'` — the
  // string literal is always truthy, so EVERY login passed. These are the cases that would have
  // slipped through, and each must now reject.
  it('rejects email_verified: false', async () => {
    await expect(attempt({ email_verified: false })).rejects.toThrow(/unverified/i);
  });
  it('rejects a token with no email_verified claim at all', async () => {
    await expect(attempt({ email_verified: undefined })).rejects.toThrow(/unverified/i);
  });
  it("rejects the STRING 'true' (Google sends a JSON boolean; accepting the string only widens the set)", async () => {
    await expect(attempt({ email_verified: 'true' })).rejects.toThrow(/unverified/i);
  });
  it("rejects the string 'false'", async () => {
    await expect(attempt({ email_verified: 'false' })).rejects.toThrow(/unverified/i);
  });
  it('accepts ONLY boolean true', async () => {
    await expect((await attempt({ email_verified: true })).emailVerified).toBe(true);
  });
});

describe('completeAuth — library-enforced validation', () => {
  it('rejects a mismatched nonce (replayed id_token)', async () => {
    issuer.setNextIdToken(await issuer.mintIdToken({ nonce: 'a-different-nonce' }));
    await expect(completeAuth(callbackUrl(STATE), CHECKS)).rejects.toThrow();
  });
  it('rejects a mismatched state (CSRF on the callback)', async () => {
    issuer.setNextIdToken(await issuer.mintIdToken({ nonce: NONCE }));
    await expect(completeAuth(callbackUrl('attacker-supplied-state'), CHECKS)).rejects.toThrow();
  });
  it('rejects a wrong audience (token minted for another client)', async () => {
    await expect(attempt({ aud: 'some-other-client-id' })).rejects.toThrow();
  });
  it('rejects a wrong issuer', async () => {
    await expect(attempt({ iss: 'https://evil-issuer.test' })).rejects.toThrow();
  });
  it('rejects an expired token (beyond the 60s clock tolerance)', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(attempt({ iat: past, exp: past + 300 })).rejects.toThrow();
  });
  it('rejects a token with no sub', async () => {
    await expect(attempt({ sub: undefined })).rejects.toThrow();
  });
});

describe('safeReturnTo — open redirect (RT-2)', () => {
  it('allows same-origin relative paths', () => {
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/dashboard')).toBe('/dashboard');
    expect(safeReturnTo('/a/b?c=d')).toBe('/a/b?c=d');
  });
  it('rejects every off-site shape', () => {
    // `startsWith("/")` would pass the first two — browsers resolve both as absolute off-site URLs.
    for (const bad of [
      '//evil.com', '/\\evil.com', '/%2f%2fevil.com', 'https://evil.com', '//evil.com/path',
      'javascript:alert(1)', '\\\\evil.com', '/\tevil', 'http://evil.com',
    ]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
  it('rejects CRLF (response-splitting into the Location header)', () => {
    expect(safeReturnTo('/x%0d%0aSet-Cookie:%20a=b')).toBe('/');
    expect(safeReturnTo('/x\r\nSet-Cookie: a=b')).toBe('/');
  });
  it('defaults to / for empty or malformed input', () => {
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo('')).toBe('/');
    expect(safeReturnTo('%')).toBe('/'); // malformed percent-encoding
  });
});

// ── What actually establishes trust in the id_token ───────────────────────
// A reviewer's first question about any OIDC client is "where is the signature checked?", and for
// this library the answer is surprising enough to pin down in a test rather than leave to be
// rediscovered: it is NOT checked, by design.
//
// openid-client delegates to oauth4webapi, whose own docs say the ID Token signature is validated
// only "optionally", via an explicitly-called validateApplicationLevelSignature(). On the
// authorization-code grant it is skipped, which OIDC Core §3.1.3.7 permits: the token arrives over a
// direct, TLS-authenticated back-channel request from OUR server to the token endpoint, so TLS
// server authentication substitutes for the JWT signature.
//
// What that means in practice:
//   * In production the trust anchor is TLS to accounts.google.com plus the client secret and PKCE
//     verifier required to redeem the code — NOT the RS256 signature.
//   * iss / aud / exp / nonce ARE validated (the tests above cover those), as is our own
//     email_verified gate.
//   * A test that injects customFetch, as this harness does, bypasses the trust anchor entirely.
//     That is fine for exercising claim validation; it means signature forgery is not testable here
//     and, more importantly, not the property being relied on.
describe('id_token trust model', () => {
  it('accepts a token this harness signed with a DIFFERENT key — signature is not the control', async () => {
    // Documents the real behaviour so nobody "fixes" a passing test into a failing one. If a future
    // library upgrade starts enforcing signatures, this flips and the comment above needs revisiting.
    const attacker = await jose.generateKeyPair('RS256', { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const foreign = await new jose.SignJWT({
      iss: FAKE_ISSUER, aud: FAKE_CLIENT_ID, sub: 'foreign-key-subject',
      email: 'user@example.com', email_verified: true, nonce: NONCE, iat: now, exp: now + 300,
    }).setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' }).sign(attacker.privateKey);

    issuer.setNextIdToken(foreign);
    const id = await completeAuth(callbackUrl(STATE), CHECKS);
    expect(id.sub).toBe('foreign-key-subject');
  });

  it('but the CLAIMS are still enforced on that same path — iss, aud and nonce all reject', async () => {
    const attacker = await jose.generateKeyPair('RS256', { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const mint = (over: Record<string, unknown>) =>
      new jose.SignJWT({
        iss: FAKE_ISSUER, aud: FAKE_CLIENT_ID, sub: 's', email: 'u@example.com',
        email_verified: true, nonce: NONCE, iat: now, exp: now + 300, ...over,
      }).setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' }).sign(attacker.privateKey);

    for (const bad of [{ iss: 'https://evil.test' }, { aud: 'someone-else' }, { nonce: 'wrong-nonce' }, { exp: now - 60 }]) {
      issuer.setNextIdToken(await mint(bad));
      await expect(completeAuth(callbackUrl(STATE), CHECKS)).rejects.toThrow();
    }
  });
});
