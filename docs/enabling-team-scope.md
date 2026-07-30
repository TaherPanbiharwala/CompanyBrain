<!--
VENDORED 2026-07-30, verbatim from ~/Desktop/novabyte-test-dataset/docs/enabling-team-scope.md.

This is here because it existed ONLY outside version control, reachable via a $HOME-relative
default in scripts/novabyte-eval.ts — CONTEXT.md's #1 ranked action ("a fresh clone has the #1
open item and no spec for it"). Vendoring it is insurance against total loss, not endorsement of
its accuracy.

STATUS: statement of intent, not a work breakdown. Written against the M2 tree (before 0009's
multi-format ingest, before the M4 doctor census, before the acl-tag-format and live-gate
meta-tests existed). A design pass run for the M5 plan (2026-07-30) found it correct on the
semantics (acl derived from scope, fail-closed on a missing team) and wrong on the mechanics in
at least six ways worth knowing before touching this code:

  1. `0007` is taken (0007_acl_rls.sql is applied and checksum-immutable) — the real file is 0013.
  2. Touch point 3's keyring read cannot work as written: it runs BEFORE withScopedTx opens, so
     app.workspace is unset and team_memberships' own RLS returns zero rows, silently, forever.
     It needs a SECURITY DEFINER, not a bare select.
  3. Touch point 4's `.refine()` breaks module load — operations.ts asserts every op's params is a
     bare z.ZodObject, and `.refine()` returns a ZodEffects instead.
  4. It has no notion of the acl-tag-format meta-test (which paren-balance-scans every
     resolveGrants( call site) or the live-gate REQUIRED_LIVE_SUITES registry, both of which
     post-date it.
  5. It predates migration 0009 entirely (page_sources, quarantine, the sha-dedup indexes).
  6. It's missing ~10 touch points the "five touch points" framing doesn't cover — the write path,
     narrowGrants' revoke on the team tables, a third partial slug index (0007's assume exactly
     two scopes and import.ts matches on the index NAME), and the doctor fixture/census changes.

The corrected design lives in the M5 build plan (Phase 3 / M5b) produced the same day. Read this
file for the "why", the M5 plan for the "how".
-->

# Enabling `team` scope in company-brain

This dataset contains **team-scoped pages**. company-brain does not support them yet — `team` is M5
work. This document is the exact change required, written against the code as of the M2 milestone, so
that the dataset is a specification rather than a complaint.

Nothing here is speculative: every touch point below was located in the repo, and the last one is the
one most likely to be forgotten.

## What already exists

The hard parts are done. `schema.sql` already ships:

- `teams (id, workspace_id, name)` with `UNIQUE (id, workspace_id)` as an FK target
- `team_memberships (team_id, principal_id, workspace_id)` with a **composite FK** back to
  `teams (id, workspace_id)`, so a membership can never point at a team in another tenant
- `idx_team_memberships_principal ON (principal_id, workspace_id)` — the comment on it literally
  says *"M5 keyring build (teams for principal P)"*
- `acl_grants` for any extra ReBAC tags beyond self/ws/team
- `GRANT_TAG_RE = /^(self|ws|team|role):[A-Za-z0-9_-]+$/` in `context.ts` — `team:` is already a
  legal tag shape, and `Grant`'s doc comment already lists it

So this is wiring, not design.

## The five touch points

### 1. `src/core/context.ts` — widen the enum and thread the team through

`aclForScope` currently takes `Pick<OperationContext, 'principal' | 'workspaceId'>`. A team-scoped
page needs a *third* input that is not on the context — which team the page belongs to. That extra
argument is the whole reason this isn't a one-line change.

```diff
-export const PAGE_SCOPES = ['private', 'workspace'] as const;
+export const PAGE_SCOPES = ['private', 'team', 'workspace'] as const;
 export type PageScope = (typeof PAGE_SCOPES)[number];

+export const teamGrant = (teamId: string): Grant => `team:${teamId}`;
+
 /** The acl a row with this scope must carry. The ONLY place the mapping exists. */
-export function aclForScope(scope: PageScope, ctx: Pick<OperationContext, 'principal' | 'workspaceId'>): Grant[] {
-  return scope === 'private' ? [selfGrant(ctx.principal)] : [wsGrant(ctx.workspaceId)];
+export function aclForScope(
+  scope: PageScope,
+  ctx: Pick<OperationContext, 'principal' | 'workspaceId'>,
+  teamId?: string,
+): Grant[] {
+  switch (scope) {
+    case 'private': return [selfGrant(ctx.principal)];
+    case 'workspace': return [wsGrant(ctx.workspaceId)];
+    case 'team':
+      // Fail closed, exactly as buildContext does. A team page with no team would otherwise fall
+      // through to a ws: acl — silently publishing it to the whole tenant, which is precisely the
+      // class of defect migration 0003 was written to make unrepresentable.
+      if (!teamId) throw new ContextError('bad_grant', "scope 'team' requires a teamId");
+      if (!UUID_RE.test(teamId)) throw new ContextError('bad_grant', 'teamId is not a valid uuid');
+      return [teamGrant(teamId)];
+  }
 }
```

