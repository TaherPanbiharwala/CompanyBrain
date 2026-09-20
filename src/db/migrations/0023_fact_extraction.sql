-- 0023_fact_extraction.sql — M10 wave 1, sub-step A: the facts substrate.
--
-- A `facts` row is a single, typed, LLM-extracted claim about an entity, sourced from exactly one
-- page. Single-parent (one source_page_id), so this follows the 0014/0016 denormalized-acl +
-- restrictive-hide-deleted shape used by content_chunks, NOT 0021/0022's two-endpoint edge-trigger
-- shape (which exists specifically because a `links` row has TWO endpoints whose visibility must be
-- ANDed; a fact has one).
--
-- ONLY THE CYCLE SYSTEM PRINCIPAL EVER INSERTS A FACT. Unlike links (whose ordinary ingest-time hook
-- legitimately writes under a caller's own request context), fact extraction is exclusively a cycle
-- phase — there is no synchronous per-write fact extraction in this milestone, and no `create_fact`
-- operation exists for an ordinary caller to invoke. So `facts_ws`, unlike `content_chunks_ws` or
-- `pages_ws`, is deliberately FOR SELECT only: an ordinary member can never satisfy any permissive
-- INSERT policy on this table (only `facts_cycle_system` covers INSERT, gated on the exact sentinel
-- principal), even though cb_app holds the table-level INSERT grant every role needs for the sentinel
-- to succeed at all (GRANT is per-ROLE; the sentinel and an ordinary member share the cb_app role, so
-- the split has to happen in RLS, not in GRANT). Without this, `facts_ws` shaped like
-- `content_chunks_ws` (FOR ALL, WITH CHECK acl && grants) would let an ordinary member INSERT a
-- fabricated fact row — any acl overlapping their own grants, any source_page_id in the workspace,
-- including a private page they cannot otherwise read — because nothing here canonicalizes a
-- caller-supplied acl the way `sync_link_security_state` does for links. `facts` is meant to be an
-- audit trail of what the extraction phase actually read, not a channel an ordinary member can inject
-- into it.
--
-- The one ordinary-caller write this migration allows is the acl side of a page rescope
-- (`rescopePages`, src/ingest/lifecycle.ts), mirroring how `content_chunks.acl` is kept in sync today
-- — an ordinary UPDATE under RLS, not a SECURITY DEFINER bypass. It is narrowed to the `acl` column
-- alone via a column-level GRANT (below), so a caller who can satisfy `facts_rescope`'s WITH CHECK can
-- still only ever move the acl forward, never rewrite claim_text/confidence/anything else. The
-- deleted_at side of that same sync (soft-delete propagation) goes through
-- `cb_internal.soft_delete_page(s)` instead — the SAME owner-privileged functions that already
-- propagate to content_chunks.deleted_at and page_sources.deleted_at (migrate.ts's
-- ensureAuthFunctions is where that extension lives; it is not duplicated here because those
-- functions were never duplicated in a checksummed migration file in the first place — see their own
-- comment in migrate.ts for why).
--
-- Bi-temporal columns are DELIBERATELY MINIMAL: only valid_from, consolidated_at, consolidated_into
-- ship now, because this build's own dedup step is the only thing that writes consolidated_at/into,
-- and nothing writes valid_until/expired_at/superseded_by (no live "supersede" branch in wave 1,
-- matching gbrain's own actually-shipped behavior, not its dead-code triadic classifier). This mirrors
-- D112's "no links.deleted_at" divergence: do not add a column nothing reads or writes yet.
--
-- EXPECTED doctor fixture changes (review as a security change; never rubber-stamp --update):
--   expected-policies.json       + facts_ws (SELECT), facts_hide_deleted (RESTRICTIVE SELECT),
--                                facts_rescope (UPDATE), facts_cycle_system (INSERT)
--   expected-grants.json         facts: cb_app has select/insert only at table level (update/delete
--                                revoked; update narrowed to the acl column, see below)
--   expected-column-grants.json  + one row per facts column (insert/select), + an UPDATE cell on
--                                facts.acl only
--   expected-definers.json       + cycle_fact_extraction_candidates, cycle_write_fact_extraction_stamp,
--                                cycle_facts_by_entity — all cb_app-only EXECUTE, pinned search_path

SET LOCAL lock_timeout = '3s';

CREATE TABLE facts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_page_id        uuid NOT NULL,
  acl                   text[] NOT NULL,
  deleted_at            timestamptz,

  entity_slug           text,
  kind                  text NOT NULL DEFAULT 'fact',
  notability            text NOT NULL DEFAULT 'medium',
  confidence            real NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),

  claim_text            text NOT NULL,
  claim_metric          text,
  claim_value           double precision,
  claim_unit            text,
  claim_period          text,
  event_type            text,
  source_excerpt        text,

  embedding             vector(1536),

  valid_from            timestamptz NOT NULL DEFAULT now(),
  consolidated_at       timestamptz,
  consolidated_into     uuid REFERENCES facts(id),

  extracted_by_run_id   uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (source_page_id, workspace_id) REFERENCES pages (id, workspace_id) ON DELETE CASCADE,
  CHECK (array_length(acl, 1) >= 1)
);

