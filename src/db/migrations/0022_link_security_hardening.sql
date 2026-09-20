-- 0022_link_security_hardening.sql — close the M9 edge security/lifecycle gaps.
--
-- WHY A NEW FILE: 0021_link_extraction.sql is already applied and checksum-immutable. In
-- particular, its array_length(..., 1) checks accept '{}' because array_length returns NULL and a
-- CHECK passes on NULL. This migration fixes forward with named cardinality constraints.
--
-- D4 requires content-adjacent security state to be denormalized rather than recovered by a join
-- inside RLS. An edge has two endpoints, so links carries both endpoints' acl AND deleted_at. One
-- owner-run trigger function maintains all four fields:
--
--   * BEFORE INSERT/UPDATE on links it ignores caller-supplied security fields and derives them
--     from the two pages. A direct insert therefore cannot spoof an acl/deletion value.
--   * AFTER acl/deleted_at UPDATE on pages it refreshes outgoing AND incoming edges. SECURITY
--     DEFINER is required for the incoming half: after a rescope the caller may no longer be able to
--     see that endpoint, and may never have been able to see the other endpoint's source edge.
--
-- The function is created here because these triggers must exist atomically with the new columns.
-- migrate.ts CREATE OR REPLACEs the same function and reasserts its ACL on every migration run,
-- matching the repo's standing rule that a later function replacement must not restore PUBLIC
-- EXECUTE. Trigger invocation does not require cb_app to hold EXECUTE on the function.
--
-- EXPECTED doctor fixture changes (review as a security change; never rubber-stamp --update):
--   expected-policies.json       links_ws roles public -> cb_app; + links_hide_deleted and
--                                links_cycle_system
--   expected-grants.json         links loses UPDATE for cb_app
--   expected-column-grants.json  links loses every UPDATE cell; gains INSERT/SELECT cells for the
--                                two new deleted_at columns
--   expected-definers.json       + sync_link_security_state() and the three cycle link apertures,
--                                all postgres-owned with pinned search_path; the trigger function
--                                has no caller EXECUTE and the cycle functions grant cb_app only

SET LOCAL lock_timeout = '3s';

ALTER TABLE links
  ADD COLUMN from_deleted_at timestamptz,
  ADD COLUMN to_deleted_at   timestamptz;

-- Repair every pre-0022 row before the trigger takes responsibility for future writes. This also
-- repairs any acl drift caused by a rescope between 0021 and this migration.
UPDATE links l
SET from_acl        = fp.acl,
    to_acl          = tp.acl,
    from_deleted_at = fp.deleted_at,
    to_deleted_at   = tp.deleted_at,
    workspace_id    = fp.workspace_id
FROM pages fp, pages tp
WHERE fp.id = l.from_page_id
  AND tp.id = l.to_page_id
  AND fp.workspace_id = tp.workspace_id;

-- 0021 left these anonymous, so their generated names are not an API. Drop by definition and
-- replace them with stable names that doctor can assert.
DO $do$
DECLARE acl_check record;
BEGIN
  FOR acl_check IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.links'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) LIKE '%array_length(from_acl%'
        OR pg_get_constraintdef(oid) LIKE '%array_length(to_acl%'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.links DROP CONSTRAINT %I', acl_check.conname);
  END LOOP;
END
$do$;

ALTER TABLE links
  ADD CONSTRAINT links_from_acl_nonempty CHECK (cardinality(from_acl) >= 1),
  ADD CONSTRAINT links_to_acl_nonempty   CHECK (cardinality(to_acl) >= 1);

CREATE OR REPLACE FUNCTION cb_internal.sync_link_security_state() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  from_workspace uuid;
  to_workspace uuid;
  canonical_from_acl text[];
  canonical_to_acl text[];
  canonical_from_deleted_at timestamptz;
  canonical_to_deleted_at timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'links' THEN
    -- workspace_id is immutable and is needed only to choose the lock key. Canonical security state
    -- is read (again) after the lock, so a concurrent rescope/delete cannot leave a stale edge.
    SELECT p.workspace_id
      INTO from_workspace
      FROM public.pages p
      WHERE p.id = NEW.from_page_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'links.from_page_id does not reference a page';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('company-brain:links:' || from_workspace::text, 0)
    );

    SELECT p.workspace_id, p.acl, p.deleted_at
      INTO from_workspace, canonical_from_acl, canonical_from_deleted_at
      FROM public.pages p
      WHERE p.id = NEW.from_page_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'links.from_page_id does not reference a page';
    END IF;

    SELECT p.workspace_id, p.acl, p.deleted_at
      INTO to_workspace, canonical_to_acl, canonical_to_deleted_at
      FROM public.pages p
      WHERE p.id = NEW.to_page_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'links.to_page_id does not reference a page';
    END IF;

    IF from_workspace IS DISTINCT FROM to_workspace THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'link endpoints must belong to the same workspace';
    END IF;

    -- These assignments are the anti-spoofing boundary. RLS WITH CHECK runs on this canonical NEW
    -- row, so a caller cannot make an otherwise-hidden endpoint pass by supplying its own acl.
    NEW.workspace_id    := from_workspace;
    NEW.from_acl        := canonical_from_acl;
    NEW.to_acl          := canonical_to_acl;
    NEW.from_deleted_at := canonical_from_deleted_at;
    NEW.to_deleted_at   := canonical_to_deleted_at;
    RETURN NEW;
  END IF;

  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'pages' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('company-brain:links:' || NEW.workspace_id::text, 0)
    );

    UPDATE public.links
       SET from_acl = NEW.acl,
           from_deleted_at = NEW.deleted_at
     WHERE from_page_id = NEW.id;

    UPDATE public.links
       SET to_acl = NEW.acl,
           to_deleted_at = NEW.deleted_at
     WHERE to_page_id = NEW.id;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'sync_link_security_state attached to unexpected relation %.%',
    TG_TABLE_SCHEMA, TG_TABLE_NAME;
