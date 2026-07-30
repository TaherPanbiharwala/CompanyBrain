-- M3 — close the keyring: `acl && grants` becomes the enforced predicate.
--
-- Until now `app.grants` was set on every request (src/db/client.ts) and read by NOTHING, so
-- `scope:'private'` stamped a correct acl that no policy consulted. D0.1 said so outright:
-- "scope:'private' today means 'this row will be private the moment M4 lands', not 'other members
-- cannot read it'." This file is that moment.
--
-- WHY THE FUNCTION IS DEFINED HERE and not only in migrate.ts's ensureAuthFunctions: that helper
-- runs AFTER the migration loop (migrate.ts run(): loop, then the grant transaction). CREATE/ALTER
-- POLICY resolves function names at DDL time, so a policy referencing a function that
-- ensureAuthFunctions has not created yet fails with 42883 and wedges `bun run migrate` on a fresh
-- database AND on an existing one. The REVOKE/GRANT pair is ALSO re-asserted in
-- ensureAuthFunctions, because a later DROP+CREATE for a signature change would restore PUBLIC
-- EXECUTE (migrate.ts documents that case precisely).
--
-- EXPECTED doctor FIXTURE DIFF — exactly four cells in test/fixtures/expected-policies.json
-- (pages_ws and content_chunks_ws, qual and with_check on each). Each gains the conjunct:
--     AND (acl && ( SELECT current_grants() AS current_grants))
-- Nothing else in that fixture may move. Review it as a security change; do NOT reflex --update.

-- ALTER POLICY takes AccessExclusiveLock, so it queues behind in-flight readers and then blocks
-- everything. adminSql() sets no statement_timeout (it inherits Supabase's 2min default), so a
-- bounded wait here is the difference between a fast failure and a stalled deploy. The runner wraps
-- this file in one transaction, so SET LOCAL is correct and the whole file is atomic — there is no
-- window in which the policy is absent or widened.
SET LOCAL lock_timeout = '3s';

-- ── 1. The keyring reader ────────────────────────────────────────────────
--
-- Fail-closed by construction, matching the NULLIF discipline every existing policy already uses
-- (D6): unset -> current_setting returns NULL; SET-then-reverted on a reused pooler backend ->
-- '' (a custom GUC's reset value becomes '' once it has been SET in the session, which is the whole
-- reason NULLIF is here); either way NULLIF yields NULL, string_to_array(NULL, ',') is NULL, and
-- `acl && NULL` is NULL rather than true. RLS requires the qual to be TRUE, so the row is hidden.
--
-- STABLE, never IMMUTABLE, and this is a security control rather than a style choice: an IMMUTABLE
-- zero-argument function is constant-folded at PLAN time, and src/db/client.ts uses
-- `prepare: !config.isPooler`, so on a direct (non-pooler) connection a cached generic plan would
-- bake in one principal's grants and hand them to the next. STABLE forbids that folding.
--
-- PARALLEL SAFE is correct: current_setting(text, bool) is parallel-safe, and parallel workers
-- restore the leader's GUC state including custom placeholders. Marking it restricted would
-- silently disable parallel scans on the content tables.
--
-- The ',' separator MUST match GRANT_SEPARATOR in src/core/context.ts. There is no way to import a
-- TypeScript constant into SQL, so the binding is asserted by the leak canary: a keyring of two
-- tags only overlaps a stamped acl if both sides split the same way.
CREATE OR REPLACE FUNCTION public.current_grants() RETURNS text[]
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SET search_path = pg_catalog
  AS $fn$ SELECT string_to_array(nullif(current_setting('app.grants', true), ''), ',') $fn$;

COMMENT ON FUNCTION public.current_grants() IS
  'The request keyring, read from the tx-local app.grants GUC set by withScopedTx. Returns NULL when unset or empty so `acl && current_grants()` is NULL (row hidden), never true. STABLE is load-bearing: IMMUTABLE would let a cached plan carry one principal''s grants to another.';

-- Postgres grants EXECUTE to PUBLIC on every NEW function, so this revoke is load-bearing.
REVOKE ALL ON FUNCTION public.current_grants() FROM PUBLIC;
-- …and this grant is equally load-bearing, in the opposite direction. RLS policy expressions are
-- evaluated with the QUERYING role's privileges, so revoking PUBLIC without granting cb_app makes
-- every read and write of pages/content_chunks fail with `42501 permission denied for function
-- current_grants` — a total outage of ingest and ask, on a database whose `doctor` (which connects
-- as the owner) would report green throughout.
GRANT EXECUTE ON FUNCTION public.current_grants() TO cb_app;

-- ── 2. The policies ──────────────────────────────────────────────────────
--
-- ALTER, not DROP+CREATE: DROP+CREATE would reset `roles` from {public} and produce four more lines
-- of fixture churn for no behavioural gain.
--
-- The workspace equality STAYS. `acl && current_grants()` does not subsume it: aclForScope('private')
-- yields ['self:<principal>'], and a self: tag carries no tenant — drop the workspace check and a
-- principal acting in workspace B could read their own private page from workspace A.
--
-- The scalar-subquery wrapper does two things. It makes the call an InitPlan evaluated once per
-- query rather than once per candidate row (the rule schema.sql already states for the GUC reads),
-- and — more importantly — an InitPlan output is a valid index-qual RHS, which is what makes
-- idx_pages_acl / idx_chunks_acl usable at all. A per-row STABLE call is not.
--
-- WITH CHECK means a writer may only stamp tags it holds. That is exactly what aclForScope
-- produces, so importPage is unaffected. Note RETURNING is governed by the USING (SELECT) policy,
-- not WITH CHECK — so a future write-on-behalf or re-scope writer fails at `RETURNING id`, and that
-- is deliberate: it fails loudly at write time instead of silently creating an invisible row.
ALTER POLICY pages_ws ON pages
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  );

