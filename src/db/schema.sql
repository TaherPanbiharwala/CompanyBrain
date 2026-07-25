-- company-brain baseline schema (M0). Tenancy + identity + content.
--
-- Invariants realized here:
--  * Every content/tenancy row carries workspace_id NOT NULL (DECISIONS D1, D3). The identity
--    plane (principals, sessions) is GLOBAL (a person spans workspaces) with self-scoped RLS.
--  * ACL-bearing rows carry scope + acl text[] + owner_principal; visible iff acl && grants (D1).
--  * workspace_id is denormalized onto content_chunks so RLS/filters never JOIN to pages (D4);
--    composite FKs below make a mis-stamped workspace_id impossible, not just discouraged.
--  * RLS is ENABLED on every table. The app connects as the NON-BYPASSRLS role `cb_app`,
--    so these policies actually constrain application queries (D5, D7).
--  * M0 ships the app-side resolver + RLS workspace-equality backstop. Per-row `acl && grants`
--    enforcement lands in engine queries at M3 and in RLS at M4. Membership verification (that the
--    caller belongs to app.workspace) is enforced in the DB here via the sessions FK, and in the
--    app resolver at M2.
--  * GUCs are set per-request, tx-local: current_setting('app.workspace'/'app.principal', true).
--    Policies read NULLIF(current_setting(...), '')::uuid: a custom GUC's reset value becomes ''
--    (not NULL) once it has been SET in a session, and transaction-pooler backends are reused, so
--    an unscoped query on a reused backend reads '' — NULLIF maps both unset and '' to NULL, which
--    yields no match -> rows hidden (fail-closed) instead of a '::uuid' cast error. buildContext
--    also validates that principal/workspace are UUIDs before they reach these policies.

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector >= 0.8 (DECISIONS D14)

-- ========================================================================
-- Identity plane (global; a principal spans workspaces, so NOT workspace-scoped).
-- Managed by the auth layer (M2), which uses the owner/admin connection for pre-auth
-- lookups (by google_sub / token_hash, before a principal/workspace context exists).
-- The tenant-facing `cb_app` role gets least-privilege self policies.
-- ========================================================================

CREATE TABLE principals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub       text UNIQUE,
  email            text NOT NULL,
  email_normalized text NOT NULL,
  name             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  principals IS 'Global person identity (one row per human, spanning workspaces).';
COMMENT ON COLUMN principals.id IS 'Stable principal id; referenced by content.owner_principal and memberships.';
COMMENT ON COLUMN principals.google_sub IS 'Google OIDC subject claim; the durable external identity key.';
COMMENT ON COLUMN principals.email IS 'Email as returned (verified) by Google.';
COMMENT ON COLUMN principals.email_normalized IS 'Lowercased, Gmail dot/plus-stripped email for invite matching (DECISIONS D11).';
COMMENT ON COLUMN principals.name IS 'Display name from the OIDC profile.';
COMMENT ON COLUMN principals.created_at IS 'Row creation time.';
COMMENT ON COLUMN principals.updated_at IS 'Last profile update time.';
CREATE INDEX idx_principals_email_normalized ON principals (email_normalized);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  domain     text UNIQUE,
  created_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  workspaces IS 'A tenant. Personal workspaces have NULL domain; domain enables auto-join (DECISIONS D11). Created via the owner/auth connection (chicken-and-egg with the RLS policy below).';
