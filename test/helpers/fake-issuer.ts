// An in-process OIDC issuer, so the Google callback path can be tested against the REAL
// openid-client validation code without a network or a Google Cloud project.
//
// This deliberately does NOT stub completeAuth. The whole point is to exercise the library's
// signature/iss/aud/exp/nonce checks plus our own email_verified gate — a stub would test nothing
// but our own mock. Tokens are minted with `jose` and served over an injected `customFetch`.
import * as jose from 'jose';
import * as client from 'openid-client';

export const FAKE_ISSUER = 'https://fake-issuer.test';
export const FAKE_CLIENT_ID = 'fake-client-id.apps.googleusercontent.com';
const TOKEN_ENDPOINT = `${FAKE_ISSUER}/token`;
const JWKS_URI = `${FAKE_ISSUER}/jwks`;
const KID = 'test-key-1';

export interface FakeIssuer {
  config: client.Configuration;
  /** Mint an id_token. Overrides let a test bend exactly one claim and leave the rest valid. */
  mintIdToken(claims?: Record<string, unknown>): Promise<string>;
  /** Queue the id_token the next token-endpoint exchange will return. */
  setNextIdToken(idToken: string): void;
}

export async function createFakeIssuer(): Promise<FakeIssuer> {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk = await jose.exportJWK(publicKey);
  const jwks = { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] };

  let nextIdToken = '';

  async function mintIdToken(overrides: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: FAKE_ISSUER,
      aud: FAKE_CLIENT_ID,
      sub: '1234567890',
      email: 'user@example.com',
      email_verified: true,
      name: 'Test User',
      iat: now,
      exp: now + 300,
      ...overrides,
    };
    // `undefined` in overrides means "omit this claim entirely" (e.g. a token with no
    // email_verified at all), which is different from setting it to false.
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
    return new jose.SignJWT(claims as jose.JWTPayload)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .sign(privateKey);
  }

  // Serves the two endpoints openid-client will reach for during authorizationCodeGrant.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(JWKS_URI)) {
      return new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith(TOKEN_ENDPOINT)) {
      return new Response(
        JSON.stringify({ access_token: 'fake-access-token', token_type: 'bearer', expires_in: 3600, id_token: nextIdToken }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`fake issuer: unexpected fetch to ${url} (init=${JSON.stringify(init?.method ?? 'GET')})`);
  }) as unknown as typeof fetch;

  const config = new client.Configuration(
    {
      issuer: FAKE_ISSUER,
      token_endpoint: TOKEN_ENDPOINT,
      jwks_uri: JWKS_URI,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      id_token_signing_alg_values_supported: ['RS256'],
    },
    FAKE_CLIENT_ID,
    { client_secret: 'fake-client-secret' },
  );
  config[client.customFetch] = fetchImpl;
  // The fake issuer is https:// so no insecure-request allowance is needed.

  return { config, mintIdToken, setNextIdToken: (t) => { nextIdToken = t; } };
}

/** The URL Google would bounce the browser back to. */
export function callbackUrl(state: string, code = 'fake-auth-code'): URL {
  return new URL(`https://app.test/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
}
