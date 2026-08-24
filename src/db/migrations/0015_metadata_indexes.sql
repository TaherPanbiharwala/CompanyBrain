-- migrate:no-transaction
--
-- The since/until search filter (src/search/hybrid.ts) needs an index on content_chunks.effective_date
-- correlated with workspace_id — CREATE INDEX CONCURRENTLY cannot run inside 0014's transaction, so
-- this is a separate file (same reasoning as 0013).
--
-- THIS IS A FIRST GUESS, NOT A VERIFIED ANSWER. 0013's own history is the reason to say so plainly:
-- the planner treats workspace_id = … and acl && current_grants() as INDEPENDENT when they are
-- PERFECTLY correlated (aclForScope stamps ws:<workspace_id>), and mis-estimated a 2,829-row result
-- as 10 — silently discarding a seemingly-relevant index. A since/until range predicate on
-- effective_date will be correlated with those same predicates the same way. Do not trust this index
-- without running `bun run explain:search` against a realistic corpus and reading the actual plan —
-- that is the discipline 0013 exists to demonstrate, not a formality to skip because the reasoning
-- above sounds plausible.
--
-- WHY no-transaction: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. IF NOT EXISTS
-- makes re-running after a partial failure safe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chunks_ws_effdate
  ON content_chunks (workspace_id, effective_date)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_chunks_ws_effdate IS 'Candidate index for the since/until search filter (src/search/hybrid.ts). Unverified against a realistic corpus — see this file''s header before trusting it.';
