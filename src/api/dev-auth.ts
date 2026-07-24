// TEMPORARY dev-only request→context resolver. Replaced at M2 by the real session→membership
// resolver (which reuses buildContext/resolveGrants unchanged). This is the ONLY code path that
// fabricates identity from untrusted headers, so it is double-gated (NODE_ENV!=='production' AND
// DEV_AUTH=1) and the app hard-refuses to start if that combination looks production-like (review AM9).
// Parameterized on config (defaulting to the singleton) so the gate is unit-testable.
import type { Request } from 'express';
import { config, type Config } from '../config.ts';
import { buildContext, resolveGrants, type OperationContext } from '../core/context.ts';

type AuthConfig = Pick<Config, 'NODE_ENV' | 'DEV_AUTH'>;

// Fail CLOSED on the environment axis: dev-auth is enabled ONLY for an explicit allowlist of dev
// NODE_ENV values. A negative match (`!== 'production'`) would fail OPEN when NODE_ENV is unset
// (it defaults to 'development' but a deploy might leave it blank) or misspelled ('prod', 'Production').
const DEV_ENVS = new Set(['development', 'test']);

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
