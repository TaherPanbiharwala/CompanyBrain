-- M2 review follow-up: make membership revocation DURABLE in a domain-claimed workspace.
--
-- The hole: onboarding auto-joins any login whose Google-verified `hd` matches workspaces.domain
-- (src/auth/workspaces.ts, resolveWorkspace branch b). Memberships are rows that exist or do not —
-- there is no "was removed" state — so an admin who removes an employee from a domain workspace has
-- them silently auto-rejoined as 'member' on their very next sign-in, which also undoes the
-- composite-FK SET NULL that had cleared their active workspace. Removal looked like it worked and
-- then quietly did not.
--
-- Why a separate table rather than a column on workspace_members: the block must OUTLIVE the
-- membership row, and the row is deleted on removal. A tombstone that lives in the thing being
-- deleted is not a tombstone.
--
-- M2 ships no membership-removal endpoint (cb_app holds no DELETE on workspace_members by design),
-- so removal is a deliberate admin-SQL action. This gives that action a supported, durable shape —
-- see docs/auth-setup.md. The admin UI that writes both rows in one transaction is M5.

CREATE TABLE workspace_domain_blocks (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  blocked_at   timestamptz NOT NULL DEFAULT now(),
  reason       text,
  PRIMARY KEY (workspace_id, principal_id)
);
COMMENT ON TABLE workspace_domain_blocks IS
  'Principals who must NOT be auto-joined to this workspace by domain match, even though their verified Google hd matches workspaces.domain. Survives deletion of the workspace_members row, which is the whole point.';
COMMENT ON COLUMN workspace_domain_blocks.blocked_at IS 'When the block was recorded.';
COMMENT ON COLUMN workspace_domain_blocks.reason IS 'Free-text operator note (e.g. "left the company 2026-07").';

-- RLS: same shape as every other tenancy-plane table. cb_app reads it within its own workspace;
-- writes are admin-only for now (no removal API until M5), so there is no cb_app write policy.
ALTER TABLE workspace_domain_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_domain_blocks_ws ON workspace_domain_blocks TO cb_app
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (false);

-- cb_auth must READ it during onboarding — that is the only lane where auto-join happens — but must
-- never write it: a login path that can clear its own block is not a block.
CREATE POLICY workspace_domain_blocks_auth ON workspace_domain_blocks TO cb_auth
  USING (true) WITH CHECK (false);
