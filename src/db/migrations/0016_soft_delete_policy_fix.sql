-- Corrects 0014_metadata_plane.sql's RLS design: a single FOR ALL policy cannot have USING and
-- WITH CHECK diverge for UPDATE the way 0014 assumed.
--
-- MEASURED, not theorized. A real cb_app-scoped `update pages set deleted_at = now() where id = ...`
-- (no RETURNING, so 0007's documented RETURNING-visibility behavior is not the cause either) failed
-- with `42501 new row violates row-level security policy for table "pages"`, even though pages_ws's
-- with_check text — read directly from pg_policy, not just the fixture — never mentions deleted_at.
-- An identical UPDATE to an unrelated column (title) on the same row, same session, succeeded. So for
-- a FOR ALL (cmd=*) policy, Postgres does not let an UPDATE's new-row check diverge from what SELECT
-- would require of the same row — the two are coupled in a way one policy's independently-declared
-- USING/WITH CHECK cannot express, whatever the two clauses' text says.
--
-- FIX: revert pages_ws/content_chunks_ws to their PRE-0014 qual (byte-identical to what 0007
-- shipped — no deleted_at), and add deleted_at IS NULL as a SEPARATE, RESTRICTIVE, FOR SELECT-ONLY
-- policy instead. Restrictive policies AND with the result of permissive ones, and — the property
-- that makes this work — are scoped per-command via FOR, so a FOR SELECT restrictive policy adds no
-- clause anywhere an UPDATE's WITH CHECK has to satisfy; it is invisible to UPDATE/INSERT/DELETE
-- entirely. Verified against the live cb_app path before writing this file: with this shape the same
-- UPDATE succeeds, and a subsequent scoped SELECT for the same id returns nothing.
--
-- EXPECTED doctor FIXTURE DIFF (review as a security change; do NOT reflex --update):
--   expected-policies.json   pages_ws.qual and content_chunks_ws.qual LOSE the "AND (deleted_at IS
--                              NULL)" conjunct 0014 added — reverting to exactly their 0007 form.
--                            + two NEW policy rows: pages_hide_deleted, content_chunks_hide_deleted —
--                              permissive: "RESTRICTIVE", cmd: "SELECT", qual: "(deleted_at IS NULL)",
--                              with_check: "(none)" (SELECT has no WITH CHECK concept).
-- doctor.ts's own M6 checks (added alongside 0014) are updated in the SAME change as this migration —
-- they originally assumed the deleted_at clause would live on the same %_ws policy row, which this
-- file makes untrue.
--
-- ALTER POLICY takes AccessExclusiveLock, same reasoning as every prior RLS migration in this repo.
SET LOCAL lock_timeout = '3s';

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

CREATE POLICY pages_hide_deleted ON pages
  AS RESTRICTIVE FOR SELECT
  USING (deleted_at IS NULL);

CREATE POLICY content_chunks_hide_deleted ON content_chunks
  AS RESTRICTIVE FOR SELECT
  USING (deleted_at IS NULL);

COMMENT ON POLICY pages_hide_deleted ON pages IS
  'Soft-delete visibility (migration 0014, corrected by 0016). RESTRICTIVE + FOR SELECT so it never applies to UPDATE/INSERT/DELETE — folding this into pages_ws as one FOR ALL policy could not let UPDATE diverge from it (see this migration''s header). ANDs with pages_ws for reads only.';
COMMENT ON POLICY content_chunks_hide_deleted ON content_chunks IS
  'Same reasoning as pages_hide_deleted.';
