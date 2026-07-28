-- migrate:no-transaction
--
-- M3 review follow-up: give the new read paths indexes that actually serve them, and stop building
-- indexes under an exclusive lock.
--
-- WHY A NEW FILE AND NOT AN EDIT TO 0009: applied migrations are checksum-immutable (migrate.ts
-- refuses to run when an applied file's contents change). 0009 has already run, so every correction
-- to it lands here. That is the forward-only convention working as designed, not a workaround.
--
-- WHY no-transaction: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. The runner
-- honours the pragma above and executes this file's statements outside one, which means the file
-- CANNOT roll back as a unit — so every statement below is individually idempotent (IF EXISTS /
-- IF NOT EXISTS) and re-running after a partial failure is safe.
--
-- A failed CONCURRENTLY build leaves an INVALID index behind rather than nothing. The DROPs at the
-- top of each pair handle that: re-running this file drops the invalid leftover and rebuilds.
--
-- EXPECTED doctor FIXTURE DELTA: none. Indexes are not in any snapshot fixture (grants, policies,
-- column-grants, definers are). doctor.ts gains two indexdef assertions in the same change, which is
-- where an index that stops matching its query would otherwise go unnoticed — exactly how
-- idx_pages_title_prefix shipped dead.

-- ── 1. The title arm's index was the wrong KIND of index ─────────────────
--
-- 0009 shipped `(workspace_id, lower(title) text_pattern_ops)` — a btree — with a comment saying the
-- title arm "matches on lower(title)". It does not: src/search/hybrid.ts filters with
--     to_tsvector('english', coalesce(title,'')) @@ websearch_to_tsquery('english', $1)
-- and a btree can never answer a tsquery `@@` match. So the arm sequential-scanned `pages` and built
-- a tsvector per row on EVERY ask, while the index itself served nothing and cost two extra writes
-- per page insert and update. Pure write amplification.
--
-- Replaced with a GIN index on the exact expression the predicate uses. The expression must match
-- character-for-character or the planner will not use it, which is what the doctor assertion pins.
DROP INDEX IF EXISTS idx_pages_title_prefix;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_title_fts
  ON pages USING gin (to_tsvector('english', coalesce(title, '')));

COMMENT ON INDEX idx_pages_title_fts IS
  'Serves the title arm of hybrid search. The indexed expression must stay byte-identical to the predicate in src/search/hybrid.ts — doctor.ts asserts the indexdef for exactly that reason.';

-- ── 2. listPages had no index for its ordering ───────────────────────────
--
-- `order by updated_at desc, id` with RLS supplying the workspace predicate. Without this every call
-- sorts every visible page to return 50, and the op permits an offset up to 1,000,000.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_ws_updated
  ON pages (workspace_id, updated_at DESC, id);

COMMENT ON INDEX idx_pages_ws_updated IS
  'Serves list_pages ordering (updated_at desc, id) under the RLS workspace predicate, so LIMIT can stop early instead of sorting the whole tenant.';

-- ── 3. Slug lookup lost its index in 0007 ────────────────────────────────
--
-- 0007 dropped UNIQUE(workspace_id, slug) in favour of two PARTIAL unique indexes
-- (WHERE scope='workspace' / WHERE scope='private'). resolvePage's slug lookup in
-- src/ingest/lifecycle.ts does not mention scope, so the planner can prove neither partial
-- predicate and falls back to scanning the tenant's pages for every slug-addressed delete_page or
-- replace_page. Uniqueness stays with the two partial indexes; this one exists purely to be read.
--
-- (schema.sql:228's note that "UNIQUE(workspace_id, slug) already provides a workspace_id-leading
-- btree" became stale the moment 0007 dropped that constraint.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_ws_slug
  ON pages (workspace_id, slug);

COMMENT ON INDEX idx_pages_ws_slug IS
  'Non-unique read path for resolvePage(slug). Uniqueness lives in pages_ws_slug_shared / pages_ws_slug_private (0007), which are partial on scope and therefore unusable for a scope-less lookup.';
