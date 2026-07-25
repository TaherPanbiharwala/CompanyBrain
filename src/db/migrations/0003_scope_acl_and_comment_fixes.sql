-- M1+M2 review follow-up: make `pages.scope` a real access-control label, and correct prose in
-- schema.sql that M2 falsified.
--
-- WHY THIS FILE EXISTS AT ALL: schema.sql is checksum-immutable once applied (migrate.ts hashes file
-- content and refuses a changed file), so a wrong COMMENT ON in it can never be fixed in place. The
-- only correction channel is a later migration re-issuing the COMMENT. 0001 already used this device
-- for the PG15 FK note; this file uses it for two claims M2 reversed.

-- ── 1. scope becomes a constrained label whose acl is derived from it ─────
--
-- The defect: `scope` was free text with no CHECK, the op accepted any string, and importPage
-- stamped `acl = ['ws:'||workspace_id]` UNCONDITIONALLY — so `scope:'private'` produced a row every
-- member could read. The label was decorative while the acl is what the database enforces.
--
-- Why it had to be fixed now rather than at M4: `acl && current_grants()` becomes the enforced
-- predicate at M4, and it reads the ACL, never the label. Every row written before that with a
-- mismatched pair would have been permanently mis-scoped, with the author's intent unrecoverable.
-- All existing rows are scope='workspace' with a matching ws: acl, so there is nothing to backfill.
--
-- The application now derives acl from scope in ONE place (aclForScope, src/core/context.ts). This
-- CHECK is the database-side half: it stops any other writer, now or later, persisting a scope the
-- mapping does not understand.
ALTER TABLE pages ADD CONSTRAINT pages_scope_ck CHECK (scope IN ('private', 'workspace'));

-- Align the column default with the application's. They disagreed — DDL said 'private', the only
-- writer said 'workspace' — so an INSERT that omitted the column meant something different from one
-- that let the app default fire. D0.1 is now closed as workspace-default.
ALTER TABLE pages ALTER COLUMN scope SET DEFAULT 'workspace';

COMMENT ON COLUMN pages.scope IS
  'Visibility policy: private (acl = self:<author>) | workspace (acl = ws:<workspace>). The acl is DERIVED from this by aclForScope() in src/core/context.ts and is what RLS actually enforces — never set the two independently.';

-- ── 2. Corrections to schema.sql prose that M2 reversed ──────────────────
--
-- schema.sql lines 24-29 and the sessions COMMENT still describe the auth layer as using the
-- owner/admin connection for pre-auth lookups. M2 shipped the opposite, and the reversal is the
-- whole point of D25/D35: pre-auth login/onboarding writes run as the least-privilege `cb_auth`
-- role, and the per-request session lookup runs through cb_internal.resolve_session (SECURITY
-- DEFINER) on the `cb_app` pool. The admin connection is used ONLY by migrate.ts.
--
-- This matters beyond tidiness: COMMENT ON is what an operator reads in psql, so the stale text was
-- actively teaching the wrong security model to the person most able to act on it.
COMMENT ON TABLE sessions IS
  'Hashed session tokens (M2). Written by the cb_auth role at login; read on every request via cb_internal.resolve_session (SECURITY DEFINER) on the cb_app pool — cb_app holds NO direct privilege on this table. refresh_hash/refresh_expires_at are unused at M2 (rotation cut, G2) and reserved for M5.';

COMMENT ON TABLE principals IS
  'Global person identity (one row per human, spanning workspaces). Created and profile-refreshed by the cb_auth role during login/onboarding; google_sub is written ONLY by cb_internal.adopt_principal, whose `google_sub IS NULL` guard lives in the database so no application role holds UPDATE on it.';
