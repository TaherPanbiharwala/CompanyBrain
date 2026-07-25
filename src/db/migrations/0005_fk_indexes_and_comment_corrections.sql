-- Corrections to 0003 and 0004, found by an adversarial review of the uncommitted diff BEFORE it was
-- committed. Both of those files are already applied and therefore checksum-immutable, so — exactly
-- as 0003 did for schema.sql — a later migration is the only channel through which their persisted
-- COMMENTs can be corrected. Their inline `--` comments cannot be corrected at all; the record of
-- what they got wrong lives here and in DECISIONS D61.

-- ── 1. The FK covering indexes 0004 claimed were already complete ─────────
--
-- 0004's section 3 is headed "The one FK in the schema without a covering index" and asserts that
-- "every other principal FK here has a partner index". Both claims are false, and the second is
-- false partly BECAUSE of 0004 itself:
--
--  * acl_grants.principal_id (schema.sql:146) is ON DELETE CASCADE and the table's only index is
--    UNIQUE (workspace_id, principal_id, grant_tag) — principal_id is not the leading column, so it
--    cannot serve a principal-keyed referential-integrity lookup. acl_grants has no other index at
--    all. It was simply missed.
--  * workspaces.created_by, invites.invited_by and invites.accepted_by are the three FKs 0004 itself
--    converted to ON DELETE SET NULL. SET NULL requires the same referencing-side scan CASCADE does,
--    so 0004 created three new unindexed delete paths in the very section whose stated purpose was
--    to make `DELETE FROM principals` possible for M5 account deletion / erasure requests.
--
-- The net effect of 0004 alone: deleting one principal sequentially scans four tables. This file
-- closes all four so the claim is true rather than merely written down.
CREATE INDEX idx_acl_grants_principal ON acl_grants (principal_id);
CREATE INDEX idx_workspaces_created_by ON workspaces (created_by);
CREATE INDEX idx_invites_invited_by ON invites (invited_by);
CREATE INDEX idx_invites_accepted_by ON invites (accepted_by);

-- ── 2. content_chunks.ord — the constraint is right, its justification was not ──
--
-- 0004 made (page_id, ord) UNIQUE and wrote a COMMENT stating that "the read path reassembles by
-- ORDER BY ord". No such read path exists: `ORDER BY ord` appears nowhere in src/ (hybridSearch
-- orders by ts_rank_cd and by vector distance; nothing reassembles a page from its chunks yet).
--
-- The UNIQUE constraint stays — contiguous 0-based ord IS what importPage writes, idx_chunks_page
-- exists to serve that ordering when a reader is written, and a duplicate ord would make any future
-- reassembly nondeterministic. But the COMMENT is what an operator reads in psql, and it asserted a
-- present-tense fact about code that has not been written. Stated as the invariant it actually is.
COMMENT ON COLUMN content_chunks.ord IS
  'Chunk order within the page: 0-based, contiguous, and UNIQUE per page (idx_chunks_page). This is an INGEST invariant — importPage assigns it — not yet a read-path dependency; nothing reassembles a page from its chunks at M2. The constraint exists so that when a reader is written, ORDER BY ord is deterministic.';

-- ── 3. principals — google_sub is NOT written only by the definer ─────────
--
-- 0003 persisted: "google_sub is written ONLY by cb_internal.adopt_principal, whose `google_sub IS
-- NULL` guard lives in the database so no application role holds UPDATE on it."
--
-- The second half is true and load-bearing. The first half is false: src/auth/workspaces.ts:70 has
-- cb_auth INSERT google_sub directly on first login (`insert into principals (google_sub, email,
-- email_normalized, name) ... on conflict (google_sub) do update`). The definer's guard governs the
-- ADOPT path — binding a Google account to a pre-existing placeholder row — which is the dangerous
-- one, because that is where an attacker would try to attach their sub to somebody else's row.
--
-- Precision matters here more than most places: this comment is what tells an operator which writes
-- are database-guarded. "Only the definer writes it" invites the conclusion that the INSERT path is
-- guarded too, and it is not — it is safe for a different reason (a fresh row, keyed on a sub Google
-- just verified).
COMMENT ON TABLE principals IS
  'Global person identity (one row per human, spanning workspaces). Created and profile-refreshed by the cb_auth role during login/onboarding, which INSERTs google_sub directly for a new principal. UPDATEs to google_sub — the adopt path, binding a Google account to a pre-existing placeholder row — go only through cb_internal.adopt_principal, whose `google_sub IS NULL` guard lives in the database so no application role holds UPDATE on the column.';
