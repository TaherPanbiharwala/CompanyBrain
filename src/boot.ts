// Deployment-shape boot gates.
//
// Companion to assertDevAuthSafe/assertDevLoginSafe in api/dev-auth.ts: those guard the two identity
// BYPASSES, these guard configurations that are silently wrong rather than obviously off. Every one
// of them was a `console.warn` or nothing at all before the M2 review, and the review's finding was
// the same each time: a warning that fires only under `import.meta.main` is not a gate, and the
// configuration it warns about is usually the DEFAULT.
//
// Kept out of config.ts on purpose — parseConfig is pure and runs at import in every unit test, so
// anything that can throw belongs here.
import { config as defaultConfig, isDevEnv, type Config } from './config.ts';

type DeploymentConfig = Pick<
  Config,
  | 'NODE_ENV' | 'nodeEnvExplicit'
  | 'TRUST_PROXY'
  | 'APP_BASE_URL'
  | 'appBaseIsLoopback'
  | 'appBaseIsHttps'
  | 'SESSION_SECRET'
  | 'DATABASE_AUTH_URL'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
>;

/**
 * Refuse to start on a deployment shape that would be quietly unsafe.
 *
 * Runs at import (see src/index.ts) so that any entrypoint importing `app` trips it too.
 */
export function assertDeploymentSafe(cfg: DeploymentConfig = defaultConfig): void {
  // Loopback development is exempt from both network-shape gates below: there is no proxy and no
  // certificate, and requiring either would make `bun run start` impossible.
  if (cfg.appBaseIsLoopback) return;

  // (1) Rate limiting is keyed on req.ip. Behind ANY proxy — Fly, Railway, Render, Cloud Run, nginx,
  // an ALB — req.ip is the PROXY's address unless trust proxy is configured, so the 30-per-5-minute
  // budget becomes one shared bucket for every user on the platform. Thirty-one requests from one
  // anonymous client then takes sign-in offline for everybody, including /auth/google/callback, so
  // users mid-flow are ejected too. This was previously only a console.warn under import.meta.main.
  if (!cfg.TRUST_PROXY) {
    throw new Error(
      `Refusing to start: APP_BASE_URL is ${cfg.APP_BASE_URL} (not loopback) but TRUST_PROXY is unset. ` +
        `Behind a proxy req.ip becomes the proxy's address, which collapses the /auth/* rate limiter ` +
        `to ONE bucket for the entire fleet — a single anonymous client could then take sign-in ` +
        `offline for every user. Set TRUST_PROXY ('loopback', or the number of proxy hops in front ` +
        `of this app). If nothing is in front of it, set TRUST_PROXY=0.`,
    );
  }

  // (2) Off loopback, plain http costs BOTH cookie protections at once: no Secure, and no __Host-
  // prefix. Without __Host-, any sibling subdomain can set a cb_session for the parent domain, and
  // cookie parsing is first-wins with more-specific-Path sorted first — a session-fixation primitive.
  if (!cfg.appBaseIsHttps) {
    throw new Error(
      `Refusing to start: APP_BASE_URL is ${cfg.APP_BASE_URL} — plain http on a non-loopback host. ` +
        `The session cookie would lose both the Secure attribute and the __Host- prefix, letting any ` +
        `sibling subdomain set a cb_session for the parent domain (session fixation). Use https, or ` +
        `run on localhost for development.`,
    );
  }

  // (3) Secrets the auth flow needs. All of these default to '' and were asserted nowhere, so the
  // process booted, /health went green, and the user hit a 500 AFTER Google had already
  // authenticated them — the worst possible place to discover a missing environment variable.
  // isDevEnv, not DEV_ENVS.has: NODE_ENV defaults to 'development', so an UNSET value used to skip
  // this entire block — the app started with SESSION_SECRET, DATABASE_AUTH_URL and both Google
  // credentials empty, /health green, and the first real login 500ing. Same root cause as the
  // dev-auth gate; both now ask the one question in config.ts.
  if (!isDevEnv(cfg)) {
    const missing: string[] = [];
    if (cfg.SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (must be >= 32 chars)');
    if (!cfg.DATABASE_AUTH_URL) missing.push('DATABASE_AUTH_URL');
    if (!cfg.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
    if (!cfg.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
    if (missing.length) {
      throw new Error(
        `Refusing to start: NODE_ENV=${cfg.nodeEnvExplicit ? cfg.NODE_ENV : '(unset — it defaults to "development")'} ` +
          `but the sign-in flow is not fully configured. ` +
          `Missing: ${missing.join(', ')}. Without these the app boots and /health reports ok, then ` +
          `every login fails — some of them only AFTER the user has authenticated at Google. ` +
          `See docs/auth-setup.md.`,
      );
    }
  }
}
