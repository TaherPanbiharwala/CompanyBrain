-- Closes a real gap in migration 0014/0016: soft delete (deleted_at) was added to `pages` and
-- `content_chunks` only. `page_sources` — the table holding the ORIGINAL UPLOADED FILE BYTES (D71) —
-- got no `deleted_at` column and no hide-deleted policy, so after delete_page/delete_pages the file
-- itself stayed fully live and RLS-readable under its original acl, indefinitely, contradicted by
-- src/ingest/lifecycle.ts's own DeletePageResult comment claiming "immediately unreadable through
-- every existing path." Found in adversarial review of the M6 PR, confirmed against the live schema
-- and the definer function bodies before writing this file.
--
-- Same shape as 0014/0016, applied to the one table they missed: a `deleted_at` column plus a
-- separate RESTRICTIVE, FOR SELECT-only policy (not a clause on page_sources_ws's FOR ALL policy) —
-- see 0016's header for why a FOR ALL policy cannot let an UPDATE's new-row check diverge from what
-- SELECT requires of the same row. `cb_internal.soft_delete_page`/`soft_delete_pages` (src/db/migrate.ts)
-- are updated in the same change to also mark this table; scripts/purge-deleted.ts needs no change —
-- its real DELETE already reaps page_sources via the composite FK's ON DELETE CASCADE (0009).
--
-- No grant-matrix change needed: `narrowGrants()` already runs
-- `revoke update on page_sources from cb_app` TABLE-WIDE (not column-scoped, see migrate.ts:380-381),
-- so the new column inherits that revoke automatically — cb_app could never UPDATE deleted_at
-- directly, only the SECURITY DEFINER function (running as owner) can.
--
-- EXPECTED doctor FIXTURE DIFF (review as a security change; do NOT reflex --update):
--   expected-column-grants.json  + page_sources.deleted_at at cb_app's existing privileges
--                                  (3 rows: INSERT/SELECT/UPDATE — automatic, no GRANT issued here)
--   expected-policies.json       + page_sources_hide_deleted — RESTRICTIVE, FOR SELECT,
--                                  qual "(deleted_at IS NULL)", with_check "(none)"
--                                page_sources_ws stays BYTE-IDENTICAL to its 0009 form.
-- Nothing else may move.
SET LOCAL lock_timeout = '3s';

ALTER TABLE page_sources ADD COLUMN deleted_at timestamptz;

COMMENT ON COLUMN page_sources.deleted_at IS 'Soft delete, mirroring pages.deleted_at/content_chunks.deleted_at (migration 0014). Set by cb_internal.soft_delete_page/soft_delete_pages in the SAME statement that marks the parent page, so a file cannot outlive its page''s visibility. Enforced by the page_sources_hide_deleted RESTRICTIVE policy below, not by page_sources_ws — see that policy''s comment for why.';

CREATE POLICY page_sources_hide_deleted ON page_sources
  AS RESTRICTIVE FOR SELECT
  USING (deleted_at IS NULL);

COMMENT ON POLICY page_sources_hide_deleted ON page_sources IS
  'Soft-delete visibility (migration 0014 should have included this table; 0017 closes the gap). RESTRICTIVE + FOR SELECT so it never applies to UPDATE/INSERT/DELETE, the same reasoning as pages_hide_deleted/content_chunks_hide_deleted (0016). ANDs with page_sources_ws for reads only.';
