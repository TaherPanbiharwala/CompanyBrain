-- 0021_link_extraction.sql — M9 wave 1: link extraction + backlinks.
--
-- WHY: docs/pipeline-roadmap.md M9. Zero-LLM, regex/mention-based edges between pages in the same
-- workspace. Directional (from_page_id -> to_page_id): "from" is where the reference text was
-- found, "to" is the page it names. Backlinks (getBacklinks) are NOT materialized — an indexed
-- SELECT ... WHERE to_page_id = $1 does the job, same as gbrain's own precedent (backlinks are a
-- read, not a table).
--
-- ACL SHAPE: this table is content-adjacent, not system bookkeeping (unlike migration 0020's five
-- tables). DECISIONS D4 already committed `links` to carrying denormalized workspace_id + acl,
-- never transitive via page_id — written 2026-07-23, before this table's actual schema existed.
-- What D4 left open: an edge has TWO endpoints, and a single acl array can only express OR-visibility
-- ("holds any of these tags") — it cannot express "visible only if the caller holds grants
-- overlapping BOTH endpoints' acl," which is the correct security property for a row that reveals
-- two pages relate to each other. Two columns (from_acl, to_acl), each required to overlap the
-- caller's grants in RLS — an AND of two overlap tests, never one test against a merged array — is
-- what makes that conjunction possible while reusing the exact `acl && current_grants()` primitive
-- already proven on pages/content_chunks. Since to_page_id is always resolved via an RLS-scoped
-- SELECT against pages before insert (src/core/links/reconcile.ts), to_acl is guaranteed to already
-- overlap the writer's grants — WITH CHECK can never be violated by the extraction path itself.
--
-- NO deleted_at ON THIS TABLE — a deliberate divergence from the M6-established "denormalize
-- deleted_at onto every content-adjacent table" pattern (content_chunks needed it because
-- hybridSearch reads it directly with no join to pages). Every read this migration's table serves
-- (getBacklinks, the graph-expansion retrieval arm) always joins through pages/content_chunks to
-- render anything useful (a raw edge with no slug/title is useless to a caller) — an INNER JOIN
-- against their existing pages_hide_deleted/content_chunks_hide_deleted RESTRICTIVE policies already
-- drops soft-deleted edges for free, with no extra column and no extra write at delete time.
--
-- No manual GRANT needed — migrate.ts's grantExisting() grants full DML to cb_app on every table
-- automatically (same note migration 0020's header makes). No cb_auth access.
SET LOCAL lock_timeout = '3s';

CREATE TABLE links (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_page_id uuid        NOT NULL,
  to_page_id   uuid        NOT NULL,
  from_acl     text[]      NOT NULL,
  to_acl       text[]      NOT NULL,
  link_kind    text        NOT NULL CHECK (link_kind IN ('mention', 'markdown')),
  link_source  text        NOT NULL,
  context      text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_page_id <> to_page_id),
  CHECK (array_length(from_acl, 1) >= 1),
  CHECK (array_length(to_acl, 1) >= 1),
  UNIQUE (from_page_id, to_page_id, link_kind, link_source),
  -- Composite FK, same shape as content_chunks -> pages (D4's "structurally impossible mis-stamped
  -- tenant" pattern): a link's workspace_id must equal BOTH endpoint pages' workspace_id. Cascades
  -- on hard delete (scripts/purge-deleted.ts), so a purged page's edges never orphan.
  FOREIGN KEY (from_page_id, workspace_id) REFERENCES pages (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (to_page_id, workspace_id)   REFERENCES pages (id, workspace_id) ON DELETE CASCADE
);

COMMENT ON TABLE  links IS 'Directional page-to-page edge, extracted by regex/title-mention (zero LLM cost) from pages.body/extracted_text. from_page_id is where the reference was found; to_page_id is the page it names. Backlinks = SELECT ... WHERE to_page_id, not a separate table.';
COMMENT ON COLUMN links.from_page_id IS 'The page whose content produced this edge.';
COMMENT ON COLUMN links.to_page_id IS 'The page referenced. Resolved only against pages the extractor could already SELECT under RLS, so to_acl is guaranteed to overlap the writer''s grants at insert time.';
COMMENT ON COLUMN links.from_acl IS 'Denormalized copy of the source page''s acl. GIN-indexed; RLS requires this to overlap the caller''s grants.';
COMMENT ON COLUMN links.to_acl IS 'Denormalized copy of the target page''s acl. GIN-indexed; RLS requires this to ALSO overlap the caller''s grants — an edge is visible only to someone who can see both endpoints.';
COMMENT ON COLUMN links.link_kind IS 'mention: source text contains another page''s title/slug, matched with word boundaries. markdown: [text](href) whose href, after normalization, matches another page''s slug in the same workspace. No other kinds in wave 1 (no wikilinks, no URL-identity matching — pages have no canonical URL column).';
COMMENT ON COLUMN links.link_source IS 'The matched text (the title/slug string for a mention, the raw href for a markdown link). Part of the uniqueness key so re-matching the same reference on re-extraction is a no-op, not a duplicate.';
COMMENT ON COLUMN links.context IS 'Short excerpt (~240 chars) around the match. Empty string is valid (never NULL) but should not be routinely empty — a future compiled_truth synthesis milestone is expected to read this column for grounding excerpts (not wired yet), so it carries real text now even though nothing consumes it this milestone.';

CREATE INDEX idx_links_from ON links (from_page_id);
CREATE INDEX idx_links_to   ON links (to_page_id);
CREATE INDEX idx_links_ws   ON links (workspace_id);
CREATE INDEX idx_links_from_acl ON links USING gin (from_acl);
CREATE INDEX idx_links_to_acl   ON links USING gin (to_acl);

ALTER TABLE links ENABLE ROW LEVEL SECURITY;
CREATE POLICY links_ws ON links
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND from_acl && (SELECT public.current_grants())
    AND to_acl && (SELECT public.current_grants())
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND from_acl && (SELECT public.current_grants())
    AND to_acl && (SELECT public.current_grants())
  );
