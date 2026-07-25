-- M1+M2 review follow-up (P2): integrity constraints the baseline schema left implicit.
--
-- Each one below is a property the CODE already relies on and the DATABASE did not enforce. That gap
-- is the recurring shape of this review: a rule stated in a comment, honoured by the one writer that
-- exists today, and unenforced against the writer that arrives next.
--
-- Verified against the live corpus before writing this file (12 pages, 0 duplicate (page_id, ord),
-- 0 NULL embeddings), so every constraint here applies to existing data without a backfill.

-- ── 1. Chunk order is a KEY within a page, not a hint ────────────────────
--
-- `ORDER BY ord` is how the read path reassembles a page, and duplicate ords make that order
-- nondeterministic — the same page renders differently on two requests, with nothing to point at.
-- idx_chunks_page already covered (page_id, ord); making it UNIQUE turns the index that serves the
-- query into the constraint that guarantees it, rather than carrying two indexes on one column pair.
DROP INDEX idx_chunks_page;
CREATE UNIQUE INDEX idx_chunks_page ON content_chunks (page_id, ord);
COMMENT ON COLUMN content_chunks.ord IS
  'Chunk order within the page, 0-based and CONTIGUOUS. UNIQUE per page (idx_chunks_page): the read path reassembles by ORDER BY ord, which is only deterministic if no two chunks share one.';

-- ── 2. Deleting a person must not require deleting their history ─────────
--
-- Three FKs to principals carried the default NO ACTION: workspaces.created_by, invites.invited_by,
-- invites.accepted_by. Every other principal FK in the schema is ON DELETE CASCADE because the row IS
-- the membership. These three are different in kind — they are ATTRIBUTION ("who did this"), the
-- column is nullable, and the workspace or invite outlives the person.
--
-- As written, deleting a principal fails with a foreign-key violation unless you first delete every
-- workspace they created. That makes account deletion (M5, and a GDPR erasure request before then)
-- structurally impossible without destroying other tenants' data. SET NULL keeps the workspace and
-- the invite trail while dropping the link to the erased person, which is exactly what the columns
-- being nullable already anticipated.
ALTER TABLE workspaces DROP CONSTRAINT workspaces_created_by_fkey;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES principals(id) ON DELETE SET NULL;

ALTER TABLE invites DROP CONSTRAINT invites_invited_by_fkey;
ALTER TABLE invites ADD CONSTRAINT invites_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES principals(id) ON DELETE SET NULL;

ALTER TABLE invites DROP CONSTRAINT invites_accepted_by_fkey;
ALTER TABLE invites ADD CONSTRAINT invites_accepted_by_fkey
  FOREIGN KEY (accepted_by) REFERENCES principals(id) ON DELETE SET NULL;

-- ── 3. The one FK in the schema without a covering index ─────────────────
--
-- workspace_domain_blocks' PK is (workspace_id, principal_id), so the leading column is indexed and
-- principal_id is not. Its FK is ON DELETE CASCADE, and an unindexed CASCADE target means every
-- principal deletion sequentially scans this table. Every other principal FK here has a partner index
-- (idx_workspace_members_principal, idx_sessions_principal, idx_team_memberships_principal); this one
-- was added in 0002 without it.
CREATE INDEX idx_domain_blocks_principal ON workspace_domain_blocks (principal_id);

-- ── 4. Two COMMENTs that promise more than the schema delivers ───────────
--
-- Deliberately NOT converted into CHECK/NOT NULL constraints — both would close an extension point
-- the design opened on purpose. What is wrong is the prose, so the prose is what changes.
--
-- pages.kind: the five-value list reads like a closed taxonomy, but the table comment says "kind is
-- TEXT never an enum" (so OKF types can be added without a migration) AND no code path writes it —
-- all 12 live pages are 'note' because nothing but the DDL default has ever set it.
COMMENT ON COLUMN pages.kind IS
  'Intended OKF-aligned pack type (person|company|project|process|note). TEXT and deliberately UNCONSTRAINED so a new type needs no migration — the list is a convention, not a CHECK. Nothing writes it yet: every page takes the DDL default until the ingest op exposes it.';

-- content_chunks.embedding: nullable, and the vector arm previously ordered by distance without
-- excluding NULLs. Kept nullable so an "ingest now, embed in a background job" design stays possible;
-- the read path now filters explicitly (src/search/hybrid.ts) instead of relying on NULLs sorting
-- last, which is a property of the ORDER BY direction rather than an intended guarantee.
COMMENT ON COLUMN content_chunks.embedding IS
  'OpenAI text-embedding-3-small, 1536 dims (DECISIONS D13). Fixed dim; changing it is a fleet re-embed (see Migration conventions). NULLABLE on purpose (deferred/background embedding stays possible); the vector arm filters `embedding IS NOT NULL` rather than depending on NULL ordering.';