END
$fn$;

CREATE TRIGGER links_canonical_security
BEFORE INSERT OR UPDATE ON links
FOR EACH ROW EXECUTE FUNCTION cb_internal.sync_link_security_state();

CREATE TRIGGER pages_sync_link_security
AFTER UPDATE OF acl, deleted_at ON pages
FOR EACH ROW
WHEN (
  OLD.acl IS DISTINCT FROM NEW.acl
  OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
)
EXECUTE FUNCTION cb_internal.sync_link_security_state();

-- Keep the original workspace + two-endpoint-acl policy as the write/read tenancy boundary, but
-- scope it to the only role that has table access. Soft-delete visibility is a separate restrictive
-- SELECT-only policy for the same reason migration 0016 used that shape on pages/chunks: it must not
-- become a WITH CHECK condition that prevents the transition into the hidden state.
ALTER POLICY links_ws ON links TO cb_app;

CREATE POLICY links_hide_deleted ON links
  AS RESTRICTIVE FOR SELECT TO cb_app
  USING (from_deleted_at IS NULL AND to_deleted_at IS NULL);

-- The cycle context has no human self:* grants, by design. Give only the exact internal sentinel a
-- second permissive path for link reconciliation in its already-bound workspace. Ordinary callers
-- continue to be governed solely by links_ws; the restrictive deletion policy above still ANDs
-- with this policy for SELECT.
CREATE POLICY links_cycle_system ON links TO cb_app
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND NULLIF(current_setting('app.principal', true), '') =
        '00000000-0000-0000-0000-000000000000'
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND NULLIF(current_setting('app.principal', true), '') =
        '00000000-0000-0000-0000-000000000000'
  );

COMMENT ON COLUMN links.from_deleted_at IS
  'Denormalized copy of the source page deleted_at. Maintained by cb_internal.sync_link_security_state; links_hide_deleted requires NULL.';
COMMENT ON COLUMN links.to_deleted_at IS
  'Denormalized copy of the target page deleted_at. Maintained by cb_internal.sync_link_security_state; links_hide_deleted requires NULL.';
COMMENT ON POLICY links_hide_deleted ON links IS
  'Hide an edge when either endpoint is soft-deleted. RESTRICTIVE + FOR SELECT so deletion writes are not blocked by their own post-write visibility.';
COMMENT ON POLICY links_cycle_system ON links IS
  'Second permissive reconciliation path for the exact cycle system principal, confined to its tx-local app.workspace. Ordinary callers remain governed by links_ws.';

-- Reconciliation replaces a source's edge set with DELETE + INSERT. No production path updates an
-- edge in place, and leaving the broad grant from grantExisting() would expose every derived field
-- between migration completion and the runner's later posture-hardening pass. Revoke it in the same
-- transaction that installs the canonicalizing trigger, then let migrate.ts reassert this on every
-- subsequent run so a future GRANT cannot silently widen the table again.
REVOKE UPDATE ON links FROM cb_app;