COMMENT ON COLUMN workspaces.id IS 'Workspace (tenant) id; the value bound to the app.workspace GUC.';
COMMENT ON COLUMN workspaces.name IS 'Human-facing workspace name (shown as "Everyone at {name}").';
COMMENT ON COLUMN workspaces.domain IS 'Custom email domain for auto-join; NULL for Gmail/personal-created workspaces (public-domain blocklist blocks auto-join, not creation).';
COMMENT ON COLUMN workspaces.created_by IS 'Principal who created the workspace.';
COMMENT ON COLUMN workspaces.created_at IS 'Row creation time.';

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, principal_id)
);
COMMENT ON TABLE  workspace_members IS 'Membership join (one person, many workspaces). Role drives RBAC (verbs). The (workspace_id, principal_id) PK is the FK target for sessions.active_workspace_id.';
COMMENT ON COLUMN workspace_members.workspace_id IS 'Tenant.';
COMMENT ON COLUMN workspace_members.principal_id IS 'Member principal.';
COMMENT ON COLUMN workspace_members.role IS 'RBAC role: owner | admin | member.';
COMMENT ON COLUMN workspace_members.created_at IS 'When the person joined.';
-- FK columns are not auto-indexed by Postgres; principal-leading lookups (M2 login: "which
-- workspaces is this principal in?") and the ON DELETE CASCADE from principals need this.
CREATE INDEX idx_workspace_members_principal ON workspace_members (principal_id);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  active_workspace_id uuid,
  token_hash          text NOT NULL UNIQUE,
  refresh_hash        text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  refresh_expires_at  timestamptz,
  -- The active workspace MUST be a real membership of this principal. Column-specific SET NULL
  -- (PG15+) nulls only active_workspace_id when the membership is revoked, leaving the session
  -- (and its NOT NULL principal_id) intact. This is the DB backstop for "workspaceId taken on
  -- trust" (review sec S1 / adv #1); the M2 resolver must still derive app.workspace from a
  -- verified membership, never from raw request input.
  FOREIGN KEY (active_workspace_id, principal_id)
    REFERENCES workspace_members (workspace_id, principal_id)
    ON DELETE SET NULL (active_workspace_id)
);
COMMENT ON TABLE  sessions IS 'Hashed session + refresh tokens (M2). Looked up by the auth layer via the admin connection.';
COMMENT ON COLUMN sessions.id IS 'Session id.';
COMMENT ON COLUMN sessions.principal_id IS 'Owning principal.';
COMMENT ON COLUMN sessions.active_workspace_id IS 'Workspace the session is acting in (the app.workspace GUC source). FK-constrained to a real workspace_members row.';
COMMENT ON COLUMN sessions.token_hash IS 'SHA-256 of the short-lived session token (never store the raw token).';
COMMENT ON COLUMN sessions.refresh_hash IS 'SHA-256 of the rotating refresh token.';
COMMENT ON COLUMN sessions.created_at IS 'Session creation time.';
COMMENT ON COLUMN sessions.expires_at IS 'Session token expiry.';
COMMENT ON COLUMN sessions.refresh_expires_at IS 'Refresh token expiry.';
CREATE INDEX idx_sessions_principal ON sessions (principal_id);

-- ========================================================================
-- Tenancy plane (workspace-scoped).
-- ========================================================================

CREATE TABLE teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name),
  UNIQUE (id, workspace_id)   -- FK target for team_memberships (guarantees same-tenant)
);
COMMENT ON TABLE  teams IS 'Team within a workspace (wired at M5; grant tag team:<id>).';
COMMENT ON COLUMN teams.id IS 'Team id (used as the team:<id> grant tag).';
COMMENT ON COLUMN teams.workspace_id IS 'Owning tenant.';
COMMENT ON COLUMN teams.name IS 'Team name (unique within the workspace).';
COMMENT ON COLUMN teams.created_at IS 'Row creation time.';

CREATE TABLE team_memberships (
  team_id      uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, principal_id),
  -- Composite FK: a membership's workspace_id must equal the team's workspace_id.
  FOREIGN KEY (team_id, workspace_id) REFERENCES teams (id, workspace_id) ON DELETE CASCADE
);
COMMENT ON TABLE  team_memberships IS 'Team membership; a member gets the team:<team_id> grant in their keyring (M5).';
COMMENT ON COLUMN team_memberships.team_id IS 'Team.';
COMMENT ON COLUMN team_memberships.principal_id IS 'Member principal.';
COMMENT ON COLUMN team_memberships.workspace_id IS 'Denormalized tenant (kept equal to teams.workspace_id by the composite FK).';
COMMENT ON COLUMN team_memberships.created_at IS 'When the person joined the team.';
-- Principal-leading: M5 keyring build ("teams for principal P") + principals ON DELETE CASCADE.
CREATE INDEX idx_team_memberships_principal ON team_memberships (principal_id, workspace_id);

