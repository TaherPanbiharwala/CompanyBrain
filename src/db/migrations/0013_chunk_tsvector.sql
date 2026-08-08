-- migrate:no-transaction
--
-- The keyword arm recomputed to_tsvector AT QUERY TIME, on every visible chunk, three times over.
-- This stores it once at write time instead.
--
-- ── THE MEASUREMENT ──────────────────────────────────────────────────────
--
-- `bun run explain:search --workspace "multihop eval (plain)"` against 609 pages / 2,829 chunks,
-- EXPLAIN (ANALYZE, BUFFERS) on the statement src/search/hybrid.ts actually sends:
--
--   Limit                                          3,812ms total
--     CTE kw_split                                 3,712ms   <- 97% of the statement
--       Bitmap Heap Scan on content_chunks         3,710ms
--         Recheck Cond: acl && … AND workspace_id = …
--         Filter: to_tsvector('english', content) @@ '…'::tsquery
--         Rows Removed by Filter: 1771             (2,829 rows in, 1,058 out)
--     vec  (HNSW arm)                                 40ms
--     title (pages arm)                               16ms
--
-- And the arms probed one operation at a time (each probe a strict subset of one CTE):
--
--   @@ membership test only                        2,084ms
--   + ts_rank_cd over the survivors                2,910ms   (+826ms)
--   + the and_tier plainto_tsquery match           3,709ms   (+799ms)
--   vector arm                                        24ms
--   title arm                                         16ms
--
-- ── WHAT THE PLAN SHOWS THAT THE HYPOTHESIS DID NOT ──────────────────────
--
-- The suspicion going in was that idx_chunks_fts (migration 0006) served the `@@` filter and simply
-- could not serve the rank, leaving ts_rank_cd to recompute the tsvector. The plan refutes the first
-- half: **idx_chunks_fts does not appear in the plan at all.** The planner bitmap-ANDs
-- idx_chunks_acl and idx_chunks_ws, estimates the result at 10 rows, and applies the full-text match
-- as a recheck FILTER on what is actually the entire workspace — 2,829 rows.
--
-- The estimate is wrong for a structural reason worth writing down, because it will not improve on
-- its own: `acl && (SELECT current_grants())` and `workspace_id = (SELECT …)` are two predicates the
-- planner treats as independent, and they are perfectly correlated — aclForScope stamps
-- `ws:<workspace_id>`, so every row matching one matches the other. Two "selective" predicates
-- multiply to an estimate of 10 where the truth is 2,829, and against a 10-row estimate no index is
-- worth adding to the BitmapAnd. 0006 predicted the right failure ("computed for every row in the
-- workspace on every question — twice per row") and the wrong cause; the index it added has never
-- been read.
--
-- So the cost is ~5,000 to_tsvector calls at ~0.75ms each, and NOT the ranking function specifically.
-- That distinction decides the fix: capping MAX_TERMS or swapping ts_rank_cd for something cheaper
-- would each have left the 2,084ms membership test — the single largest term — exactly where it was.
--
-- ── THE FIX, AND ITS RECALL COST (NONE) ──────────────────────────────────
--
-- A STORED generated column holds the same value the expression computed, so `content_tsv` is
-- byte-identical to `to_tsvector('english', content)` for every row, and the arm keeps matching and
-- ranking precisely what it matched and ranked before. This changes WHEN the tsvector is computed,
-- never WHAT it contains — no term is dropped, no ranking function is swapped, no threshold moves.
-- test/hybrid.test.ts re-derives the arms from `to_tsvector('english', c.content)` in TypeScript and
-- asserts equality with the shipped SQL; leaving that test spelled the old way is deliberate, since
-- it now independently proves the stored column and the computed expression agree.
--
-- 'english' is a literal here exactly as in 0006, which is what makes to_tsvector immutable and the
-- column legal at all. The two-argument form with a non-constant regconfig is only STABLE, and
-- Postgres rejects a STABLE expression in a generated column.
--
-- ── COST OF APPLYING IT ──────────────────────────────────────────────────
--
-- ADD COLUMN … GENERATED … STORED REWRITES THE TABLE under ACCESS EXCLUSIVE. At 5,852 rows / 108MB
-- that is seconds, and this database has no traffic to block. State it plainly rather than bury it:
-- on a table large enough for the rewrite to matter, the non-blocking form of this change is a
-- nullable column plus a trigger plus a batched backfill, and it is a different migration.
--
-- WHY no-transaction: CREATE INDEX CONCURRENTLY and DROP INDEX CONCURRENTLY cannot run inside a
-- transaction block. The file therefore CANNOT roll back as a unit, so every statement below is
-- individually idempotent and re-running after a partial failure is safe.
--
-- EXPECTED doctor FIXTURE DELTA: test/fixtures/expected-column-grants.json gains the rows
-- information_schema derives for content_chunks.content_tsv from the EXISTING table-level grants to
-- cb_app. No GRANT is issued here and no privilege widens — a new column on an already-granted table
-- is enumerated by that view, which is why the snapshot moves at all. Nothing else may move; review
-- it, do not reflex --update. doctor.ts's index assertion moves from idx_chunks_fts to
-- idx_chunks_tsv in the same change, and gains a check on the generated expression itself.

-- ── 1. The column ────────────────────────────────────────────────────────
ALTER TABLE content_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

COMMENT ON COLUMN content_chunks.content_tsv IS
  'The keyword arm''s tsvector, computed at write time. GENERATED ALWAYS, so it cannot drift from content and no ingest path has to remember it. src/search/hybrid.ts must read THIS column — reverting the arm to to_tsvector(''english'', content) restores a 3.7s query without erroring.';

-- ── 2. The index that will actually be read ──────────────────────────────
--
-- Created BEFORE the old one is dropped, so there is no window in which the keyword arm has no index
-- available to it.
--
-- Worth being honest about what this index buys given the row-estimate problem above: the planner may
-- STILL prefer the acl+ws BitmapAnd and apply `content_tsv @@ query` as a filter. That is now fine.
-- The filter has become a tsvector comparison against a stored value instead of a parse-and-stem of
-- the chunk text, which is the three orders of magnitude. The index is here so the better plan is
-- available when the estimate is good enough to choose it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chunks_tsv
  ON content_chunks USING gin (content_tsv);

COMMENT ON INDEX idx_chunks_tsv IS
  'Backs the keyword arm of hybridSearch, on the STORED content_tsv column (0013). Replaces idx_chunks_fts, which indexed the equivalent expression and was never chosen by the planner.';

-- ── 3. Drop the expression index it replaces ─────────────────────────────
--
-- Not left in place "just in case": it costs ~8MB and a full to_tsvector on every chunk INSERT, and
-- the generated column already pays that computation once. Keeping both would pay it twice per write
-- to serve a query path that no longer exists.
DROP INDEX CONCURRENTLY IF EXISTS idx_chunks_fts;
