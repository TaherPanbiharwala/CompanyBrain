// Google OIDC relying party (openid-client v6).
//
// The library does the validation: issuer, audience, expiry, and the nonce/state/PKCE bindings.
// Every failure throws, and every throw here means "authentication failed" — never fall through to a
// partial identity.
//
// WHERE THE TRUST ACTUALLY COMES FROM (verified against oauth4webapi's source, not assumed — an
// earlier version of this comment claimed "signature against Google's JWKS", which is NOT what
// happens):
//
//   openid-client delegates to oauth4webapi, which validates the id_token SIGNATURE only when you
//   explicitly call validateApplicationLevelSignature(). On the authorization-code grant it does
//   not, and OIDC Core §3.1.3.7 permits exactly that: the id_token arrives over a direct,
//   TLS-authenticated back-channel POST from this server to Google's token endpoint, so TLS server
//   authentication substitutes for the JWT signature.
//
//   So the trust anchor is: TLS to accounts.google.com + the client secret and PKCE verifier needed
//   to redeem the code. NOT the RS256 signature. Claims (iss/aud/exp/nonce) are still checked, and
//   test/google.test.ts pins this behaviour so a future library upgrade that starts enforcing
//   signatures is noticed rather than silently assumed.
//
//   Practical consequence: anything that replaces the fetch implementation (the test harness does,
//   via customFetch) bypasses the anchor completely. Never point customFetch at anything but the
//   real network outside tests.
//
// What is OURS to decide, and therefore lives in this file:
//   * email_verified must be the BOOLEAN true. Google sends a JSON boolean; accepting the string
//     'true' only widens the accept set. (The original design read `x === true || 'true'`, which is
//     `(x === true) || 'true'` — a non-empty string literal, so it was ALWAYS truthy and every login
//     passed the gate regardless of verification.)
//   * identity is keyed on `sub`, never on email — emails get reassigned, subs do not.
//   * the org domain comes from the signed `hd` claim ONLY, never from the email's domain part.
//     Google sets `hd` only for Workspace accounts, so a consumer account can own a mailbox at any
//     custom domain; deriving the domain from the email would let it squat that domain's auto-join.
import * as client from 'openid-client';
import { config } from '../config.ts';

const GOOGLE_ISSUER = 'https://accounts.google.com';
/** Containers drift. 60s of leeway on iat/exp turns "every login fails mysteriously" into a non-event. */
const CLOCK_TOLERANCE_SECONDS = 60;

export interface VerifiedIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Google Workspace hosted domain. undefined for consumer accounts — and that is load-bearing. */
  hd?: string;
  name?: string;
}

export interface AuthStart {
  redirectUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

let _config: Promise<client.Configuration> | null = null;

/** Tests inject a pre-built Configuration instead of reaching the network: `discovery()` is a live
 *  fetch, and driving the real validation path against a fake issuer is worth far more than stubbing
 *  completeAuth out entirely. Pass null to reset. */
export function setOidcConfigForTests(cfg: client.Configuration | null): void {
  _config = cfg ? Promise.resolve(cfg) : null;
}

export async function getOidcConfig(): Promise<client.Configuration> {
  // An injected (test) configuration short-circuits BEFORE the credential guard — otherwise the
  // fake-issuer harness could never run without real Google credentials in the environment.
  if (_config) return _config;
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. Create a Web-application OAuth client ' +
        '(see docs/auth-setup.md), or use POST /auth/dev-login for local development.',
    );
  }
  _config = discoverGoogle().catch((err) => {
    _config = null; // a transient discovery failure must not poison the process
    throw err;
  });
  return _config;
}

async function discoverGoogle(): Promise<client.Configuration> {
  // clockTolerance is a client-metadata symbol, not a property of the returned Configuration.
  return client.discovery(new URL(GOOGLE_ISSUER), config.GOOGLE_CLIENT_ID, {
    client_secret: config.GOOGLE_CLIENT_SECRET,
    [client.clockTolerance]: CLOCK_TOLERANCE_SECONDS,
  });
}

/** Only a same-origin, single-leading-slash relative path survives. `startsWith('/')` is NOT enough:
 *  `//evil.com` and `/\evil.com` are both resolved by browsers as off-site absolute URLs, which
 *  turns the post-login redirect into an open redirect (phishing, plus Referer leakage). Anything
 *  suspicious becomes '/'. */
export function safeReturnTo(raw: string | undefined | null): string {
  if (!raw) return '/';
  let candidate = raw;
  try {
    candidate = decodeURIComponent(raw);
  } catch {
    return '/'; // malformed percent-encoding
  }
  // Any control character (not just CR/LF) is rejected: this value goes into a Location header, and
  // tabs/NULs are treated inconsistently enough by proxies to be worth refusing outright.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(candidate)) return '/';
  // Validate and return the SAME string: validating the decoded form while redirecting to the raw
  // one would reopen the hole via double-encoding.
  if (!/^\/(?!\/)[^\\]*$/.test(candidate)) return '/';
  return candidate;
}

/** Builds the redirect plus the three one-time values the callback must match. The caller is
 *  responsible for persisting them (signed, short-lived) — see routes.ts. */
export async function startAuth(): Promise<AuthStart> {
  const cfg = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: config.OIDC_REDIRECT_URI,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  return { redirectUrl: url.href, state, nonce, codeVerifier };
}

export interface CompleteAuthChecks {
  codeVerifier: string;
  state: string;
  nonce: string;
}

/** Exchange the code and return an identity we are willing to act on. Throws on ANY validation
 *  failure — the caller treats every throw as an authentication failure. */
export async function completeAuth(currentUrl: URL, checks: CompleteAuthChecks): Promise<VerifiedIdentity> {
  const cfg = await getOidcConfig();
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: checks.codeVerifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  if (!claims) throw new Error('google returned no id_token claims');

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email : '';
  if (!sub) throw new Error('id_token has no sub claim');
  if (!email) throw new Error('id_token has no email claim');

  // The trust gate. Boolean true ONLY — an unverified address must never reach invite matching,
  // where it would let someone claim an invite addressed to a colleague.
  if (claims.email_verified !== true) {
    throw new Error('google reports this email address as unverified; refusing to sign in');
  }

  const hd = typeof claims.hd === 'string' && claims.hd ? claims.hd.toLowerCase() : undefined;
  const name = typeof claims.name === 'string' ? claims.name : undefined;

  return { sub, email, emailVerified: true, ...(hd ? { hd } : {}), ...(name ? { name } : {}) };
}
