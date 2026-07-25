// Onboarding: turn a verified identity into (principal, active workspace, role).
//
// Everything here runs on the cb_auth pool — these are the writes that cannot happen under cb_app,
// because at this point in the request there is no app.workspace GUC to scope RLS by, and because
// narrowGrants deliberately leaves cb_app unable to write memberships at all.
import type postgres from 'postgres';
import { authLane } from '../db/client.ts';
import { OperationError } from '../api/errors.ts';
import { normalizeEmail } from './normalize.ts';
import { isPublicDomain } from './blocklist.ts';
import type { VerifiedIdentity } from './google.ts';

export interface OnboardResult {
  principalId: string;
  emailNormalized: string;
  /** null ⇒ the caller must create or join one via POST /auth/workspaces before it can use /api/:op. */
  activeWorkspaceId: string | null;
  role: string | null;
}

/** The ONLY place a workspace domain may be claimed, used by both the bootstrap route and (future)
 *  callback-side creation — one function, never a copy, so the rule cannot drift between them.
 *
 *  `loginHd` is the Google-signed `hd` claim from THIS login, carried on the session row. It is NOT
 *  the email's domain: Google sets `hd` only for Workspace accounts, so a consumer account can own
 *  a mailbox at any custom domain and would otherwise be able to squat that domain's auto-join —
 *  permanently, since workspaces.domain is UNIQUE. */
export function claimDomain(domain: string | null | undefined, loginHd: string | null | undefined): string | null {
  if (domain === null || domain === undefined || domain === '') return null;
  const wanted = domain.trim().toLowerCase();
  if (!loginHd) {
    throw new OperationError(
      'domain_not_verified',
      'this sign-in did not verify a Google Workspace domain, so it cannot claim one',
      'Create the workspace without a domain, or sign in with a Google Workspace account for that domain.',
    );
  }
  if (wanted !== loginHd.toLowerCase()) {
    throw new OperationError(
      'domain_not_verified',
      'the requested domain does not match the domain verified by this sign-in',
      'You can only claim the domain your Google Workspace account belongs to.',
    );
  }
  if (isPublicDomain(wanted)) {
    throw new OperationError(
      'domain_not_verified',
      'public email domains cannot be claimed for auto-join',
      'Create the workspace without a domain and invite teammates by email instead.',
    );
  }
  return wanted;
}

interface PgError {
  code?: string;
  constraint_name?: string;
}

/** Insert-or-refresh the principal for a verified identity.
 *
 *  The `email_normalized` UNIQUE constraint creates one interesting case: a row already exists for
 *  this address with NO google_sub (a seeded/imported placeholder). Adopting it links the account
 *  once rather than forking the human into two principals — which would leave their existing
 *  content invisible to them. The `google_sub IS NULL` guard lives inside the definer function, so
 *  cb_auth never holds UPDATE on that column. */
async function upsertPrincipal(sql: postgres.Sql, identity: VerifiedIdentity, emailNormalized: string): Promise<string> {
  try {
    const rows = await sql<{ id: string }[]>`
      insert into principals (google_sub, email, email_normalized, name)
      values (${identity.sub}, ${identity.email}, ${emailNormalized}, ${identity.name ?? null})
      on conflict (google_sub) do update
        set email = excluded.email,
            email_normalized = excluded.email_normalized,
            name = coalesce(excluded.name, principals.name),
            updated_at = now()
      returning id`;
    const id = rows[0]?.id;
    if (!id) throw new Error('upsertPrincipal: insert returned no row');
    return id;
  } catch (err) {
    const e = err as PgError;
    // ONLY the email_normalized collision routes to adopt. Any other 23505 (or any other error)
    // rethrows — feeding a google_sub violation into the adopt path would target the wrong row.
    if (e.code !== '23505' || e.constraint_name !== 'principals_email_normalized_key') throw err;

    const existing = await sql<{ id: string }[]>`
      select id from principals where email_normalized = ${emailNormalized}`;
    const existingId = existing[0]?.id;
    if (!existingId) throw err; // vanished between the conflict and this read

    let adopted: { adopt_principal: string | null }[];
    try {
      adopted = await sql<{ adopt_principal: string | null }[]>`
        select cb_internal.adopt_principal(${existingId}::uuid, ${identity.sub}) as adopt_principal`;
    } catch (adoptErr) {
      // The adopt itself can collide. principals.google_sub is UNIQUE, so if THIS sub already sits
      // on a different row — the user changed their Google address to one a placeholder row already
      // holds — the UPDATE raises 23505 on principals_google_sub_key from inside this catch block.
      // Uncaught, that surfaced as a 500 on every subsequent login attempt, with no way out.
      // It is the same human owning two rows, so it is the same conflict: report it as one.
      if ((adoptErr as { code?: string } | null)?.code === '23505') {
        throw new OperationError(
          'account_conflict',
          'this email address cannot be linked to your Google account',
          'Another principal already holds this Google identity or this address. Contact support to merge them.',
        );
      }
      throw adoptErr;
    }
    if (!adopted[0]?.adopt_principal) {
      // The row is already bound to a DIFFERENT Google account. Deterministic 409 — never a 500 and
      // never a raw permission error. Remediation SQL lives in docs/auth-setup.md, not on the wire.
      throw new OperationError(
        'account_conflict',
        'this email address is already linked to a different Google account',
        'Sign in with the original Google account, or contact support to unlink it.',
      );
    }
    // Refresh the profile now that we own the row.
    await sql`
      update principals set email = ${identity.email}, name = coalesce(${identity.name ?? null}, name), updated_at = now()
      where id = ${existingId}`;
    return existingId;
  }
}

