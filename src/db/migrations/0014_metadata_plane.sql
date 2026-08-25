-- M6 — the metadata plane: document provenance (effective_date, author, metadata), change-detection
-- (content_hash, chunker_version), and soft delete (deleted_at).
--
-- docs/pipeline-roadmap.md names this milestone explicitly as founder-approved and as a dependency of
-- M7 (recency ranking needs effective_date) and M9 (derived-knowledge tables must not silently orphan
-- on a hard delete) — nothing past it should start first.
--
-- EXPECTED doctor FIXTURE DIFF (review it as a security change; do NOT reflex --update):
--   expected-column-grants.json  + pages.{effective_date,effective_date_source,author,metadata,
--                                  content_hash,deleted_at} at cb_app's existing table-level DML
--                                  (18 rows: 6 columns x {INSERT,SELECT,UPDATE})
--                                + content_chunks.{effective_date,author,deleted_at,chunker_version}
--                                  at the same privileges (12 rows: 4 columns x 3)
--                                — automatic; grantExisting() already grants full DML on both tables,
--                                  so information_schema.role_column_grants enumerates every column
--                                  of an already-granted table with no explicit GRANT here.
--   expected-policies.json       pages_ws.qual and content_chunks_ws.qual EACH gain
--                                  "AND (deleted_at IS NULL)". with_check on BOTH must be
--                                  BYTE-IDENTICAL to before — see the asymmetry note below. If
--                                  `doctor --update` shows with_check moving too, this file is wrong.
-- Nothing else may move.
--
-- WHY with_check STAYS UNCHANGED, which is the one thing in this file worth reading twice:
-- Postgres checks USING against the OLD row and WITH CHECK against the NEW row on an UPDATE. If
-- WITH CHECK also required deleted_at IS NULL, the soft-delete statement itself
-- (`update pages set deleted_at = now() ...`) would fail its own check — the new row has a non-null
-- deleted_at BY CONSTRUCTION. So WITH CHECK is deliberately left as-is: any row a session can
-- currently see, it may soft-delete; the moment deleted_at is set, USING hides it from every
-- subsequent read, INCLUDING by the same session. There is no scoped-connection path back — restoring
-- a row inside the grace window is a deliberate admin-pool action (the same tier as running `doctor`
-- or `migrate`), and scripts/purge-deleted.ts hard-deletes it once the window elapses. A future
-- "simplification" that adds deleted_at to WITH CHECK to "match USING" would silently break every
-- soft-delete in the app — doctor.ts asserts the asymmetry directly (both directions) so this cannot
-- drift unnoticed.
--
-- CONTENT_HASH IS NOT source_sha256. source_sha256 (0009) hashes the ORIGINAL UPLOADED BYTES and
-- exists only on the file-ingest path, for pre-embed duplicate-upload detection (two partial unique
-- indexes enforce it). content_hash here hashes the EXTRACTED/BODY TEXT on BOTH ingest paths, has no
-- unique index, and has no consumer yet — a change-detection value for the future re-sync machinery
-- (docs/pipeline-roadmap.md M11), stamped now so it does not need a corpus-wide backfill later. Same
-- "ship inert, wire up later" shape as pages.compiled_truth.
--
-- effective_date_source is TEXT with no CHECK, deliberately, matching pages.source_format (0009) and
-- pages.kind (D86): it is validated at the op boundary (zod), so a new provenance source added by a
-- future ingest path (file metadata, M11's sync watcher) needs no migration.
--
-- metadata is an unstructured jsonb bag. Like source_meta (0009), it must never carry a third party's
-- identity without their consent — no scraped author/creator/lastModifiedBy fields; the op boundary
-- bounds its size (10KB) so it cannot become an unbounded write.
--
-- effective_date/author/deleted_at are DENORMALIZED onto content_chunks too, for the reason D4
-- already established for acl/tags: hybridSearch's arms scan content_chunks directly with RLS as the
-- SOLE scoper and no per-arm join to pages, so a since/until/author predicate (src/search/hybrid.ts)
-- or the deleted_at policy clause below needs the value on the row actually being scanned.
--
-- ALTER TABLE ... ADD COLUMN and ALTER POLICY both take AccessExclusiveLock. Same reasoning as
-- 0007:26 and 0009:19 — a bounded wait is the difference between a fast failure and a stalled deploy.
-- The runner wraps this file in one transaction, so SET LOCAL is correct and the whole file is atomic.
SET LOCAL lock_timeout = '3s';

-- ── 1. Document provenance and change detection ────────────────────────────
ALTER TABLE pages ADD COLUMN effective_date date;
ALTER TABLE pages ADD COLUMN effective_date_source text;
ALTER TABLE pages ADD COLUMN author text;
ALTER TABLE pages ADD COLUMN metadata jsonb;
ALTER TABLE pages ADD COLUMN content_hash text;
ALTER TABLE pages ADD COLUMN deleted_at timestamptz;

COMMENT ON COLUMN pages.effective_date IS 'When this document is ABOUT, not when it was uploaded — a contract''s signing date, a meeting''s date. NULL for legacy rows (predate this migration) and for a row whose ingest path did not supply one; a since/until search filter on a NULL row correctly excludes it, since its date is genuinely unknown rather than absent. New ingests default it to the upload date — see effective_date_source.';
COMMENT ON COLUMN pages.effective_date_source IS '''manual'' (the caller supplied effective_date at ingest) or ''upload_time'' (defaulted). TEXT with no CHECK, matching source_format (0009) and pages.kind (D86): validated at the op boundary so a new provenance source (file metadata, a sync watcher) needs no migration.';
COMMENT ON COLUMN pages.author IS 'Who WROTE the document, not who uploaded it (that is owner_principal) — a contract''s counsel, a meeting note''s author who was not the one who filed it. Free text, caller-supplied, NULL unless given.';
COMMENT ON COLUMN pages.metadata IS 'Unstructured bag for whatever does not warrant its own column. Bounded to 10KB at the op boundary (src/api/operations.ts). Never a third party''s identity without their consent — same rule as source_meta (0009).';
COMMENT ON COLUMN pages.content_hash IS 'SHA-256 of the extracted/body TEXT (src/ingest/sanity.ts contentHash(), reused on the byte-generic Uint8Array it already accepts), on BOTH ingest paths. NOT source_sha256 (0009), which hashes the original uploaded BYTES and exists only on the file path for pre-embed dedup. No unique index — this is a per-row equality check against a known row, not a dedup gate. No consumer yet; stamped now for docs/pipeline-roadmap.md M11''s re-sync change detection, the same "ship inert, wire up later" shape as compiled_truth.';
COMMENT ON COLUMN pages.deleted_at IS 'Soft delete. NULL means live. Set by delete_page/delete_pages (src/ingest/lifecycle.ts) instead of a hard DELETE, so the row survives for a purge grace window (scripts/purge-deleted.ts). Enforced at the RLS USING clause below, not in application code — see this file''s header for why WITH CHECK does not also gate on it.';

ALTER TABLE content_chunks ADD COLUMN effective_date date;
ALTER TABLE content_chunks ADD COLUMN author text;
ALTER TABLE content_chunks ADD COLUMN deleted_at timestamptz;
ALTER TABLE content_chunks ADD COLUMN chunker_version text;

COMMENT ON COLUMN content_chunks.effective_date IS 'Denormalized copy of pages.effective_date (D4''s reasoning: hybridSearch scans this table directly, RLS-scoped, with no per-arm join to pages). Kept in sync at ingest and at replace_page''s re-chunk; NOT re-derived by any query.';
COMMENT ON COLUMN content_chunks.author IS 'Denormalized copy of pages.author, for the same reason as effective_date above.';
COMMENT ON COLUMN content_chunks.deleted_at IS 'Denormalized copy of pages.deleted_at. UPDATE does not trigger ON DELETE CASCADE the way a hard delete does, so delete_page/delete_pages must set this explicitly alongside the parent row — see lifecycle.ts. A chunk whose acl has independently drifted out of the deleter''s scoped-tx reach will not be reached by that UPDATE; this is the same residual risk D76 already accepted for the read side of drift, not a new one, and bun run doctor''s existing chunk-acl-drift census would surface a chunk that drifted this way.';
COMMENT ON COLUMN content_chunks.chunker_version IS 'The value of CHUNKER_VERSION (src/ingest/chunk.ts) at the moment this chunk was produced. No consumer yet; for a future targeted re-chunk when the algorithm changes, instead of a blind full-corpus rebuild.';

-- ── 2. Soft-delete visibility, enforced in the policy ───────────────────────
-- ALTER, not DROP+CREATE (preserves `roles`, same reasoning as 0007).
ALTER POLICY pages_ws ON pages
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
    AND deleted_at IS NULL
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  );

ALTER POLICY content_chunks_ws ON content_chunks
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
    AND deleted_at IS NULL
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  );