The `if (!teamId) throw` matters more than it looks. Without it, TypeScript's exhaustiveness is
satisfied but a caller that forgets the argument produces a *readable-by-everyone* row from a page
the author marked team-only — the same failure mode, one scope over, that migration `0003` was
written to close.

`test/scope-acl.test.ts` already asserts *"every declared scope maps to a non-empty acl"* by
iterating `PAGE_SCOPES`. That loop will start failing the moment `'team'` is added, because it calls
`aclForScope(s, ctx)` with no team id — which is the test doing its job. It needs a team id in the
fixture, not a weakened assertion.

### 2. A migration widening the CHECK

`0003_scope_acl_and_comment_fixes.sql:23` currently pins the label:

```sql
ALTER TABLE pages ADD CONSTRAINT pages_scope_ck CHECK (scope IN ('private', 'workspace'));
```

Add `src/db/migrations/0007_team_scope.sql`:

```sql
-- M5: `team` becomes a third visibility label. The acl it derives (`team:<uuid>`) was already a
-- legal grant tag (GRANT_TAG_RE) and team_memberships was already shaped for the keyring build; this
-- is the DB-side half of widening the enum in core/context.ts.
ALTER TABLE pages DROP CONSTRAINT pages_scope_ck;
ALTER TABLE pages ADD CONSTRAINT pages_scope_ck CHECK (scope IN ('private', 'team', 'workspace'));

COMMENT ON COLUMN pages.scope IS
  'Coarse label: private | team | workspace. The acl is DERIVED from it (core/context.ts aclForScope) and is what the database enforces.';
```

No backfill: every existing row is `private` or `workspace` and keeps a matching acl.

### 3. `src/auth/resolver.ts:122` — the keyring build

This is the one that is easy to miss, because everything else will typecheck without it. Today:

```ts
grants: resolveGrants(row.principalId!, row.workspaceId!),
```

A page can now be written with a `team:` acl that **no caller's keyring ever contains**, so it is
invisible to everybody including its author — a dead row. `resolveGrants` already accepts an `extra`
array for exactly this:

```diff
+const teamRows = await sql<{ teamId: string }[]>`
+  select team_id as "teamId" from team_memberships
+  where principal_id = ${row.principalId!} and workspace_id = ${row.workspaceId!}`;
+
-        grants: resolveGrants(row.principalId!, row.workspaceId!),
+        grants: resolveGrants(row.principalId!, row.workspaceId!, teamRows.map((t) => teamGrant(t.teamId))),
```

`idx_team_memberships_principal (principal_id, workspace_id)` already covers this query — it was
added for it.

The same union is needed anywhere else a context is minted: `src/api/dev-auth.ts` and
`src/api/call.ts` (the trusted-local CLI lane, which calls `assertMembership`). A context built in
one lane with team grants and another lane without them is a bug that only shows up as "the CLI can't
see what the browser can."

### 4. `src/api/operations.ts` — the `import_page` params

```diff
     scope: z.enum(PAGE_SCOPES).optional(),
+    // Required iff scope === 'team'. Refined rather than made conditional so the JSON-Schema in
+    // /api/_ops stays flat and legible to agents.
+    teamId: z.string().uuid().optional(),
   }),
```

…with a `.refine()` on the object asserting `scope !== 'team' || teamId != null`, so the failure is a
`400 invalid_params` at the dispatch boundary rather than a throw from deep inside `aclForScope`.

### 5. `src/ingest/import.ts` — thread it

```diff
   scope?: PageScope;
+  teamId?: string;
 }
...
-  const acl = aclForScope(scope, ctx);
+  const acl = aclForScope(scope, ctx, input.teamId);
```

`content_chunks` needs nothing: it already copies `acl` verbatim from the page (D4), so team-scoped
chunks inherit the tag with no further change.

## What to test once it's wired

The dataset's `test_suite/visibility_matrix.json` is built to be the regression suite for this, but
three assertions belong in company-brain's own `test/` regardless:

1. **`aclForScope('team', ctx)` with no teamId throws** — the fail-closed property, not a fallback.
2. **A member of team A cannot read a `team:B` page**, and RLS (not just the app) enforces it. This
   is the `acl && current_grants()` predicate M4 introduces; `team:` is where it stops being
   equivalent to workspace-equality and starts doing real work.
3. **A team page is invisible to a workspace member who is in no team** — the "dead row" direction.
   `tools/validate.mjs` in this dataset checks the corpus can never contain one; company-brain should
   check the database can't either.

Add `team_memberships` to `src/db/doctor.ts`'s policy snapshot fixtures at the same time. The twelve
cross-tenant defects M2's review closed were closed by GRANTs and POLICIES, which no type system
catches — a new grant tag is exactly the kind of change that should have to update a snapshot.
