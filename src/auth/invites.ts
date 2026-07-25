// Invites — the only way a principal joins a workspace they have no domain claim to, and therefore
// the only cross-tenant membership-granting path in the product.
//
// Two rules do the heavy lifting:
//   * Acceptance is TOKEN-ONLY. A pending invite is never consumed just because someone logged in
//     with a matching address — otherwise anyone who knows your email could make you a member of
//     their workspace and have it become your active workspace on first login.
//   * The claim is a SINGLE statement whose WHERE clause carries every precondition (pending, not
//     expired, right email). Concurrency and expiry are enforced by the database, not by a
//     check-then-act sequence that two simultaneous requests could both pass.
import type postgres from 'postgres';
import { authLane } from '../db/client.ts';
import { config } from '../config.ts';
import { OperationError } from '../api/errors.ts';
import { generateToken, hashToken } from './session.ts';
import { normalizeEmail } from './normalize.ts';
import { hasRole, isRole, type Role } from '../api/roles.ts';
import type { OperationContext } from '../core/context.ts';

export interface CreatedInvite {
  inviteId: string;
  /** Returned EXACTLY ONCE. Only the hash is stored, so it can never be read back — if it is lost,
   *  revoke the invite and issue a new one. M2 sends no email; the inviter copies the URL. */
  token: string;
  acceptUrl: string;
  expiresAt: Date;
}

/** Runs on the cb_app lane inside withScopedTx, so the `invites_ws` policy's
 *  `WITH CHECK (workspace_id = app.workspace)` structurally confines the row to one tenant. */
export async function createInvite(
  tx: postgres.TransactionSql,
  ctx: OperationContext,
  input: { email: string; role: string },
): Promise<CreatedInvite> {
  if (!isRole(input.role)) {
    throw new OperationError('invalid_params', `role must be one of owner, admin, member`);
  }
  // Role ceiling: an admin must not be able to mint an owner invite and escalate through it. This
  // is an APP-LAYER control — cb_app holds table-level INSERT on invites, so nothing in the
  // database stops an invites.role='owner' write. test/invites.test.ts covers it for exactly that
  // reason. (For most of M2 this comment claimed a test that did not exist, on an op that was not
  // registered, so the guard had never once executed.)
  if (!hasRole(ctx.role, input.role as Role)) {
    throw new OperationError(
      'insufficient_role',
      `you cannot invite someone at a role above your own (${ctx.role})`,
      'Ask an owner to send this invite.',
    );
  }

  const token = generateToken();
  // normalizeEmail THROWS on anything that cannot be a mailbox. The op schema bounds the length
  // (3..320) but not the shape, and MCP/CLI callers bypass Express entirely — so a typo'd address
  // reached here and left as `500 internal_error`. It is the caller's input; it deserves a 400.
  let emailNormalized: string;
  try {
    emailNormalized = normalizeEmail(input.email);
  } catch {
    throw new OperationError(
      'invalid_params',
      'email is not a valid address',
      'Use a full address like name@company.com.',
    );
  }
  const rows = await tx<{ id: string; expires_at: Date }[]>`
    insert into invites (workspace_id, email, email_normalized, token_hash, role, invited_by, expires_at)
    values (${ctx.workspaceId}, ${input.email.trim()}, ${emailNormalized}, ${hashToken(token)},
            ${input.role}, ${ctx.principal},
            -- secs, not days: make_interval(days => …) takes an INTEGER, but INVITE_TTL_DAYS is
            -- z.coerce.number(), so INVITE_TTL_DAYS=0.5 would fail at runtime with "invalid input
            -- syntax for type integer". Same fix session.ts already carries for the same reason.
            now() + make_interval(secs => ${config.INVITE_TTL_DAYS * 86_400}))
    returning id, expires_at`;
  const row = rows[0];
  if (!row) throw new Error('createInvite: insert returned no row');

  return {
    inviteId: row.id,
    token,
    // Fragment, not query string, and it points at a LANDING path rather than the POST-only accept
    // route. Two bugs in one line before the M2 review: the URL was `…/auth/invites/accept?token=`,
    // which (a) 404s when clicked, because /auth/invites/accept is POST-only, so the single
    // documented way to redeem an invite could not work; and (b) put a bearer-equivalent credential
    // in a query string, where it lands in proxy and CDN access logs, browser history, and the
    // Referer header of anything the page subsequently loads. A fragment is never sent to a server.
    //
    // Until M5 ships the UI that reads the fragment, the operator flow is: copy the token and POST
    // it to /auth/invites/accept. docs/auth-setup.md spells that out.
    acceptUrl: `${config.APP_BASE_URL.replace(/\/+$/, '')}/invites/accept#token=${encodeURIComponent(token)}`,
    expiresAt: row.expires_at,
  };
}

