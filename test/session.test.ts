// Token generation, hashing, and the signed OAuth state cookie. No DB — issueSession/revoke* are
// covered by the live tests.
import { describe, it, expect } from 'bun:test';
import {
  generateToken, hashToken, looksLikeToken, TOKEN_LENGTH,
  signPayload, verifyPayload, sessionCookieName, oauthCookieName, sessionCookieAttrs,
} from '../src/auth/session.ts';
import { config } from '../src/config.ts';

describe('token generation + hashing', () => {
  it('mints 43-char base64url tokens (32 bytes of entropy)', () => {
    for (let i = 0; i < 20; i++) {
      const t = generateToken();
      expect(t).toHaveLength(TOKEN_LENGTH);
      expect(looksLikeToken(t)).toBe(true);
    }
  });
  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(seen.size).toBe(200);
  });
  it('hashes deterministically, and the hash is never the token', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects shapes that are not tokens (the pre-DB cheap filter)', () => {
    for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '+', 'a'.repeat(42) + '/']) {
      expect(looksLikeToken(bad)).toBe(false);
    }
  });
});

describe('signed oauth state cookie', () => {
  const payload = { state: 'abc', nonce: 'def', codeVerifier: 'ghi', returnTo: '/x' };

  it('round-trips a payload', () => {
    expect(verifyPayload<typeof payload>(signPayload(payload))).toEqual(payload);
  });
  it('rejects a tampered body', () => {
    const signed = signPayload(payload);
    const [body, mac] = signed.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...payload, state: 'evil' }), 'utf8').toString('base64url');
    expect(verifyPayload(`${tampered}.${mac}`)).toBeNull();
    expect(body).toBeTruthy();
  });
  it('rejects a tampered signature, and garbage, without throwing', () => {
    const signed = signPayload(payload);
    expect(verifyPayload(signed.slice(0, -1) + 'X')).toBeNull();
    for (const bad of ['', '.', 'nodot', 'a.b', '..']) expect(verifyPayload(bad)).toBeNull();
  });

  it('returns null — never throws — for a MAC whose CHARACTER length matches but byte length does not', () => {
    // The regression this pins: the guard compared string lengths while timingSafeEqual compares
    // byte lengths, so a MAC of 43 non-ASCII codepoints (43 chars, 86 bytes) sailed past the guard
    // and made timingSafeEqual throw RangeError. That escaped into the OAuth callback and turned a
    // should-be-401 into a 500 — from a value entirely under an attacker's control.
    const body = signPayload(payload).split('.')[0]!;
    const realMacLength = signPayload(payload).split('.')[1]!.length;

    // BMP characters only: an astral-plane char like '𝒜' is TWO UTF-16 units, so .repeat(n) would
    // not produce a string of character-length n and the premise of the test would not hold.
    for (const ch of ['é', 'ü', '☃']) {
      const wideMac = ch.repeat(realMacLength); // same char count, more bytes
      expect(wideMac.length).toBe(realMacLength);
      expect(Buffer.from(wideMac, 'utf8').length).toBeGreaterThan(realMacLength);
      expect(() => verifyPayload(`${body}.${wideMac}`)).not.toThrow();
      expect(verifyPayload(`${body}.${wideMac}`)).toBeNull();
    }
  });
});

describe('cookie naming + attributes', () => {
  it('name and Secure derive from ONE predicate so they cannot disagree', () => {
    // __Host- REQUIRES Secure; a mismatch makes the browser silently drop the cookie.
    const https = config.appBaseIsHttps;
    expect(sessionCookieName()).toBe(https ? '__Host-cb_session' : 'cb_session');
    expect(oauthCookieName()).toBe(https ? '__Host-cb_oauth' : 'cb_oauth');
    expect(sessionCookieAttrs().secure).toBe(https);
  });
  it('always HttpOnly, SameSite=Lax, Path=/ and never scoped to a Domain', () => {
    const a = sessionCookieAttrs();
    expect(a.httpOnly).toBe(true);
    expect(a.path).toBe('/');
    // Lax (not Strict): Google's callback is a top-level cross-site GET and Strict would drop it.
    expect(a.sameSite).toBe('lax');
    expect(a).not.toHaveProperty('domain');
  });
  it('honours SESSION_TTL_DAYS', () => {
    expect(sessionCookieAttrs(7).maxAge).toBe(7 * 86_400_000);
    expect(sessionCookieAttrs(1).maxAge).toBe(86_400_000);
  });
});