COMMENT ON TABLE  facts IS 'One typed, LLM-extracted claim per row, sourced from exactly one page (M10 wave 1). Single-parent — mirrors content_chunks'' RLS shape, not links'' two-endpoint one. Only the cycle system principal ever inserts a row; see this migration''s header.';
COMMENT ON COLUMN facts.workspace_id IS 'Denormalized tenant (D4) — composite FK below keeps it in sync with the source page.';
COMMENT ON COLUMN facts.source_page_id IS 'The page this fact was extracted from.';
COMMENT ON COLUMN facts.acl IS 'Denormalized copy of the source page''s acl at extraction time. Kept in sync by rescopePages (acl) and cb_internal.soft_delete_page(s) (deleted_at) — see this migration''s header.';
COMMENT ON COLUMN facts.deleted_at IS 'Denormalized copy of the source page''s deleted_at. facts_hide_deleted requires NULL.';
COMMENT ON COLUMN facts.entity_slug IS 'Subject entity''s slug, resolved app-side from the LLM''s free-text entity field. No FK: an entity is not always a page (gbrain precedent).';
COMMENT ON COLUMN facts.kind IS 'event|preference|commitment|belief|fact. TEXT with no CHECK, validated at the phase boundary (matches pages.kind / effective_date_source, D86) so a new kind needs no migration.';
COMMENT ON COLUMN facts.notability IS 'high|medium|low, LLM-assigned in the same extraction call as the claim itself. Same TEXT+zod reasoning as kind.';
COMMENT ON COLUMN facts.confidence IS 'LLM-assigned confidence, 0..1. A real numeric invariant, so unlike kind/notability this IS a CHECK constraint.';
COMMENT ON COLUMN facts.claim_text IS 'The claim, as extracted.';
COMMENT ON COLUMN facts.claim_metric IS 'For a typed-trajectory claim (e.g. "MRR"): the metric name.';
COMMENT ON COLUMN facts.claim_value IS 'For a typed-trajectory claim: the numeric value.';
COMMENT ON COLUMN facts.claim_unit IS 'For a typed-trajectory claim: the unit (e.g. "USD", "%").';
COMMENT ON COLUMN facts.claim_period IS 'For a typed-trajectory claim: the period the value covers (e.g. "2026-Q3").';
COMMENT ON COLUMN facts.event_type IS 'For an event-kind fact: a free-text event category (e.g. "meeting", "job_change").';
COMMENT ON COLUMN facts.source_excerpt IS 'Short verbatim excerpt grounding the claim, for citation.';
COMMENT ON COLUMN facts.embedding IS 'Embedding of claim_text, same 1536-dim model as content_chunks (D13). Used for entity-scoped cosine dedup only in this build.';
COMMENT ON COLUMN facts.valid_from IS 'When this fact became true/known. Defaults to extraction time. No valid_until/expired_at/superseded_by yet — see this migration''s header.';
COMMENT ON COLUMN facts.consolidated_at IS 'Set at insert time when this fact deduplicated against an existing one (see cycle_facts_by_entity). Never set by an UPDATE in this build.';
COMMENT ON COLUMN facts.consolidated_into IS 'The existing fact this row deduplicated against, when consolidated_at is set.';
COMMENT ON COLUMN facts.extracted_by_run_id IS 'The cycle run_id that wrote this row (matches ingest_log/cycle_budget_ledger''s run_id).';

CREATE INDEX idx_facts_source_page ON facts (source_page_id);
CREATE INDEX idx_facts_acl ON facts USING gin (acl);
CREATE INDEX idx_facts_workspace_entity_active ON facts (workspace_id, entity_slug)
  WHERE entity_slug IS NOT NULL AND deleted_at IS NULL AND consolidated_at IS NULL;
CREATE INDEX idx_facts_embedding ON facts USING hnsw (embedding vector_cosine_ops);

ALTER TABLE pages
  ADD COLUMN facts_extracted_content_hash text,
  ADD COLUMN facts_extracted_at timestamptz;

