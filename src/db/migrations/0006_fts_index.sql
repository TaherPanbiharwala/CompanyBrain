-- The keyword arm's index, deferred since A17 (D51c) and now due.
--
-- hybridSearch's keyword arm filters AND ranks on `to_tsvector('english', c.content)`. With no index
-- that expression is computed for every row in the workspace on every question — twice per row, once
-- for the @@ match and once for ts_rank_cd. At A17's 14-chunk corpus that is unmeasurable, which is
-- exactly why it stayed deferred; it becomes the whole cost of the arm at any real corpus size.
--
-- The expression here must match the one in the query CHARACTER FOR CHARACTER or the planner will not
-- use the index — same 'english' regconfig, same column. If you change either, change both.
-- ('english' as a literal makes to_tsvector immutable, which is what allows the expression index at
-- all; the two-argument form with a non-constant config is only stable.)
CREATE INDEX idx_chunks_fts ON content_chunks USING gin (to_tsvector('english', content));

COMMENT ON INDEX idx_chunks_fts IS
  'Backs the keyword arm of hybridSearch. The indexed expression must stay identical to the one in src/search/hybrid.ts — a mismatch does not error, it silently falls back to a sequential scan.';
