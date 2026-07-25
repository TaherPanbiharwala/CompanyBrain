-- M2 — Identity / Google OIDC. Applied ONCE and then immutable (the runner checksums applied
-- files). While iterating on this file use `bun run migrate:reset`; freeze it only once
-- `bun run doctor`'s privilege matrix is green.
--
-- Role-scoped policies below require the `cb_auth` role to already exist — ensureBootstrap()
-- creates it before the migration loop runs.
--
-- NOTE (carried here from schema.sql, which is checksum-immutable once applied): the
-- `ON DELETE SET NULL (active_workspace_id)` column-list syntax on the sessions composite FK
-- REQUIRES PostgreSQL 15+. Supabase is 15+; on an older server the very first migrate fails there
-- with a bare syntax error. Editing an applied file to say so is what breaks `bun run migrate`,
-- so the note lives in this file instead.

-- ── G2: session epoch (sign-out-everywhere). NO prev_refresh_hash / rotated_at: refresh rotation
-- is CUT from M2, so there is nothing to rotate. Bumping principals.session_epoch invalidates every
-- session whose stamped `epoch` no longer matches.
ALTER TABLE principals ADD COLUMN session_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE sessions   ADD COLUMN epoch         integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN principals.session_epoch IS 'Global sign-out counter (G2). Bumped by cb_internal.revoke_all_sessions; a session is valid only while sessions.epoch matches it.';
COMMENT ON COLUMN sessions.epoch IS 'principals.session_epoch snapshot taken at issue time; a mismatch invalidates this session.';

-- ── Transport for the Google-signed `hd` claim. Session-scoped ON PURPOSE: the domain rule is
-- "the hd verified in THIS login", and POST /auth/workspaces is a LATER request, by which time the
-- ID token and the cb_oauth cookie are both long gone. NULL for consumer Google accounts and for
-- every dev-login principal, so neither can ever claim a domain.
--
-- The email domain is NOT a substitute: Google sets `hd` only for Workspace accounts, so a consumer
-- account can own a mailbox at any custom domain and would otherwise squat that domain's auto-join.
ALTER TABLE sessions ADD COLUMN login_hd text;
ALTER TABLE sessions ADD CONSTRAINT sessions_login_hd_lower
  CHECK (login_hd IS NULL OR login_hd = lower(login_hd));
COMMENT ON COLUMN sessions.login_hd IS 'Verified Google hd claim from the login that created this session; NULL for consumer accounts and dev-login. Sole source for claimDomain() on POST /auth/workspaces.';
COMMENT ON COLUMN sessions.refresh_hash       IS 'UNUSED at M2 (refresh rotation cut, G2); left NULL. Reserved for M5.';
COMMENT ON COLUMN sessions.refresh_expires_at IS 'UNUSED at M2 (refresh rotation cut, G2); left NULL. Reserved for M5.';

-- ── Identity integrity. email_normalized is the invite-matching key, so two rows sharing one
-- normalized address is an ambiguity we must never have: the login upsert relies on this exact
-- constraint name (`principals_email_normalized_key`) to distinguish its 23505 adopt branch from
-- any other unique violation.
DROP INDEX idx_principals_email_normalized;
CREATE UNIQUE INDEX principals_email_normalized_key ON principals (email_normalized);
ALTER TABLE principals ADD CONSTRAINT principals_email_norm_lower
  CHECK (email_normalized = lower(email_normalized));
ALTER TABLE invites ADD CONSTRAINT invites_email_norm_lower
  CHECK (email_normalized = lower(email_normalized));
ALTER TABLE invites ADD CONSTRAINT invites_status_ck
  CHECK (status IN ('pending','accepted','expired','revoked'));
-- role feeds ctx.role. hasRole() is fail-closed on unknown values, but an invite minting 'owner'
-- is a straight escalation, so the legal set is pinned in the database too.
ALTER TABLE invites ADD CONSTRAINT invites_role_ck
  CHECK (role IN ('owner','admin','member'));
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_ck
  CHECK (role IN ('owner','admin','member'));

-- ── Domain case. workspaces.domain is ALREADY UNIQUE (schema.sql:53); with this CHECK that UNIQUE
-- becomes case-exact, so a separate unique index on lower(domain) would be redundant — omitted
-- deliberately. Without it 'BigCo.com' and 'bigco.com' are two rows both "owning" one domain.
ALTER TABLE workspaces ADD CONSTRAINT workspaces_domain_lower
  CHECK (domain IS NULL OR domain = lower(domain));

-- ── Pre-auth policies for cb_auth. Login must find a principal by google_sub BEFORE any
-- app.workspace GUC exists, so cb_auth needs unconditional access to exactly these five tables.
--
-- SAFETY: permissive policies OR-combine only across policies APPLICABLE TO THE CURRENT ROLE, so a
-- `TO cb_auth` policy is invisible to cb_app. That holds only while (a) every one of these carries
-- an explicit TO clause, and (b) no pg_auth_members edge exists between cb_app and cb_auth. Both
-- are asserted by `bun run doctor` — a policy created without TO would be PUBLIC and would OR
-- USING(true) into cb_app, making every tenant readable by every tenant.
--
-- These five and no others: acl_grants, teams and team_memberships get NO cb_auth policy.
CREATE POLICY principals_auth        ON principals        TO cb_auth USING (true) WITH CHECK (true);
CREATE POLICY sessions_auth          ON sessions          TO cb_auth USING (true) WITH CHECK (true);
CREATE POLICY workspaces_auth        ON workspaces        TO cb_auth USING (true) WITH CHECK (true);
CREATE POLICY workspace_members_auth ON workspace_members TO cb_auth USING (true) WITH CHECK (true);
CREATE POLICY invites_auth           ON invites           TO cb_auth USING (true) WITH CHECK (true);

-- ── Make cb_app read-only on the membership/grant tables so a member cannot self-escalate.
-- The originals are PUBLIC (no TO clause), so they must be DROPPED, not merely supplemented —
-- adding a second policy would OR with the old one and change nothing.
--
-- NOTE: WITH CHECK (false) blocks INSERT/UPDATE but NOT DELETE — Postgres governs DELETE by USING
-- alone. The real control against DELETE is narrowGrants() revoking the privilege outright; both
-- layers are required, and the doctor asserts the grant half.
DROP POLICY workspace_members_ws ON workspace_members;
CREATE POLICY workspace_members_ws ON workspace_members TO cb_app
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (false);

DROP POLICY acl_grants_ws ON acl_grants;
CREATE POLICY acl_grants_ws ON acl_grants TO cb_app
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (false);
