// TEMPORARY dev-only request→context resolver. Replaced at M2 by the real session→membership
// resolver (which reuses buildContext/resolveGrants unchanged). This is the ONLY code path that
// fabricates identity from untrusted headers, so it is double-gated (NODE_ENV!=='production' AND
// DEV_AUTH=1) and the app hard-refuses to start if that combination looks production-like (review AM9).
// Parameterized on config (defaulting to the singleton) so the gate is unit-testable.
import type { Request } from 'express';
import { config, DEV_ENVS, type Config } from '../config.ts';
import { buildContext, resolveGrants, type OperationContext } from '../core/context.ts';

type AuthConfig = Pick<Config, 'NODE_ENV' | 'DEV_AUTH'>;
type DevLoginConfig = Pick<Config, 'NODE_ENV' | 'DEV_AUTH' | 'DEV_LOGIN' | 'appBaseIsLoopback' | 'appBaseUrlExplicit'>;


export function devAuthEnabled(cfg: AuthConfig = config): boolean {
  return cfg.DEV_AUTH === 1 && DEV_ENVS.has(cfg.NODE_ENV);
}

/** Fail-closed boot guard: refuse to start whenever DEV_AUTH=1 in an environment that is NOT a
 *  recognized dev env (covers production, staging, unset, and typos — not just the exact string
 *  'production'); warn loudly when it is legitimately on in dev. Call once at startup. */
export function assertDevAuthSafe(cfg: AuthConfig = config): void {
  if (cfg.DEV_AUTH !== 1) return;
  if (!DEV_ENVS.has(cfg.NODE_ENV)) {
    throw new Error(
      `Refusing to start: DEV_AUTH=1 with NODE_ENV=${JSON.stringify(cfg.NODE_ENV)} would trust unauthenticated ` +
        `identity headers. DEV_AUTH is only allowed when NODE_ENV is 'development' or 'test'. Unset DEV_AUTH here.`,
    );
  }
  console.warn(
    '⚠️  DEV AUTH ENABLED — POST /api/:op trusts x-cb-principal/x-cb-workspace/x-cb-role headers with NO verification. ' +
      'Dev only; replaced by real auth at M2. (src/api/dev-auth.ts)',
  );
}

// ── POST /auth/dev-login gating (M2, G4) ──────────────────────────────────
// dev-login mints a REAL session cookie with NO Google verification — it is an authentication
// bypass by construction, so it gets FIVE gates rather than the header stub's two, and the route
// must not even EXIST unless all five pass (a route that 401s still confirms it is there).

/** All five gates. `env` is passed separately because gate 3 asks whether NODE_ENV was EXPLICITLY
 *  set, which the parsed config cannot answer (it defaults to 'development'). */
export function devLoginEnabled(cfg: DevLoginConfig = config, env: Record<string, string | undefined> = process.env): boolean {
  return (
    cfg.DEV_AUTH === 1 && // 1. shared dev-auth flag
    cfg.DEV_LOGIN === 1 && // 2. dedicated flag — a session-minting route needs its own switch
    env.NODE_ENV !== undefined && // 3. NODE_ENV EXPLICIT (closes the 'development' default)
    DEV_ENVS.has(cfg.NODE_ENV) && // 4. dev/test allowlist
    cfg.appBaseUrlExplicit && // 5a. APP_BASE_URL EXPLICIT (its default is loopback, so it would pass)
    cfg.appBaseIsLoopback // 5b. …and actually loopback
  );
}

/** Fail-closed boot guard for dev-login. Throws when DEV_LOGIN=1 but any OTHER gate is false —
 *  that combination means someone enabled it somewhere it must never run. Gate 2 alone (DEV_LOGIN=0)
 *  is the normal off state and simply leaves the route unmounted. */
export function assertDevLoginSafe(
  cfg: DevLoginConfig = config,
  env: Record<string, string | undefined> = process.env,
): void {
  if (cfg.DEV_LOGIN !== 1) return;
  const failed: string[] = [];
  if (cfg.DEV_AUTH !== 1) failed.push('DEV_AUTH must also be 1');
  if (env.NODE_ENV === undefined) failed.push('NODE_ENV must be set EXPLICITLY (not left to default)');
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