CREATE TABLE acl_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  grant_tag    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, principal_id, grant_tag)
);
COMMENT ON TABLE  acl_grants IS 'Extra grant tags a principal holds (ReBAC), unioned into the request keyring beyond self+workspace. Writes are admin-only (enforced by the dispatch/auth layer at M2-M5; see DECISIONS).';
COMMENT ON COLUMN acl_grants.id IS 'Grant id.';
COMMENT ON COLUMN acl_grants.workspace_id IS 'Tenant.';
COMMENT ON COLUMN acl_grants.principal_id IS 'Principal holding the grant.';
COMMENT ON COLUMN acl_grants.grant_tag IS 'A grant tag, e.g. role:admin or team:<id>, matched against row acl.';
COMMENT ON COLUMN acl_grants.created_at IS 'Row creation time.';

CREATE TABLE invites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email            text NOT NULL,
  email_normalized text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  role             text NOT NULL DEFAULT 'member',
  status           text NOT NULL DEFAULT 'pending',
  invited_by       uuid REFERENCES principals(id),
  accepted_by      uuid REFERENCES principals(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
COMMENT ON TABLE  invites IS 'Single-use email invites (primary SMB onboarding). Matched on Google verified email/normalized (D11).';
COMMENT ON COLUMN invites.id IS 'Invite id.';
COMMENT ON COLUMN invites.workspace_id IS 'Tenant the invite grants access to.';
COMMENT ON COLUMN invites.email IS 'Invited email as typed by the admin.';
COMMENT ON COLUMN invites.email_normalized IS 'Normalized form matched against the accepting login (D11).';
COMMENT ON COLUMN invites.token_hash IS 'SHA-256 of the single-use invite token.';
COMMENT ON COLUMN invites.role IS 'Role granted on acceptance.';
COMMENT ON COLUMN invites.status IS 'pending | accepted | expired | revoked.';
COMMENT ON COLUMN invites.invited_by IS 'Admin principal who sent the invite.';
COMMENT ON COLUMN invites.accepted_by IS 'Principal who accepted (NULL until accepted).';
COMMENT ON COLUMN invites.created_at IS 'Row creation time.';
COMMENT ON COLUMN invites.expires_at IS 'Invite expiry.';
-- Workspace-scoped admin listing:
CREATE INDEX idx_invites_ws_email ON invites (workspace_id, email_normalized);
-- Login-time match is email-only (no workspace context yet); only pending invites matter:
CREATE INDEX idx_invites_email ON invites (email_normalized) WHERE status = 'pending';

-- ========================================================================
-- Content plane (workspace-scoped, ACL-bearing).
-- ========================================================================

CREATE TABLE pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  kind            text NOT NULL DEFAULT 'note',
  title           text,
  description     text,
  tags            text[] NOT NULL DEFAULT '{}',
  status          text,
  owner_principal text NOT NULL,
  scope           text NOT NULL DEFAULT 'private',
  acl             text[] NOT NULL,
  body            text,
  compiled_truth  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug),
  UNIQUE (id, workspace_id)   -- FK target for content_chunks (guarantees same-tenant chunks)
);
COMMENT ON TABLE  pages IS 'A knowledge page. OKF-aligned fields; kind is TEXT never an enum. Visible iff acl && grants.';
COMMENT ON COLUMN pages.id IS 'Page id.';
COMMENT ON COLUMN pages.workspace_id IS 'Tenant. Required in every WHERE/UNIQUE/RLS.';
COMMENT ON COLUMN pages.slug IS 'Stable per-workspace slug (UNIQUE with workspace_id).';
COMMENT ON COLUMN pages.kind IS 'Generic pack type (person|company|project|process|note); TEXT, maps to OKF type at export.';
COMMENT ON COLUMN pages.title IS 'OKF title.';
COMMENT ON COLUMN pages.description IS 'OKF description.';
COMMENT ON COLUMN pages.tags IS 'OKF tags (source of truth; copied onto chunks at ingest).';
COMMENT ON COLUMN pages.status IS 'Lifecycle/official-flag status (future official-check flow).';
COMMENT ON COLUMN pages.owner_principal IS 'Creator principal (the self-grant); stamped at the ingest waist.';
COMMENT ON COLUMN pages.scope IS 'Coarse label: private | workspace (extensible to team/role).';
COMMENT ON COLUMN pages.acl IS 'Grant tags; row visible iff acl && caller grants. GIN-indexed.';
COMMENT ON COLUMN pages.body IS 'Raw page content.';
COMMENT ON COLUMN pages.compiled_truth IS 'Synthesized per-entity narrative (M7).';
COMMENT ON COLUMN pages.created_at IS 'Row creation time.';
COMMENT ON COLUMN pages.updated_at IS 'Last update time.';
-- Note: no idx_pages_ws — UNIQUE(workspace_id, slug) already provides a workspace_id-leading btree.
CREATE INDEX idx_pages_acl ON pages USING gin (acl);
CREATE INDEX idx_pages_tags ON pages USING gin (tags);

