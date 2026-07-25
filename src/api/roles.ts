// Workspace role hierarchy for M1 RBAC ("RBAC governs verbs"): owner ⊃ admin ⊃ member.
// Ported from gbrain's src/core/scope.ts (IMPLIES / hasScope) under MIT — see NOTICE.
// Adapted: gbrain's read/write/admin capability scopes are folded into the workspace role;
// agent-token capability scopes are deferred to M3 (BYO-agent). Role lives on workspace_members.
/** The legal roles, lowest first. A const TUPLE, not a readonly array: zod's `z.enum` needs the
 *  literal types, and this is the single list that op schemas publish to agents. It was previously
 *  `readonly Role[]`, exported and used by nothing, while `create_invite.role` was a bare
 *  `z.string()` — so the enum existed and the schema that needed it did not use it. */
export const ROLES_TUPLE = ['member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES_TUPLE)[number];

const ROLE_IMPLIES: Record<Role, ReadonlySet<Role>> = {
  owner: new Set<Role>(['owner', 'admin', 'member']),
  admin: new Set<Role>(['admin', 'member']),
  member: new Set<Role>(['member']),
};

export function isRole(x: string): x is Role {
  return x === 'member' || x === 'admin' || x === 'owner';
}

/** Does the caller's role satisfy the op's required role? Fail-closed: an unknown role denies.
 *  Object.hasOwn guards against Object.prototype keys (a granted role of 'constructor'/'toString'/…
 *  would otherwise index an inherited member and throw on .has — breaking the fail-closed contract). */
export function hasRole(granted: string, required: Role): boolean {
  if (!Object.hasOwn(ROLE_IMPLIES, granted)) return false;
  return ROLE_IMPLIES[granted as Role].has(required);
}