COMMENT ON COLUMN pages.facts_extracted_content_hash IS 'pages.content_hash at the last successful fact_extraction pass over this page. NULL means never extracted. Lets cb_internal.cycle_fact_extraction_candidates skip unchanged pages server-side instead of re-reading and re-filtering every active page on every run.';
COMMENT ON COLUMN pages.facts_extracted_at IS 'When facts_extracted_content_hash was last stamped.';

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;

-- Ordinary read: same acl && grants shape as pages_ws/content_chunks_ws (0016), scoped to SELECT only
-- — see this migration's header for why facts has no ordinary FOR ALL policy.
CREATE POLICY facts_ws ON facts
  FOR SELECT TO cb_app
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  );

CREATE POLICY facts_hide_deleted ON facts
  AS RESTRICTIVE FOR SELECT TO cb_app
  USING (deleted_at IS NULL);

-- The ordinary rescope path (src/ingest/lifecycle.ts rescopePages). Narrowed to the acl column alone
-- by a column-level GRANT below — this policy only gates WHICH rows and WHICH new-acl values are
-- reachable, not which columns a caller may touch.
CREATE POLICY facts_rescope ON facts
  FOR UPDATE TO cb_app
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  );

-- The cycle system principal's only direct table operation on facts: inserting newly-extracted rows.
-- FOR INSERT only, narrower than links_cycle_system's FOR ALL — this phase never UPDATEs or DELETEs a
-- fact row (no supersede branch; deleted_at propagation goes through soft_delete_page(s) instead).
--
-- NEVER add `RETURNING` to that INSERT. This WITH CHECK doesn't reference acl, so the insert itself
-- succeeds for a private page — but the sentinel's own grants are workspace-only, and RETURNING
-- additionally requires the new row to be visible under the table's SELECT-governing policy
-- (facts_ws's acl && grants), the identical intrinsic-RLS property soft_delete_page's own comment in
-- migrate.ts documents for UPDATE. For a private-page fact that visibility check fails, and the whole
-- statement 42501s. Verified live (test/facts-security.live.test.ts) — a test helper using RETURNING
-- for convenience hit exactly this on its first private-page case; the production phase's own bulk
-- INSERT has no RETURNING and is unaffected.
CREATE POLICY facts_cycle_system ON facts
  FOR INSERT TO cb_app
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND NULLIF(current_setting('app.principal', true), '') =
        '00000000-0000-0000-0000-000000000000'
  );

COMMENT ON POLICY facts_ws ON facts IS 'Ordinary read visibility. SELECT only — see this migration''s header for why facts has no ordinary INSERT/DELETE path.';
COMMENT ON POLICY facts_hide_deleted ON facts IS 'Soft-delete visibility, same shape as pages_hide_deleted/content_chunks_hide_deleted (0016). RESTRICTIVE + FOR SELECT so it cannot block the UPDATE that sets it.';
COMMENT ON POLICY facts_rescope ON facts IS 'Ordinary acl-only rescope path. Column-restricted by GRANT UPDATE (acl), not by this policy.';
COMMENT ON POLICY facts_cycle_system ON facts IS 'The exact cycle system principal''s insert path, confined to its tx-local app.workspace. No other principal can satisfy this policy''s WITH CHECK.';

-- cb_app needs table-level INSERT for the sentinel to succeed at all (GRANT is per-role; the sentinel
-- and an ordinary member share cb_app). RLS above is what actually stops an ordinary member from
-- using it. UPDATE/DELETE at table level are revoked; UPDATE is replaced by a column-restricted grant
-- for the rescope path only. Re-asserted on every migrate run by narrowGrants() in migrate.ts, exactly
-- like links' own UPDATE revoke (0022) — this is the atomic first application.
REVOKE UPDATE, DELETE ON facts FROM cb_app;
GRANT UPDATE (acl) ON facts TO cb_app;

-- Bounded, sentinel-only read/write apertures for the fact_extraction cycle phase (M10), matching the
-- exact shape cycle_link_pages/cycle_link_page_acls/cycle_lock_link_sources established in 0022:
-- validate the exact system principal, validate the tx-local workspace, cap all bounds, pin
-- search_path. Re-created identically in migrate.ts's ensureAuthFunctions (byte-for-byte, posture
-- tested) so a later CREATE OR REPLACE cannot silently drift from what this migration installed.