CREATE TABLE content_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id      uuid NOT NULL,
  acl          text[] NOT NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  ord          int NOT NULL,
  content      text NOT NULL,
  token_count  int,
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Composite FK: a chunk's workspace_id must equal its parent page's workspace_id. Makes a
  -- mis-stamped tenant on the hot vector-search path (which never joins back to pages, D4)
  -- structurally impossible rather than an ingest-bug leak (review sec S9 / adv #6).
  FOREIGN KEY (page_id, workspace_id) REFERENCES pages (id, workspace_id) ON DELETE CASCADE
);
COMMENT ON TABLE  content_chunks IS 'Chunks of a page. Carries denormalized workspace_id + acl so RLS/vector-search never JOIN to pages (D4); the composite FK keeps workspace_id in sync with the parent page.';
COMMENT ON COLUMN content_chunks.id IS 'Chunk id.';
COMMENT ON COLUMN content_chunks.workspace_id IS 'Denormalized tenant (FK-locked equal to the parent page).';
COMMENT ON COLUMN content_chunks.page_id IS 'Parent page.';
COMMENT ON COLUMN content_chunks.acl IS 'Denormalized copy of the page acl (for the acl && grants filter on the hot path).';
COMMENT ON COLUMN content_chunks.tags IS 'Tags copied from the parent page at ingest.';
COMMENT ON COLUMN content_chunks.ord IS 'Chunk order within the page.';
COMMENT ON COLUMN content_chunks.content IS 'Chunk text.';
COMMENT ON COLUMN content_chunks.token_count IS 'Approximate token count.';
COMMENT ON COLUMN content_chunks.embedding IS 'OpenAI text-embedding-3-small, 1536 dims (DECISIONS D13). Fixed dim; changing it is a fleet re-embed (see Migration conventions).';
COMMENT ON COLUMN content_chunks.created_at IS 'Row creation time.';
CREATE INDEX idx_chunks_ws ON content_chunks (workspace_id);
CREATE INDEX idx_chunks_page ON content_chunks (page_id, ord);   -- pre-ordered "chunks of a page"
CREATE INDEX idx_chunks_acl ON content_chunks USING gin (acl);
-- HNSW over cosine distance. Query with SET hnsw.iterative_scan = relaxed_order so a
-- tenant-selective (workspace_id/acl) filter still returns a full top-k (DECISIONS D14, review A7).
CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);

-- ========================================================================
-- Row-Level Security.
-- Enabled on every table. `cb_app` is NON-BYPASSRLS, so these bind application queries.
-- M0/M2 posture = workspace-equality (read USING + write WITH CHECK). The M4 migration
-- tightens the content policies to add `AND acl && current_grants()`.
-- The GUC read is wrapped in a scalar subquery `(SELECT current_setting(...))` so it is
-- evaluated ONCE per query (init-plan), not per candidate row (review perf P3).
-- ========================================================================

-- Identity plane: self-scoped (auth bootstrap runs via the owner/admin connection).
ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
CREATE POLICY principals_self ON principals
  USING (id = (SELECT NULLIF(current_setting('app.principal', true), '')::uuid));

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_self ON sessions
  USING (principal_id = (SELECT NULLIF(current_setting('app.principal', true), '')::uuid))
  WITH CHECK (principal_id = (SELECT NULLIF(current_setting('app.principal', true), '')::uuid));

-- Tenancy + content plane: workspace-equality.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_current ON workspaces
  USING (id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_members_ws ON workspace_members
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY teams_ws ON teams
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

ALTER TABLE team_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_memberships_ws ON team_memberships
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

ALTER TABLE acl_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY acl_grants_ws ON acl_grants
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY invites_ws ON invites
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY pages_ws ON pages
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

ALTER TABLE content_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY content_chunks_ws ON content_chunks
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));
