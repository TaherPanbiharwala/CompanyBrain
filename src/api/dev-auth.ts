// Dev-only request→context resolver. M2 DEMOTED this (it did not remove it): server.ts reaches it
// only when NO session cookie was presented, so a presented-and-rejected session can never fall
// through to it (D45). The real session→membership resolver reuses buildContext/resolveGrants. This is the ONLY code path that
// fabricates identity from untrusted headers, so it is double-gated (NODE_ENV!=='production' AND
// DEV_AUTH=1) and the app hard-refuses to start if that combination looks production-like (review AM9).
// Parameterized on config (defaulting to the singleton) so the gate is unit-testable.
import type { Request } from 'express';
import { config, DEV_ENVS, isDevEnv, type Config } from '../config.ts';
import { buildContext, resolveGrants, type OperationContext } from '../core/context.ts';

type AuthConfig = Pick<Config, 'NODE_ENV' | 'nodeEnvExplicit' | 'DEV_AUTH'>;
type DevLoginConfig = Pick<Config, 'NODE_ENV' | 'nodeEnvExplicit' | 'DEV_AUTH' | 'DEV_LOGIN' | 'appBaseIsLoopback' | 'appBaseUrlExplicit'>;


export function devAuthEnabled(cfg: AuthConfig = config): boolean {
  return cfg.DEV_AUTH === 1 && isDevEnv(cfg);
}

/** Fail-closed boot guard: refuse to start whenever DEV_AUTH=1 in an environment that is NOT a
 *  recognized dev env — production, staging, typos, AND an unset NODE_ENV; warn loudly when it is
 *  legitimately on in dev. Call once at startup.
 *
 *  "unset" is listed above because it is now true. It was not: this tested
 *  `DEV_ENVS.has(cfg.NODE_ENV)` directly, and NODE_ENV defaults to 'development', so an absent
 *  variable passed the very check this docstring said it failed. isDevEnv() is the fix and the
 *  single answer to that question — see config.ts. */
export function assertDevAuthSafe(cfg: AuthConfig = config): void {
  if (cfg.DEV_AUTH !== 1) return;
  if (!isDevEnv(cfg)) {
    const shown = cfg.nodeEnvExplicit ? JSON.stringify(cfg.NODE_ENV) : '(unset — it defaults to "development")';
    throw new Error(
      `Refusing to start: DEV_AUTH=1 with NODE_ENV=${shown} would trust unauthenticated ` +
        `identity headers. DEV_AUTH is only allowed when NODE_ENV is EXPLICITLY 'development' or 'test'. ` +
        `Unset DEV_AUTH here.`,
    );
  }
  console.warn(
    '⚠️  DEV AUTH ENABLED — POST /api/:op trusts x-cb-principal/x-cb-workspace/x-cb-role headers with NO verification. ' +
      'Dev only; demoted at M2 to a fallback for requests that present NO session. (src/api/dev-auth.ts)',
  );
}

// ── POST /auth/dev-login gating (M2, G4) ──────────────────────────────────
// dev-login mints a REAL session cookie with NO Google verification — it is an authentication
// bypass by construction, so it gets FIVE gates rather than the header stub's two, and the route
// must not even EXIST unless all five pass (a route that 401s still confirms it is there).

/** All five gates. Gates 3+4 are now isDevEnv(cfg) — EXPLICIT and in the allowlist. This used to
 *  take a separate `env` argument to reach process.env for the explicitness half; the parsed config
 *  answers it directly since `nodeEnvExplicit` was added, and collapsing the two mechanisms into one
 *  is what stops the OTHER gates drifting away from this one again (they had). */
export function devLoginEnabled(cfg: DevLoginConfig = config): boolean {
  return (
    cfg.DEV_AUTH === 1 && // 1. shared dev-auth flag
    cfg.DEV_LOGIN === 1 && // 2. dedicated flag — a session-minting route needs its own switch
    isDevEnv(cfg) && // 3+4. NODE_ENV explicit AND in the dev allowlist
    cfg.appBaseUrlExplicit && // 5a. APP_BASE_URL EXPLICIT (its default is loopback, so it would pass)
    cfg.appBaseIsLoopback // 5b. …and actually loopback
  );
}

/** Fail-closed boot guard for dev-login. Throws when DEV_LOGIN=1 but any OTHER gate is false —
 *  that combination means someone enabled it somewhere it must never run. Gate 2 alone (DEV_LOGIN=0)
 *  is the normal off state and simply leaves the route unmounted. */
export function assertDevLoginSafe(cfg: DevLoginConfig = config): void {
  if (cfg.DEV_LOGIN !== 1) return;
  const failed: string[] = [];
  if (cfg.DEV_AUTH !== 1) failed.push('DEV_AUTH must also be 1');
  if (!cfg.nodeEnvExplicit) failed.push('NODE_ENV must be set EXPLICITLY (not left to default)');
  else if (!DEV_ENVS.has(cfg.NODE_ENV)) failed.push(`NODE_ENV=${JSON.stringify(cfg.NODE_ENV)} is not 'development' or 'test'`);
  if (!cfg.appBaseUrlExplicit) failed.push('APP_BASE_URL must be set EXPLICITLY (its default is loopback, so it would pass unnoticed)');
  else if (!cfg.appBaseIsLoopback) failed.push('APP_BASE_URL host must be loopback (localhost/127.0.0.1/::1)');
  if (failed.length === 0) {
    console.warn(
      '⚠️  DEV LOGIN ENABLED — POST /auth/dev-login mints a REAL session for ANY email with NO Google ' +
        'verification. Local development only. (src/api/dev-auth.ts)',
    );
    return;
  }
  throw new Error(
    `Refusing to start: DEV_LOGIN=1 but ${failed.join('; ')}. dev-login mints real sessions without ` +
      `identity verification and must never be reachable outside local development. Unset DEV_LOGIN.`,
  );
}

/** Build a ctx from x-cb-* headers, or null if dev-auth is off or the headers are absent. May THROW
 *  ContextError (bad uuid, etc.) — the server maps that to an error envelope. */
export function resolveDevContext(req: Request, cfg: AuthConfig = config): OperationContext | null {
  if (!devAuthEnabled(cfg)) return null;
  const principal = req.header('x-cb-principal');
  const workspaceId = req.header('x-cb-workspace');
  const role = req.header('x-cb-role') ?? 'member';
  if (!principal || !workspaceId) return null;
  return buildContext({
    principal,
    workspaceId,
    role,
    grants: resolveGrants(principal, workspaceId),
    remote: true,
  });
}