ALTER POLICY content_chunks_ws ON content_chunks
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  );

-- ── 3. Constraints the CSV-in-a-GUC format now makes load-bearing ────────
--
-- An empty acl overlaps nothing, so `acl = '{}'` is a row permanently invisible to every principal
-- INCLUDING its author, with no error and no application path to repair it (the same policy that
-- hides it blocks rewriting it). Cheap to forbid, impossible to recover from.
ALTER TABLE pages          ADD CONSTRAINT pages_acl_nonempty  CHECK (array_length(acl, 1) >= 1);
ALTER TABLE content_chunks ADD CONSTRAINT chunks_acl_nonempty CHECK (array_length(acl, 1) >= 1);

-- app.grants is a COMMA-SEPARATED string, so a grant tag containing a comma would smuggle an extra
-- key into the keyring. GRANT_TAG_RE in src/core/context.ts is the only thing excluding that today,
-- and it lives in TypeScript. cb_app holds no INSERT on acl_grants (migrate.ts narrowGrants), so
-- this is not exploitable now — but this is the migration that makes the CSV format load-bearing,
-- so the database-side half of the rule belongs here rather than in the milestone that needs it.
ALTER TABLE acl_grants ADD CONSTRAINT acl_grants_tag_ck
  CHECK (grant_tag ~ '^(self|ws|team|role):[A-Za-z0-9_-]+$');

-- ── 4. Slug uniqueness becomes per-person for private pages ──────────────
--
-- Unique-index checks bypass RLS by design (they must, or uniqueness would mean nothing). So
-- UNIQUE(workspace_id, slug) still raised 23505 for a slug belonging to another principal's
-- INVISIBLE private page, and src/ingest/import.ts echoes the slug back in its 409 — the page was
-- hidden while its name was an enumeration oracle, one guess at a time.
--
-- Two partial indexes instead of one constraint: shared pages keep company-wide unique names (so a
-- slug still names one thing for the whole workspace), and only private names are scoped to their
-- author. Postgres has no partial UNIQUE *constraint*, so these are indexes; 23505 reports the
-- index name in the CONSTRAINT field, which is why import.ts must match both new names.
--
-- Consequence recorded for the succession work: promoting a private page to workspace scope can now
-- collide with an existing shared slug, so the re-scope path must handle 23505 rather than assume it.
ALTER TABLE pages DROP CONSTRAINT pages_workspace_id_slug_key;

CREATE UNIQUE INDEX pages_ws_slug_shared ON pages (workspace_id, slug) WHERE scope = 'workspace';
CREATE UNIQUE INDEX pages_ws_slug_private ON pages (workspace_id, owner_principal, slug) WHERE scope = 'private';

COMMENT ON INDEX pages_ws_slug_shared IS
  'Workspace-scoped pages keep company-wide unique slugs. Paired with pages_ws_slug_private; src/ingest/import.ts maps 23505 on either to a 409.';
COMMENT ON INDEX pages_ws_slug_private IS
  'Private pages are unique per AUTHOR, so re-using a colleague''s invisible slug succeeds instead of confirming the page exists (enumeration oracle).';
