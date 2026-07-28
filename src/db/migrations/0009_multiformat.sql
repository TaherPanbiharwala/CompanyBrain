-- M3 — multi-format ingest: chunk locators, source retention, and the quarantine table.
--
-- EXPECTED doctor FIXTURE DIFF (review it as a security change; do NOT reflex --update):
--   expected-grants.json         + cb_app/page_sources  {SELECT, INSERT, DELETE}   — no UPDATE
--                                + cb_app/quarantine    {SELECT, INSERT, DELETE}   — no UPDATE
--                                (the UPDATE revokes live in migrate.ts narrowGrants, NOT here —
--                                 grantExisting re-grants full DML on every new table each run)
--   expected-column-grants.json  + pages.{source_format,source_meta,source_sha256,extracted_text,
--                                  extractor} and content_chunks.locator, at the privileges those
--                                  tables already hold
--                                + every column of page_sources and quarantine at SELECT/INSERT/DELETE
--   expected-policies.json       + page_sources_ws and quarantine_ws (qual and with_check on each)
-- Nothing else may move. If a policy on pages or content_chunks changes, something is wrong.
--
-- ALTER TABLE ... ADD COLUMN takes AccessExclusiveLock, so it queues behind in-flight readers and
-- then blocks everything. Same reasoning as 0007:26 — a bounded wait is the difference between a
-- fast failure and a stalled deploy. The runner wraps this file in one transaction (migrate.ts:442),
-- so SET LOCAL is correct and the whole file is atomic.
SET LOCAL lock_timeout = '3s';

-- ── 1. Where a chunk came from ───────────────────────────────────────────
--
-- jsonb, not text. `'Sheet1!A5:F20'` in a text column forces every consumer to re-parse a format
-- this file invented, just to decide whether to open a PDF at a page or highlight a cell range.
--
-- SPAN forms, not points: with overlap a chunk routinely covers pages 7-8 or rows 40-60, so
-- `{"page": 7}` cannot express what was actually packed. Nullable because pasted text has no
-- position inside a source document — there is no source document.
ALTER TABLE content_chunks ADD COLUMN locator jsonb;
ALTER TABLE content_chunks ADD CONSTRAINT chunks_locator_shape
  CHECK (locator IS NULL OR locator ? 'kind');
COMMENT ON COLUMN content_chunks.locator IS
  'Where this chunk came from inside its source. {"kind":"page","from":7,"to":8} | {"kind":"sheet","sheet":"Q3","from":"A40","to":"F41"} | {"kind":"path","pointer":"/pricing"} | {"kind":"offset","from":0,"to":900}. The Locator union in src/ingest/blocks.ts is the specification; formatLocator() there renders it for citations. NULL for pasted text.';

-- ── 2. What the page was made from ───────────────────────────────────────
ALTER TABLE pages ADD COLUMN source_format text;
ALTER TABLE pages ADD COLUMN source_meta jsonb;
ALTER TABLE pages ADD COLUMN source_sha256 text;
ALTER TABLE pages ADD COLUMN extracted_text text;
ALTER TABLE pages ADD COLUMN extractor text;

COMMENT ON COLUMN pages.source_format IS 'pdf|docx|xlsx|csv|json|html|markdown|text, from magic-byte detection in src/ingest/extract/detect.ts — never the filename extension, which is caller-supplied. NULL for pasted text.';
COMMENT ON COLUMN pages.source_meta IS 'Structural facts only: pageCount, sheetNames, headerRow. Deliberately NEVER author/creator/lastModifiedBy — Office and PDF metadata names a third party who never agreed to be in this database, and it would land in a column no policy treats as personal data.';
COMMENT ON COLUMN pages.source_sha256 IS 'SHA-256 of the ORIGINAL bytes (src/ingest/sanity.ts contentHash). Duplicate detection at the door — cheaper and exact, where post-hoc similarity search is neither. Enforced by the two partial unique indexes below.';
COMMENT ON COLUMN pages.extracted_text IS 'Full extracted text, so the corpus can be re-chunked without re-running the parsers (whose output is not stable across library versions). Deliberately UNBOUNDED: the guard is the file-size cap at ingest, and failing a SUCCESSFUL extraction on a storage policy is the worst available outcome. NULL for pasted text, whose content is in pages.body.';
COMMENT ON COLUMN pages.extractor IS 'Library and version that produced extracted_text, e.g. unpdf@1.8.0. Re-chunking needs to know whether the text it is reusing came from a parser that has since changed.';
COMMENT ON COLUMN pages.body IS 'Raw pasted content. NULL for file-sourced pages, whose text is in extracted_text — the two carry different semantics (authored vs derived, re-derivable, parser-versioned) and collapsing them would lose that.';

