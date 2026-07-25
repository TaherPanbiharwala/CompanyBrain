// D25 for session-less callers.
//
// `bun run call`, the stdio MCP bridge and the A17 scripts are trusted-local and env-identified:
// CB_CLI_*/CB_MCP_* say WHICH principal and workspace, but they must not be able to say what ROLE
// that principal has, and they must not be able to name a pair that is not a real membership.
// Without this, "app.workspace comes only from a verified workspace_members row" would be a
// property of the HTTP surface only — three other code paths fabricate a context directly.
//
// Runs on the cb_app pool through a SECURITY DEFINER function, so it needs no cb_auth credential
// (the CLI has none) and reads nothing else.
import { appSql } from '../db/client.ts';

/** The authoritative role for (principal, workspace), or null if that pair is not a membership.
 *  Never throws for a merely-unknown pair — callers decide how loudly to fail. */
export async function membershipRole(principalId: string, workspaceId: string): Promise<string | null> {
  const rows = await appSql()<{ role: string | null }[]>`
    select cb_internal.membership_role(${principalId}::uuid, ${workspaceId}::uuid) as role`;
  return rows[0]?.role ?? null;
}

/** Fail-closed variant for the machine-caller entrypoints: returns the authoritative role or throws.
 *  The env-supplied role (if any) is IGNORED — that is the whole point. */
export async function assertMembership(principalId: string, workspaceId: string): Promise<string> {
  const role = await membershipRole(principalId, workspaceId);
  if (!role) {
    throw new Error(
      `Not a member: principal ${principalId} has no membership in workspace ${workspaceId}. ` +
        `Check CB_CLI_PRINCIPAL / CB_CLI_WORKSPACE (or CB_MCP_*) against a real workspace_members row — ` +
        `\`bun run seed:a17\` prints a valid pair, and POST /auth/dev-login returns one.`,
    );
  }
  return role;
}
