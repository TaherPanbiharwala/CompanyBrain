// Session tokens + cookies (M2).
//
// Refresh rotation is CUT from M2 (G2): there is no /auth/refresh, no rotation and no reuse
// detection. A session is a single high-entropy token with an ABSOLUTE expiry, plus an epoch stamp
// that lets "sign out everywhere" invalidate every session a principal holds in one UPDATE.
// `sessions.refresh_hash` / `refresh_expires_at` stay NULL, reserved for M5.
//
// Hashing: SHA-256, deliberately. These are 256-bit random tokens, not passwords — there is no
// dictionary to attack, so a slow KDF (bcrypt/argon2) would buy nothing and cost a hash on every
// single request. What matters is that the raw token is never stored, so a database read cannot
// mint a session.
import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { config } from '../config.ts';

/** 32 bytes of CSPRNG entropy, base64url — 43 chars, no padding. The resolver pre-checks that
 *  length before touching the database, which drops junk-flood traffic for free. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export const TOKEN_LENGTH = 43;

/** Shape check only — cheap, allocation-free, and safe to run on unauthenticated input. */
export function looksLikeToken(raw: string): boolean {
  return raw.length === TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(raw);
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// ── Cookie naming + attributes ────────────────────────────────────────────
// ONE predicate (config.appBaseIsHttps) picks BOTH the `__Host-` prefix and the `Secure` attribute.
// They must never disagree: `__Host-` REQUIRES Secure + Path=/ + no Domain, and a browser silently
// DISCARDS a cookie that violates that — an infinite login loop with no error anywhere. Tying them
// together is also what keeps plain-http localhost working for curl and the runbook.

export const SESSION_COOKIE_BASE = 'cb_session';
export const OAUTH_COOKIE_BASE = 'cb_oauth';

function cookieName(base: string): string {
  return config.appBaseIsHttps ? `__Host-${base}` : base;
}

export function sessionCookieName(): string {
  return cookieName(SESSION_COOKIE_BASE);
}

export function oauthCookieName(): string {
  return cookieName(OAUTH_COOKIE_BASE);
}

export interface CookieAttrs {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number; // milliseconds (Express's res.cookie unit)
}

/** SameSite=Lax, never Strict: Google's callback is a top-level cross-site GET, and Strict would
 *  drop the cookie on the way back, breaking login. Lax still blocks cross-site POST to /api/:op. */
export function sessionCookieAttrs(ttlDays = config.SESSION_TTL_DAYS): CookieAttrs {
  return { httpOnly: true, secure: config.appBaseIsHttps, sameSite: 'lax', path: '/', maxAge: ttlDays * 86_400_000 };
}

export function oauthCookieAttrs(ttlSeconds = 600): CookieAttrs {
  return { httpOnly: true, secure: config.appBaseIsHttps, sameSite: 'lax', path: '/', maxAge: ttlSeconds * 1000 };
}

/** dev-login's session lifetime, in days. ONE constant: it feeds both the database row's expiry and
 *  the cookie's Max-Age, which were previously written separately in two different units two lines
 *  apart — change one and the cookie outlives (or predeceases) the row it points at. */
export const DEV_LOGIN_TTL_DAYS = 1 / 24; // one hour

/** Clearing a cookie must use the SAME attributes it was set with, minus Max-Age. Exported so the
 *  resolver and the routes share one implementation — they had drifted into two shapes, one of which
 *  needed an `as never` cast, and a mismatched clear silently leaves a live cookie behind. */
export function clearAuthCookie(
  res: { clearCookie: (name: string, opts: Omit<CookieAttrs, 'maxAge'>) => unknown },
  name: string,
  attrs: CookieAttrs,
): void {
  const { maxAge: _maxAge, ...rest } = attrs;
  res.clearCookie(name, rest);
}

// ── Signed oauth state cookie ─────────────────────────────────────────────
// Carries {code_verifier, state, nonce, return_to} across the redirect to Google. HMAC-signed, not
// encrypted: HttpOnly already keeps it away from page scripts, and possessing it is useless without
// the client secret needed for the code exchange. Signing is what stops a tampered state/nonce.

/** SESSION_SECRET is validated HERE — lazily, on first sign/verify — not at module scope. Every
 *  offline unit test imports src/index.ts, and .env.example ships the secret empty, so a
 *  module-scope check would red the whole suite instead of just the paths that need a secret. */
function secret(): string {
  const s = config.SESSION_SECRET;
  if (s.length < 32) {
    throw new Error(
      'SESSION_SECRET must be at least 32 characters to sign the OAuth state cookie. Generate one with:\n' +
        '  bun -e "console.log(crypto.randomUUID().replace(/-/g,\'\') + crypto.randomUUID().replace(/-/g,\'\'))"',
    );
  }
  return s;
}

export function signPayload(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Returns null on ANY problem — malformed, wrong signature, unparseable. Never throws for
 *  attacker-controlled input, so callers can treat null as "no valid oauth state". */
export function verifyPayload<T>(signed: string): T | null {
  const dot = signed.indexOf('.');
  if (dot <= 0) return null;
  const body = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  // Compare BYTE lengths, not string lengths. timingSafeEqual throws RangeError on a byte-length
  // mismatch, and a 43-character MAC of non-ASCII codepoints (43 'é') has 43 chars but 86 bytes —
  // so a string-length guard let attacker-controlled input reach timingSafeEqual and throw, turning
  // a should-be-401 into a 500 and breaking this function's "never throws" contract.
  const macBuf = Buffer.from(mac, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (macBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(macBuf, expectedBuf)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

// ── Session lifecycle ─────────────────────────────────────────────────────

export interface IssuedSession {
  raw: string; // the value that goes in the cookie; never stored
  sessionId: string;
  expiresAt: Date;
}

export interface IssueSessionInput {
  principalId: string;
  activeWorkspaceId: string | null;
  /** Verified Google `hd` for THIS login. NULL for consumer accounts and ALWAYS null for dev-login,
   *  which is what structurally prevents either from claiming a workspace domain later. */
  loginHd?: string | null;
  ttlDays?: number;
}

/** Runs on the cb_auth pool (login/onboarding lane). The epoch is read INSIDE the insert so there
 *  is no read-then-write race against a concurrent "sign out everywhere". */
export async function issueSession(
  sql: postgres.Sql | postgres.TransactionSql,
  input: IssueSessionInput,
): Promise<IssuedSession> {
  const raw = generateToken();
  const ttlDays = input.ttlDays ?? config.SESSION_TTL_DAYS;
  const rows = await sql<{ id: string; expires_at: Date }[]>`
    insert into sessions (principal_id, active_workspace_id, token_hash, expires_at, epoch, login_hd)
    values (
      ${input.principalId},
      ${input.activeWorkspaceId},
      ${hashToken(raw)},
      -- secs, not days: make_interval(days => …) takes an INTEGER, and dev-login uses a
      -- fractional day (one hour) for its deliberately short-lived session.
      now() + make_interval(secs => ${ttlDays * 86_400}),
      (select session_epoch from principals where id = ${input.principalId}),
      ${input.loginHd ?? null}
    )
    returning id, expires_at`;
  const row = rows[0];
  if (!row) throw new Error('issueSession: insert returned no row');
  return { raw, sessionId: row.id, expiresAt: row.expires_at };
}

/** Logout (this session only). Goes through the definer because narrowGrants leaves cb_app with no
 *  privilege at all on `sessions` — token-keyed, so it can only ever delete the caller's own row. */
export async function revokeSession(sql: postgres.Sql, rawToken: string): Promise<void> {
  await sql`select cb_internal.revoke_session(${hashToken(rawToken)})`;
}

/** Sign out everywhere: bumps principals.session_epoch, invalidating every session whose stamped
 *  epoch no longer matches. Also token-keyed — taking a principal id would hand any cb_app holder a
 *  targeted "log this user out" primitive. */
export async function revokeAllSessions(sql: postgres.Sql, rawToken: string): Promise<void> {
  await sql`select cb_internal.revoke_all_sessions(${hashToken(rawToken)})`;
}