export interface AcceptedInvite {
  workspaceId: string;
  role: string;
}

/** Claim-first: one UPDATE carries every precondition, so a double-accept race has exactly one
 *  winner and an expired or mis-addressed invite fails the same way a forged token does.
 *
 *  This statement is the ONLY enforcement of INVITE_TTL_DAYS — nothing sweeps `status` to
 *  'expired', so an expiry check anywhere else would be the only thing standing between a stale
 *  invite and a membership. */
export async function acceptByToken(input: {
  rawToken: string;
  principalId: string;
  principalEmailNormalized: string;
  tokenHash: string; // the SESSION token hash, for pointing the session at the new workspace
}): Promise<AcceptedInvite> {
  const sql = await authLane();
  return sql.begin(async (tx) => {
    const claimed = await tx<{ workspace_id: string; role: string }[]>`
      update invites
         set status = 'accepted', accepted_by = ${input.principalId}
       where token_hash = ${hashToken(input.rawToken)}
         and status = 'pending'
         and expires_at > now()
         and email_normalized = ${input.principalEmailNormalized}
      returning workspace_id, role`;

    // ONE generic failure for wrong-token / expired / already-accepted / addressed-to-someone-else.
    // Distinguishing them would confirm that a given invite token exists, or that a given address
    // was invited to a workspace the caller cannot otherwise see.
    const invite = claimed[0];
    if (!invite) {
      throw new OperationError(
        'invite_invalid',
        'this invite is not valid',
        'Ask for a fresh invite link — invites are single-use, expire, and are tied to one email address.',
      );
    }

    // ON CONFLICT DO NOTHING: an invite never CHANGES an existing role. cb_auth deliberately holds
    // no UPDATE (role) on workspace_members, so this is enforced by grant as well as by statement.
    await tx`
      insert into workspace_members (workspace_id, principal_id, role)
      values (${invite.workspace_id}, ${input.principalId}, ${invite.role})
      on conflict (workspace_id, principal_id) do nothing`;

    await tx`
      update sessions set active_workspace_id = ${invite.workspace_id} where token_hash = ${input.tokenHash}`;

    // Report the role the DATABASE holds, not the one the invite asked for. Because of DO NOTHING
    // above, an existing member keeps their current role — so returning `invite.role` told a member
    // who accepted an 'owner' invite that they were now an owner while their membership still said
    // 'member'. That is silent wrongness rather than an error: the caller renders an owner surface
    // and only finds out on the next request.
    const actual = await tx<{ role: string }[]>`
      select role from workspace_members
      where workspace_id = ${invite.workspace_id} and principal_id = ${input.principalId}`;
    const role = actual[0]?.role;
    if (!role) throw new Error('acceptByToken: membership row missing immediately after insert');

    return { workspaceId: invite.workspace_id, role };
  }) as Promise<AcceptedInvite>;
}

// DELETED: listPendingFor().
//
// Exported, uncalled, untested. Invite acceptance is token-only by design (D38), so a "list my
// pending invites" view has nothing to do until there is a UI to render it — it returns with M5
// alongside the invite admin screen, at which point its "must never create a membership" invariant
// gets a test rather than a comment.