-- Server-side skip-filtered candidate read. A dedicated function rather than reusing cycle_link_pages
-- verbatim: at steady state most pages are already extracted, so client-side skip-filtering after a
-- generic read would make batches increasingly sparse as the corpus matures. Filtering in SQL keeps
-- every returned row actually useful.
--
-- The `content_hash IS NULL OR ...` guard: a page predating M6's migration 0014 (never since
-- replaced) has NULL content_hash, which can never equal anything under IS DISTINCT FROM, including
-- a prior NULL stamp — without this OR such a page would silently never become a candidate at all,
-- on the very first run. Treated as "always eligible" instead: the safe direction when change
-- detection has no signal to compare, even though it means that specific page re-extracts every run.
CREATE OR REPLACE FUNCTION cb_internal.cycle_fact_extraction_candidates(p_after uuid, p_limit int)
RETURNS TABLE (
  id uuid,
  slug text,
  title text,
  kind text,
  tags text[],
  acl text[],
  body text,
  extracted_text text,
  content_hash text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  scoped_workspace uuid;
BEGIN
  IF NULLIF(current_setting('app.principal', true), '') IS DISTINCT FROM
     '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_fact_extraction_candidates is restricted to the cycle system principal';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'cycle_fact_extraction_candidates limit must be between 1 and 1000';
  END IF;

  scoped_workspace := NULLIF(current_setting('app.workspace', true), '')::uuid;
  IF scoped_workspace IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_fact_extraction_candidates requires a scoped workspace';
  END IF;

  RETURN QUERY
    SELECT p.id, p.slug, p.title, p.kind, p.tags, p.acl, p.body, p.extracted_text, p.content_hash
    FROM public.pages p
    WHERE p.workspace_id = scoped_workspace
      AND p.deleted_at IS NULL
      AND (p_after IS NULL OR p.id > p_after)
      AND (p.content_hash IS NULL OR p.content_hash IS DISTINCT FROM p.facts_extracted_content_hash)
    ORDER BY p.id
    LIMIT p_limit;
END
$fn$;

-- Single-row stamp write, so a later page's crash never loses an earlier page's committed extraction
-- state (the phase calls this in the same short transaction as that page's fact inserts).
CREATE OR REPLACE FUNCTION cb_internal.cycle_write_fact_extraction_stamp(p_page_id uuid, p_content_hash text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  scoped_workspace uuid;
BEGIN
  IF NULLIF(current_setting('app.principal', true), '') IS DISTINCT FROM
     '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_write_fact_extraction_stamp is restricted to the cycle system principal';
  END IF;

  scoped_workspace := NULLIF(current_setting('app.workspace', true), '')::uuid;
  IF scoped_workspace IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_write_fact_extraction_stamp requires a scoped workspace';
  END IF;

  UPDATE public.pages
     SET facts_extracted_content_hash = p_content_hash,
         facts_extracted_at = now()
   WHERE id = p_page_id
     AND workspace_id = scoped_workspace;
END
$fn$;

-- Entity-scoped cosine-ANN dedup read. Ranks in SQL against the HNSW index and returns similarity
-- directly, rather than transferring candidate embeddings back to the application to re-score there.
CREATE OR REPLACE FUNCTION cb_internal.cycle_facts_by_entity(p_entity_slug text, p_embedding vector(1536), p_limit int)
RETURNS TABLE (id uuid, similarity real)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  scoped_workspace uuid;
BEGIN
  IF NULLIF(current_setting('app.principal', true), '') IS DISTINCT FROM
     '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_facts_by_entity is restricted to the cycle system principal';
  END IF;

  IF p_entity_slug IS NULL OR length(p_entity_slug) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'cycle_facts_by_entity requires a non-empty entity slug';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'cycle_facts_by_entity limit must be between 1 and 50';
  END IF;

  scoped_workspace := NULLIF(current_setting('app.workspace', true), '')::uuid;
  IF scoped_workspace IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cycle_facts_by_entity requires a scoped workspace';
  END IF;

  RETURN QUERY
    SELECT f.id, (1 - (f.embedding <=> p_embedding))::real AS similarity
    FROM public.facts f
    WHERE f.workspace_id = scoped_workspace
      AND f.entity_slug = p_entity_slug
      AND f.deleted_at IS NULL
      AND f.embedding IS NOT NULL
    ORDER BY f.embedding <=> p_embedding
    LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION cb_internal.cycle_fact_extraction_candidates(uuid, int) FROM PUBLIC, cb_auth;
REVOKE ALL ON FUNCTION cb_internal.cycle_write_fact_extraction_stamp(uuid, text) FROM PUBLIC, cb_auth;
REVOKE ALL ON FUNCTION cb_internal.cycle_facts_by_entity(text, vector, int) FROM PUBLIC, cb_auth;
GRANT EXECUTE ON FUNCTION cb_internal.cycle_fact_extraction_candidates(uuid, int) TO cb_app;
GRANT EXECUTE ON FUNCTION cb_internal.cycle_write_fact_extraction_stamp(uuid, text) TO cb_app;
GRANT EXECUTE ON FUNCTION cb_internal.cycle_facts_by_entity(text, vector, int) TO cb_app;