-- Duplicate detection must NOT become an enumeration oracle.
--
-- Unique-index checks bypass RLS by design (they must, or uniqueness would mean nothing). A single
-- UNIQUE (workspace_id, source_sha256) would therefore make 23505 confirm that a colleague has
-- already uploaded a byte-identical file you cannot see — the exact hole 0007:121-138 closed for
-- slugs, reopened on file content. Same shape of fix: shared documents are unique workspace-wide,
-- private ones only per author.
--
-- src/ingest/import.ts must match BOTH index names when mapping 23505, the way it already does for
-- pages_ws_slug_shared / pages_ws_slug_private.
CREATE UNIQUE INDEX pages_sha_shared ON pages (workspace_id, source_sha256)
  WHERE scope = 'workspace' AND source_sha256 IS NOT NULL;
CREATE UNIQUE INDEX pages_sha_private ON pages (workspace_id, owner_principal, source_sha256)
  WHERE scope = 'private' AND source_sha256 IS NOT NULL;

COMMENT ON INDEX pages_sha_shared IS 'Byte-identical uploads collide workspace-wide for shared pages. Paired with pages_sha_private.';
COMMENT ON INDEX pages_sha_private IS 'Private uploads collide only with the SAME author''s, so re-uploading a file a colleague privately holds succeeds instead of confirming it exists.';

-- The title arm of hybrid search matches on lower(title); `pages` is indexed only on acl and tags
-- (schema.sql:229-230), so without this every ask seq-scans the table. text_pattern_ops so a prefix
-- match stays index-usable regardless of the database collation.
CREATE INDEX idx_pages_title_prefix ON pages (workspace_id, lower(title) text_pattern_ops);

-- ── 3. The original bytes ────────────────────────────────────────────────
--
-- IN POSTGRES, deliberately, and not Supabase Storage.
--
-- Storage policies evaluate auth.uid()/auth.jwt(), which are Supabase Auth claims. This app rolls
-- its own Google OIDC (D10), so there is no such JWT to present and the only workable credential is
-- the service_role key — which BYPASSES ALL RLS. Tenant isolation on the object plane would then be
-- enforced by TypeScript string concatenation and nothing else: precisely what D5/D7, the
-- NOBYPASSRLS cb_app role, verifyPoolRole() and the leak canary exist to reject.
--
-- Here the bytes inherit the same policy as every other content row, delete_page reaps them
-- transactionally through the FK cascade, and there is no orphan reaper, no refcounting over
-- content-addressed keys, and no signed URL outliving the ACL that issued it.
--
-- NO owner_principal column, unlike quarantine below. This is a CHILD of pages, so ownership is a
-- property of the parent; a second copy is a second thing that can drift from it — the same defect
-- class as chunk-acl drift, which doctor.ts already counts. acl is denormalized only because the
-- policy has to read it without a join (D4).
CREATE TABLE page_sources (
  page_id      uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  acl          text[] NOT NULL,
  filename     text NOT NULL,
  sha256       text NOT NULL,
  byte_len     bigint NOT NULL,
  bytes        bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Composite, matching content_chunks (schema.sql:246): a source row's workspace_id must equal its
  -- parent page's. Makes a mis-stamped tenant structurally impossible rather than an ingest bug.
  FOREIGN KEY (page_id, workspace_id) REFERENCES pages (id, workspace_id) ON DELETE CASCADE
);
ALTER TABLE page_sources ADD CONSTRAINT page_sources_acl_nonempty CHECK (array_length(acl, 1) >= 1);

