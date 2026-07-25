// The request → tenant-context resolver. This function is the cardinal invariant (D25) in code:
// `app.workspace` may only ever come from a VERIFIED workspace_members row for the authenticated
// principal, never from anything the caller sent.
//
// It makes exactly ONE database call, to a SECURITY DEFINER function that does the session lookup,
// the expiry check, the epoch check and the membership re-verification in a single statement. That
// function takes only a token hash — no principal or workspace argument — so there is no parameter
// through which request input could influence which tenant comes back. It runs on the cb_app pool;
// cb_auth is never touched on /api/:op.
import type { Request, Response } from 'express';
import { buildContext, resolveGrants, ContextError, type OperationContext } from '../core/context.ts';
import { appSql, assertAppPoolRole } from '../db/client.ts';
import { hashToken, looksLikeToken, sessionCookieName, sessionCookieAttrs, clearAuthCookie } from './session.ts';

/** Mirrors cb_internal.resolve_session's `reason` column. */
export type SessionReason = 'expired' | 'epoch_stale' | 'no_active_ws' | 'membership_revoked' | 'ok';

export interface SessionRow {
  reason: SessionReason;
  principalId: string | null;
  workspaceId: string | null;
  memberRole: string | null;
  tokenHash: string;
  rawToken: string;
}

function readSessionCookie(req: Request): string | null {
  const jar = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const raw = jar?.[sessionCookieName()];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Did the caller PRESENT a session cookie at all?
 *
 *  Distinct from "did it resolve": server.ts needs to tell "no session was offered" (fall through to
 *  the dev-auth stub, if enabled) from "a session was offered and rejected" (401, full stop). Without
 *  that distinction an EXPIRED cookie plus forged x-cb-* headers authenticates, because
 *  resolveSessionContext returns null for expiry and `?? resolveDevContext(req)` then picks it up —
 *  which makes session expiry decorative in every environment where DEV_AUTH=1. */
export function hasSessionCookie(req: Request): boolean {
  return readSessionCookie(req) !== null;
}

/** Never throws. Returns null when there is no usable session cookie at all.
 *
 *  Every cookie-authenticated route EXCEPT POST /api/:op consumes this directly and reads the raw
 *  `reason`, because they all exist to serve sessions that may legitimately be workspace-less
 *  (logout, bootstrap, invite accept, workspace switch). Only server.ts uses the wrapper below. */
export async function resolveSessionRow(req: Request): Promise<SessionRow | null> {
  const raw = readSessionCookie(req);
  if (!raw) return null;
  // Shape check before touching the database: a flood of junk cookies is answered from memory
  // rather than by a round trip on a pool that is reachable pre-authentication.
  if (!looksLikeToken(raw)) return null;

  await assertAppPoolRole();
  const tokenHash = hashToken(raw);
  const rows = await appSql()<
    { reason: SessionReason; principal_id: string | null; workspace_id: string | null; member_role: string | null }[]
  >`select * from cb_internal.resolve_session(${tokenHash})`;

  const row = rows[0];
  if (!row) return null; // no such session
  return {
    reason: row.reason,
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
    memberRole: row.member_role,
    tokenHash,
    rawToken: raw,
  };
}

function clearSessionCookie(res: Response): void {
  clearAuthCookie(res, sessionCookieName(), sessionCookieAttrs());
}

/**
 * The /api/:op contract. Returns:
 *   * `null` for every 401 case (no cookie, unknown session, expired, epoch-stale) — the caller
 *     then falls through to the dev-auth stub, which is off outside local development.
 *   * a `ContextError` throw for the 400 cases (authenticated, but no usable workspace).
 *
 * That split is deliberate: a workspace-less session is a REAL session, so it must not silently
 * degrade into "unauthenticated" and get picked up by a header stub.
 */
export async function resolveSessionContext(req: Request, res: Response): Promise<OperationContext | null> {
  const row = await resolveSessionRow(req);
  if (!row) return null;

  switch (row.reason) {
    case 'expired':
      clearSessionCookie(res);
      return null;

    case 'epoch_stale':
      // Signed out everywhere from another device; the cookie is dead but well-formed.
      clearSessionCookie(res);
      return null;

    case 'no_active_ws':
      throw new ContextError('no_workspace', 'signed in, but not acting in any workspace');

    case 'membership_revoked':
      // Defensive only. The sessions composite FK nulls active_workspace_id in the same transaction
      // that deletes a membership, so 'no_active_ws' wins in practice. Kept as a fail-closed arm —
      // never the basis of a user-facing distinction.
      throw new ContextError('no_workspace', 'signed in, but not acting in any workspace');

    case 'ok':
      // The three scalars are non-null only on this branch, and workspaceId came from the
      // membership row itself. buildContext re-validates uuid shape as a final backstop.
      return buildContext({
        principal: row.principalId,
        workspaceId: row.workspaceId,
        role: row.memberRole,
        grants: resolveGrants(row.principalId!, row.workspaceId!),
        remote: false, // first-party browser session
      });

    default: {
      const _exhaustive: never = row.reason;
      void _exhaustive;
      return null;
    }
  }
}