/** Resolve which workspace this login should act in.
 *
 *  Pending invites are deliberately NOT consumed here. Auto-consuming them would mean anyone who
 *  knows your email address could make you a member of their workspace and have it become your
 *  ACTIVE workspace on first login — so your first upload would land in their tenant. Invites are
 *  accepted only by explicitly presenting the token (POST /auth/invites/accept). */
async function resolveWorkspace(
  sql: postgres.Sql,
  principalId: string,
  hd: string | undefined,
): Promise<{ workspaceId: string | null; role: string | null }> {
  // (a) An existing membership always wins. Deterministic ordering so the "active" workspace does
  // not shuffle between logins.
  const mine = await sql<{ workspace_id: string; role: string }[]>`
    select workspace_id, role from workspace_members
    where principal_id = ${principalId}
    order by created_at asc, workspace_id asc limit 1`;
  if (mine[0]) return { workspaceId: mine[0].workspace_id, role: mine[0].role };

  // (b) Verified Workspace domain matching an existing workspace ⇒ auto-join as a member.
  //
  // The block check is what makes removal DURABLE. Without it, an admin who removes an employee from
  // a domain-claimed workspace has them silently auto-rejoined here on their very next login —
  // removal appeared to work and then quietly undid itself, including the composite-FK SET NULL that
  // had cleared their active workspace. The tombstone outlives the membership row on purpose.
  if (hd && !isPublicDomain(hd)) {
    const ws = await sql<{ id: string }[]>`
      select w.id from workspaces w
      where w.domain = ${hd.toLowerCase()}
        and not exists (
          select 1 from workspace_domain_blocks b
          where b.workspace_id = w.id and b.principal_id = ${principalId}
        )`;
    const wsId = ws[0]?.id;
    if (wsId) {
      await sql`
        insert into workspace_members (workspace_id, principal_id, role)
        values (${wsId}, ${principalId}, 'member')
        on conflict (workspace_id, principal_id) do nothing`;
      return { workspaceId: wsId, role: 'member' };
    }
  }

  // (c) Workspace-less. Legal, and the client must call POST /auth/workspaces next.
  return { workspaceId: null, role: null };
}

export async function onboard(identity: VerifiedIdentity): Promise<OnboardResult> {
  const sql = await authLane();
  const emailNormalized = normalizeEmail(identity.email);
  const principalId = await upsertPrincipal(sql, identity, emailNormalized);
  const { workspaceId, role } = await resolveWorkspace(sql, principalId, identity.hd);
  return { principalId, emailNormalized, activeWorkspaceId: workspaceId, role };
}

export interface CreateWorkspaceResult {
  workspaceId: string;
  role: 'owner';
}

/** Bootstrap: create a workspace, make the caller its owner, and point the session at it — one
 *  transaction, in this order, because the sessions composite FK rejects an active_workspace_id
 *  that is not already a membership row. */
export async function createWorkspace(input: {
  principalId: string;
  tokenHash: string;
  name: string;
  domain?: string | null;
}): Promise<CreateWorkspaceResult> {
  const sql = await authLane();
  return sql.begin(async (tx) => {
    // Read login_hd from THIS session, inside the same transaction as the writes.
    const sess = await tx<{ login_hd: string | null }[]>`
      select login_hd from sessions where token_hash = ${input.tokenHash}`;
    if (!sess[0]) throw new OperationError('unauthenticated', 'session not found');
    const domain = claimDomain(input.domain, sess[0].login_hd);

    const ws = await tx<{ id: string }[]>`
      insert into workspaces (name, domain, created_by)
      values (${input.name}, ${domain}, ${input.principalId})
      returning id`;
    const workspaceId = ws[0]?.id;
    if (!workspaceId) throw new Error('createWorkspace: insert returned no row');

    await tx`
      insert into workspace_members (workspace_id, principal_id, role)
      values (${workspaceId}, ${input.principalId}, 'owner')
      on conflict (workspace_id, principal_id) do nothing`;

    await tx`update sessions set active_workspace_id = ${workspaceId} where token_hash = ${input.tokenHash}`;
    return { workspaceId, role: 'owner' as const };
  }) as Promise<CreateWorkspaceResult>;
}

/** Switch the active workspace. The membership SELECT and the session UPDATE share one cb_auth
 *  transaction, so the check cannot go stale between them; the composite FK is the backstop. */
export async function activateWorkspace(input: {
  principalId: string;
  tokenHash: string;
  workspaceId: string;
}): Promise<{ workspaceId: string; role: string }> {
  const sql = await authLane();
  return sql.begin(async (tx) => {
    const m = await tx<{ role: string }[]>`
      select role from workspace_members
      where workspace_id = ${input.workspaceId} and principal_id = ${input.principalId}`;
    // "Workspace does not exist" and "you are not a member" return the SAME error on purpose —
    // distinguishing them would turn this into a workspace-existence oracle.
    if (!m[0]) throw new OperationError('permission_denied', 'not a member of that workspace');
    await tx`
      update sessions set active_workspace_id = ${input.workspaceId} where token_hash = ${input.tokenHash}`;
    return { workspaceId: input.workspaceId, role: m[0].role };
  }) as Promise<{ workspaceId: string; role: string }>;
}