COMMENT ON TABLE  page_sources IS 'The original uploaded file, retained so a citation naming page 7 can actually be opened at page 7, and so a corpus can be re-extracted when a parser improves. In Postgres rather than object storage because RLS is the only tenant-isolation mechanism this app has (see the migration header). TOAST handles the size.';
COMMENT ON COLUMN page_sources.page_id IS 'Parent page, and the primary key: one source file per page.';
COMMENT ON COLUMN page_sources.workspace_id IS 'Denormalized tenant, FK-locked equal to the parent page.';
COMMENT ON COLUMN page_sources.acl IS 'Denormalized copy of the page acl, so the policy filters without joining to pages (D4).';
COMMENT ON COLUMN page_sources.filename IS 'The name as uploaded. Caller-supplied free text — display only, never used to build a path.';
COMMENT ON COLUMN page_sources.sha256 IS 'Hash of the bytes IN THIS ROW. Duplicated from pages.source_sha256 on purpose: it lets an integrity check verify bytes against hash without a join, and detects the two drifting.';
COMMENT ON COLUMN page_sources.byte_len IS 'Size in bytes. Stored rather than computed so listing file sizes does not detoast every 5 MB value.';
COMMENT ON COLUMN page_sources.bytes IS 'The file itself. Never updated — replace_page deletes and re-inserts, so cb_app holds no UPDATE here (migrate.ts narrowGrants).';

-- Covers the workspaces FK for cascade delete. The composite FK is already covered: page_id is the PK.
CREATE INDEX idx_page_sources_ws ON page_sources (workspace_id);

ALTER TABLE page_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY page_sources_ws ON page_sources
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  );

-- ── 4. Quarantine ────────────────────────────────────────────────────────
--
-- A FULL TENANCY-PLANE TABLE, not a metadata log, and that distinction is the whole point.
--
-- A workspace-equality-only policy would make `Priya_termination_letter.pdf` readable by every
-- member of the workspace — including for a document that would have been scope:'private' had it
-- not been rejected. The filename of a rejected upload is exactly as sensitive as the upload.
--
-- It carries its own owner_principal, unlike page_sources, because there is no parent row to inherit
-- from: the rejection is the reason no page exists.
--
-- WHY THIS TABLE EXISTS AT ALL, given the caller already gets a typed error: the sanity gate is
-- HEURISTIC (thresholds in src/ingest/sanity.ts), so it can be wrong, and a false reject is only
-- fixable if the evidence survived. Extraction failures — .doc, a password-protected PDF, an
-- unsupported format — are not judgement calls and are not recorded here.
--
-- Verdict and counts ONLY. No content excerpt: the reason a file was rejected must not become a
-- channel for the content it was rejected for (D28's rule, one layer out).
CREATE TABLE quarantine (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_principal text NOT NULL,
  acl             text[] NOT NULL,
  filename        text NOT NULL,
  source_format   text,
  sha256          text,
  byte_len        bigint,
  -- Mirrors the SanityReason union in src/ingest/sanity.ts. There is no way to import a TypeScript
  -- type into SQL, so the two are bound by review and by the sanity tests — the same arrangement
  -- 0007 records for GRANT_SEPARATOR. Adding a reason means editing both.
  reason          text NOT NULL CHECK (reason IN ('empty', 'too_short', 'binary', 'no_word_boundaries')),
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE quarantine ADD CONSTRAINT quarantine_acl_nonempty CHECK (array_length(acl, 1) >= 1);

COMMENT ON TABLE  quarantine IS 'Uploads the sanity gate refused, kept so a false reject is inspectable instead of silently lost. Full tenancy-plane row (workspace_id + owner_principal + acl), because a rejected private file''s NAME is as sensitive as the file. Not retained forever — retention is M5, alongside the spend cap.';
COMMENT ON COLUMN quarantine.owner_principal IS 'Who uploaded it. Carried directly because there is no parent page to inherit from — the rejection is why no page exists.';
COMMENT ON COLUMN quarantine.acl IS 'From aclForScope() on the scope the caller REQUESTED, so a file that would have been private stays private in rejection.';
COMMENT ON COLUMN quarantine.sha256 IS 'Hash of the rejected bytes, so a repeated upload of the same file is recognizable. NOT unique-indexed: a uniqueness violation here would be an oracle for what a colleague tried to upload.';
COMMENT ON COLUMN quarantine.reason IS 'The sanity verdict. Extraction failures are typed API errors, not quarantine rows — see the table''s note.';
COMMENT ON COLUMN quarantine.detail IS 'Structural description of the verdict ("62% of characters are not printable text"). NEVER an excerpt of the rejected content.';

CREATE INDEX idx_quarantine_ws_created ON quarantine (workspace_id, created_at DESC);

ALTER TABLE quarantine ENABLE ROW LEVEL SECURITY;
CREATE POLICY quarantine_ws ON quarantine
  USING (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  )
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
    AND acl && (SELECT public.current_grants())
  );
