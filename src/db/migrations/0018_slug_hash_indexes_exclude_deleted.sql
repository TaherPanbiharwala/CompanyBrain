-- migrate:no-transaction
--
-- Closes a real gap found in adversarial review of the M6 PR: the partial unique indexes enforcing
-- slug uniqueness (0007_acl_rls.sql) and source_sha256 dedup (0009_multiformat.sql) were never
-- updated to exclude soft-deleted rows. A soft-deleted page (migration 0014) still occupies its slug
-- and file-hash uniqueness slot even though RLS hides it from every read — so deleting a page and
-- then re-ingesting a new one with the SAME slug, or re-uploading the SAME file, deterministically
-- fails with 23505 -> already_exists, even though list_pages/get_page/search show nothing there.
-- Confirmed structurally: soft_delete_page/pages (src/db/migrate.ts) never touch scope, slug,
-- source_sha256 or owner_principal, and unique-index checks bypass RLS by design (0007's own
-- comment) — so nothing already in the system prevented this.
--
-- FIX: four new indexes, functionally identical except for the added `AND deleted_at IS NULL`,
-- under NEW names (matching 0013's own precedent of replacing idx_chunks_fts with idx_chunks_tsv
-- rather than juggling a same-name drop+recreate+rename, which would open a window with no
-- uniqueness enforced at all). Created BEFORE the old ones are dropped, so there is never a moment
-- with fewer constraints than before — same reasoning 0013 used for its own index swap. The two
-- ingest paths (src/ingest/import.ts, src/ingest/file.ts) that map 23505 by constraint_name to a
-- friendly error are updated in the SAME change to match the new names — done alongside this file
-- and not left for a follow-up, because until they are, this migration would silently turn a
-- friendly 409 for the common case (re-uploading a file, reusing a slug) back into a raw
-- internal_error for the NEW index names, exactly the failure D68/D73 were written to prevent.
--
-- WHY no-transaction: CREATE INDEX CONCURRENTLY and DROP INDEX CONCURRENTLY cannot run inside a
-- transaction block. IF NOT EXISTS / IF EXISTS make re-running after a partial failure safe.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pages_ws_slug_shared_live
  ON pages (workspace_id, slug) WHERE scope = 'workspace' AND deleted_at IS NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pages_ws_slug_private_live
  ON pages (workspace_id, owner_principal, slug) WHERE scope = 'private' AND deleted_at IS NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pages_sha_shared_live
  ON pages (workspace_id, source_sha256) WHERE scope = 'workspace' AND source_sha256 IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pages_sha_private_live
  ON pages (workspace_id, owner_principal, source_sha256) WHERE scope = 'private' AND source_sha256 IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX pages_ws_slug_shared_live IS 'Replaces pages_ws_slug_shared (0007): same uniqueness, plus AND deleted_at IS NULL so a soft-deleted page''s slug becomes reusable. Paired with pages_ws_slug_private_live.';
COMMENT ON INDEX pages_ws_slug_private_live IS 'Replaces pages_ws_slug_private (0007), same reasoning.';
COMMENT ON INDEX pages_sha_shared_live IS 'Replaces pages_sha_shared (0009): same uniqueness, plus AND deleted_at IS NULL so a soft-deleted page''s file hash becomes reusable. Paired with pages_sha_private_live.';
COMMENT ON INDEX pages_sha_private_live IS 'Replaces pages_sha_private (0009), same reasoning.';

DROP INDEX CONCURRENTLY IF EXISTS pages_ws_slug_shared;
DROP INDEX CONCURRENTLY IF EXISTS pages_ws_slug_private;
DROP INDEX CONCURRENTLY IF EXISTS pages_sha_shared;
DROP INDEX CONCURRENTLY IF EXISTS pages_sha_private;
