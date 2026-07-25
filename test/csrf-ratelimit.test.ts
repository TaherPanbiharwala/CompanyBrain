import { describe, it, expect } from 'bun:test';
import type { Request } from 'express';
import { checkCsrf } from '../src/auth/csrf.ts';
import { FixedWindowLimiter } from '../src/auth/ratelimit.ts';
import { config } from '../src/config.ts';

/** Minimal Request stand-in: checkCsrf only reads method + two headers. */
function req(method: string, headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, header: (n: string) => lower[n.toLowerCase()] } as unknown as Request;
}

describe('checkCsrf', () => {
  it('never blocks safe methods', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      expect(checkCsrf(req(m, { 'sec-fetch-site': 'cross-site' })).ok).toBe(true);
    }
  });

  it('allows same-origin and direct navigation', () => {
    expect(checkCsrf(req('POST', { 'sec-fetch-site': 'same-origin' })).ok).toBe(true);
    expect(checkCsrf(req('POST', { 'sec-fetch-site': 'none' })).ok).toBe(true);
  });

  it('BLOCKS a cross-site mutating request — the actual CSRF case', () => {
    const v = checkCsrf(req('POST', { 'sec-fetch-site': 'cross-site' }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/cross-site/);
    expect(checkCsrf(req('POST', { 'sec-fetch-site': 'same-site' })).ok).toBe(false);
  });

  it('falls back to Origin when Sec-Fetch-Site is absent (older browsers)', () => {
    const origin = new URL(config.APP_BASE_URL).origin;
    expect(checkCsrf(req('POST', { origin })).ok).toBe(true);
    expect(checkCsrf(req('POST', { origin: 'https://evil.com' })).ok).toBe(false);
  });

  it('allows non-browser clients (neither header) — curl and the runbook must keep working', () => {
    // A browser always sends at least one of these on a cross-origin POST, so "neither" means a
    // client that cannot be CSRF'd in the first place.
    expect(checkCsrf(req('POST')).ok).toBe(true);
  });

  it('Sec-Fetch-Site wins over a spoofable Origin', () => {
    const origin = new URL(config.APP_BASE_URL).origin;
    expect(checkCsrf(req('POST', { 'sec-fetch-site': 'cross-site', origin })).ok).toBe(false);
  });
});

describe('FixedWindowLimiter', () => {
  it('allows up to max, then blocks', () => {
    const l = new FixedWindowLimiter({ windowMs: 1000, max: 3 });
    expect(l.hit('a', 0)).toBe(false);
    expect(l.hit('a', 0)).toBe(false);
    expect(l.hit('a', 0)).toBe(false);
    expect(l.hit('a', 0)).toBe(true); // 4th
  });

  it('keys are independent', () => {
    const l = new FixedWindowLimiter({ windowMs: 1000, max: 1 });
    expect(l.hit('a', 0)).toBe(false);
    expect(l.hit('b', 0)).toBe(false);
    expect(l.hit('a', 0)).toBe(true);
  });

  it('resets after the window', () => {
    const l = new FixedWindowLimiter({ windowMs: 1000, max: 1 });
    expect(l.hit('a', 0)).toBe(false);
    expect(l.hit('a', 500)).toBe(true);
    expect(l.hit('a', 1001)).toBe(false);
  });

  it('reports a retry-after inside the window', () => {
    const l = new FixedWindowLimiter({ windowMs: 10_000, max: 1 });
    l.hit('a', 0);
    expect(l.retryAfterSeconds('a', 0)).toBe(10);
    expect(l.retryAfterSeconds('a', 9_000)).toBe(1);
    expect(l.retryAfterSeconds('unknown', 0)).toBe(0);
  });

  it('sweeps expired buckets so unique keys cannot grow memory without bound', () => {
    const l = new FixedWindowLimiter({ windowMs: 100, max: 5 });
    for (let i = 0; i < 500; i++) l.hit(`ip-${i}`, 0);
    l.hit('trigger', 100_000); // a hit past the window triggers the amortized sweep
    // Old buckets are gone: a previously-seen key starts a fresh window rather than being blocked.
    expect(l.hit('ip-0', 100_000)).toBe(false);
  });
});