-- The scheduled cycle uses a sentinel principal with only the workspace grant. Ordinary pages RLS
-- must therefore hide private pages from it, exactly as it would from a human workspace member.
-- This narrowly-scoped definer is the one read aperture the link phase needs: active pages in the
-- already-bound workspace, only for the exact system principal, in bounded keyset pages. No caller
-- can choose another workspace argument, and no human principal can invoke it successfully.
CREATE OR REPLACE FUNCTION cb_internal.cycle_link_pages(p_after uuid, p_limit int)
RETURNS TABLE (
  id uuid,
  slug text,
  title text,
  acl text[],
  body text,
  extracted_text text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  scoped_workspace uuid;
BEGIN
  IF NULLIF(current_setting('app.principal', true), '') IS DISTINCT FROM
     '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_link_pages is restricted to the cycle system principal';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'cycle_link_pages limit must be between 1 and 1000';
  END IF;

  scoped_workspace := NULLIF(current_setting('app.workspace', true), '')::uuid;
  IF scoped_workspace IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_link_pages requires a scoped workspace';
  END IF;

  RETURN QUERY
    SELECT p.id, p.slug, p.title, p.acl, p.body, p.extracted_text
    FROM public.pages p
    WHERE p.workspace_id = scoped_workspace
      AND p.deleted_at IS NULL
      AND (p_after IS NULL OR p.id > p_after)
    ORDER BY p.id
    LIMIT p_limit;
END
$fn$;

-- Re-read a bounded set of active target ACLs under the workspace link-advisory lock. There is no
-- target row lock: that creates a reciprocal-edge deadlock (A->B holds A then waits B while B->A
-- holds B then waits A). Page rescope/delete takes this same advisory lock in the page trigger, so
-- whichever transaction gets it first is followed by the other reading/propagating the latest state.
CREATE OR REPLACE FUNCTION cb_internal.cycle_link_page_acls(p_page_ids uuid[])
RETURNS TABLE (id uuid, acl text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  scoped_workspace uuid;
BEGIN
  IF NULLIF(current_setting('app.principal', true), '') IS DISTINCT FROM
     '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_link_page_acls is restricted to the cycle system principal';
  END IF;

  IF p_page_ids IS NULL OR cardinality(p_page_ids) < 1 OR cardinality(p_page_ids) > 1000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'cycle_link_page_acls requires between 1 and 1000 page ids';
  END IF;

  scoped_workspace := NULLIF(current_setting('app.workspace', true), '')::uuid;
  IF scoped_workspace IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_link_page_acls requires a scoped workspace';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('company-brain:links:' || scoped_workspace::text, 0)
  );

  RETURN QUERY
    SELECT p.id, p.acl
    FROM public.pages p
    WHERE p.workspace_id = scoped_workspace
      AND p.deleted_at IS NULL
      AND p.id = ANY(p_page_ids)
    ORDER BY p.id;
END
$fn$;

-- Source rows need the stronger lock: this serializes two reconciliations even when no edge exists
-- yet. Lock sources in id order FIRST, acquire the workspace advisory SECOND, then reread ACLs under
-- both locks. Target ACL reads take only the already-held/reentrant advisory, never a target row lock.
CREATE OR REPLACE FUNCTION cb_internal.cycle_lock_link_sources(p_page_ids uuid[])
RETURNS TABLE (id uuid, acl text[], body text, extracted_text text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  scoped_workspace uuid;
BEGIN
  IF NULLIF(current_setting('app.principal', true), '') IS DISTINCT FROM
     '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_lock_link_sources is restricted to the cycle system principal';
  END IF;

  IF p_page_ids IS NULL OR cardinality(p_page_ids) < 1 OR cardinality(p_page_ids) > 1000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'cycle_lock_link_sources requires between 1 and 1000 page ids';
  END IF;

  scoped_workspace := NULLIF(current_setting('app.workspace', true), '')::uuid;
  IF scoped_workspace IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_lock_link_sources requires a scoped workspace';
  END IF;

  -- PERFORM is intentional: acquire every source row lock before the workspace advisory. A second
  -- SELECT below returns security state only after both serialization layers are held.
  PERFORM p.id
  FROM public.pages p
  WHERE p.workspace_id = scoped_workspace
    AND p.deleted_at IS NULL
    AND p.id = ANY(p_page_ids)
  ORDER BY p.id
  FOR UPDATE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('company-brain:links:' || scoped_workspace::text, 0)
  );

  RETURN QUERY
    SELECT p.id, p.acl, p.body, p.extracted_text
    FROM public.pages p
    WHERE p.workspace_id = scoped_workspace
      AND p.deleted_at IS NULL
      AND p.id = ANY(p_page_ids)
    ORDER BY p.id;
END
$fn$;

REVOKE ALL ON FUNCTION cb_internal.sync_link_security_state() FROM PUBLIC, cb_app, cb_auth;
REVOKE ALL ON FUNCTION cb_internal.cycle_link_pages(uuid, int) FROM PUBLIC, cb_auth;
REVOKE ALL ON FUNCTION cb_internal.cycle_link_page_acls(uuid[]) FROM PUBLIC, cb_auth;
REVOKE ALL ON FUNCTION cb_internal.cycle_lock_link_sources(uuid[]) FROM PUBLIC, cb_auth;
GRANT EXECUTE ON FUNCTION cb_internal.cycle_link_pages(uuid, int) TO cb_app;
GRANT EXECUTE ON FUNCTION cb_internal.cycle_link_page_acls(uuid[]) TO cb_app;
GRANT EXECUTE ON FUNCTION cb_internal.cycle_lock_link_sources(uuid[]) TO cb_app;
