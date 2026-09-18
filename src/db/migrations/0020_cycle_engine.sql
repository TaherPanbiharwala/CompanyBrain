-- 0020_cycle_engine.sql — M8: the cycle engine's storage substrate.
--
-- Five tables, all workspace_id-scoped, RLS-enabled with the workspace-equality policy shape
-- schema.sql already uses for non-ACL tables (teams_ws, acl_grants_ws, …). These are system
-- bookkeeping tables — no acl column, no per-principal dimension — so the policy is workspace
-- equality only, matching teams_ws exactly (see schema.sql:295-298).
--
-- Ported from gbrain's gbrain_cycle_locks / op_checkpoints / ingest_log (MIT fork at
-- ~/dev/gbrain, src/core/db-lock.ts, op-checkpoint.ts, schema.sql) with the workspace_id tax every
-- other table in this repo pays. cycle_failures and cycle_budget_ledger are NOT file-for-file ports
-- of gbrain's sync-failure-ledger.ts / budget-meter.ts — gbrain's are file-backed (JSONL) and
-- best-effort/fail-open; docs/plan.md Invariant 6 requires the M8 budget ledger write to be
-- transactional and fail CLOSED, and a scheduled worker has no durable local disk across runs
-- anyway, so both become real tables here instead. See DECISIONS.md D111.
--
-- No manual grants needed here: migrate.ts's grantExisting() runs
-- `grant select, insert, update, delete on all tables in schema public to cb_app` on every run, so
-- these five tables get full DML automatically. Nothing in narrowGrants() needs to touch them.

-- ── cycle_locks — one active cycle run per workspace ────────────────────────
CREATE TABLE cycle_locks (
  lock_key          text        PRIMARY KEY,
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  holder_pid        integer     NOT NULL,
  holder_host       text        NOT NULL,
  acquired_at       timestamptz NOT NULL DEFAULT now(),
  ttl_expires_at    timestamptz NOT NULL,
  last_refreshed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  cycle_locks IS 'Row-based cycle lock (ported from gbrain gbrain_cycle_locks). Plain INSERT/UPDATE/DELETE, not pg_advisory_lock — appSql() runs behind Supabase''s transaction pooler (src/db/client.ts, prepare:!isPooler), which drops session state between calls, so a session-scoped advisory lock would not reliably hold. See DECISIONS.md D111.';
COMMENT ON COLUMN cycle_locks.lock_key IS 'Generic lock namespace, e.g. cycle:<workspace_id>. Kept generic (not workspace_id as the PK) so a future per-phase lock can reuse this table without a migration.';
COMMENT ON COLUMN cycle_locks.workspace_id IS 'Tenant. Denormalized off lock_key for RLS and indexed lookup.';
COMMENT ON COLUMN cycle_locks.holder_pid IS 'PID of the holder process, for same-host dead-holder detection on crash.';
COMMENT ON COLUMN cycle_locks.holder_host IS 'Hostname of the holder. A lock whose host is not this host is never locally reaped — TTL is the only backstop for a cross-host holder (e.g. a different GitHub Actions runner).';
COMMENT ON COLUMN cycle_locks.ttl_expires_at IS 'Hard backstop: a lock past this is reapable regardless of holder liveness.';
COMMENT ON COLUMN cycle_locks.last_refreshed_at IS 'Bumped by the holder''s heartbeat. Distinguishes "alive but TTL briefly lapsed" from "actually dead".';
CREATE INDEX idx_cycle_locks_ttl ON cycle_locks (ttl_expires_at);
CREATE INDEX idx_cycle_locks_workspace ON cycle_locks (workspace_id);

ALTER TABLE cycle_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY cycle_locks_ws ON cycle_locks
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

-- ── op_checkpoints — resume state for a long-running phase ──────────────────
CREATE TABLE op_checkpoints (
  workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  op             text        NOT NULL,
  fingerprint    text        NOT NULL,
  completed_keys jsonb       NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT op_checkpoints_completed_keys_array CHECK (jsonb_typeof(completed_keys) = 'array'),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, op, fingerprint)
);
COMMENT ON TABLE  op_checkpoints IS 'Ported from gbrain op_checkpoints, workspace_id-scoped. A phase records the SET of item keys it has already completed for (workspace, op, param-fingerprint); resume = re-walk the item list, skip anything in completed_keys.';
COMMENT ON COLUMN op_checkpoints.op IS 'Phase name, e.g. noop, link_extraction (M9).';
COMMENT ON COLUMN op_checkpoints.fingerprint IS 'sha8 of canonical-JSON of the phase''s resume-relevant params, so an unrelated param change starts a fresh checkpoint instead of silently reusing a stale one.';
COMMENT ON COLUMN op_checkpoints.completed_keys IS 'JSONB array of item keys already processed. CHECK enforces array shape so a scalar value here cannot silently break every reader.';
CREATE INDEX op_checkpoints_updated_at_idx ON op_checkpoints (updated_at);

ALTER TABLE op_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY op_checkpoints_ws ON op_checkpoints
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

-- ── ingest_log — ordinary per-phase-run audit history ────────────────────────
CREATE TABLE ingest_log (
  id           bigserial   PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       uuid        NOT NULL,
  op           text        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('ok','warn','fail','skipped')),
  summary      text        NOT NULL DEFAULT '',
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  duration_ms  integer     NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  ingest_log IS 'One row per phase run (start to finish), win or lose. Ordinary run history — contrast cycle_failures, which is specifically for retry/alerting on one failing item within a run.';
COMMENT ON COLUMN ingest_log.run_id IS 'Correlates this row with cycle_budget_ledger rows written by the same phase execution.';
CREATE INDEX idx_ingest_log_ws_op_created ON ingest_log (workspace_id, op, created_at DESC);

ALTER TABLE ingest_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_log_ws ON ingest_log
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

-- ── cycle_failures — the failure ledger ──────────────────────────────────────
CREATE TABLE cycle_failures (
  id            bigserial   PRIMARY KEY,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  op            text        NOT NULL,
  item_key      text        NOT NULL,
  error_code    text        NOT NULL,
  error_message text        NOT NULL,
  attempts      integer     NOT NULL DEFAULT 1,
  state         text        NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  UNIQUE (workspace_id, op, item_key)
);
COMMENT ON TABLE  cycle_failures IS 'Ported (simplified) from gbrain sync-failure-ledger.ts, moved from a JSONL file to a table because a scheduled worker has no durable local disk across runs. Deliberately drops gbrain''s sync-specific auto_skipped state and sentinel hard-block: those are ingestion-gate policy a future M9+ phase can layer on top of attempts, not M8 infrastructure.';
COMMENT ON COLUMN cycle_failures.item_key IS 'Whatever the phase is iterating — page id, chunk id, file path. Phase-defined, opaque to the ledger.';
COMMENT ON COLUMN cycle_failures.attempts IS 'Consecutive failed runs for (workspace, op, item_key). Reset to 1 on a fresh failure after a clean run resolved it.';
CREATE INDEX idx_cycle_failures_open ON cycle_failures (workspace_id, op) WHERE state = 'open';

ALTER TABLE cycle_failures ENABLE ROW LEVEL SECURITY;
CREATE POLICY cycle_failures_ws ON cycle_failures
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));

-- ── cycle_budget_ledger — transactional spend ledger (docs/plan.md Invariant 6) ─
CREATE TABLE cycle_budget_ledger (
  id                  bigserial     PRIMARY KEY,
  workspace_id        uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  op                  text          NOT NULL,
  run_id              uuid          NOT NULL,
  model_id            text          NOT NULL,
  kind                text          NOT NULL CHECK (kind IN ('chat','embed','rerank')),
  estimated_cost_usd  numeric(12,6) NOT NULL,
  actual_cost_usd     numeric(12,6),
  cumulative_cost_usd numeric(12,6) NOT NULL,
  budget_usd          numeric(12,6) NOT NULL,
  allowed             boolean       NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT now()
);
COMMENT ON TABLE  cycle_budget_ledger IS 'Per-submit spend ledger. Unlike gbrain''s JSONL budget audit (best-effort, swallows write failures, and treats budget<=0 as "disabled"), this is a real committed Postgres row per docs/plan.md Invariant 6 ("spend caps fail CLOSED; the ledger write is transactional — gbrain''s fails open"). First real LLM usage/cost ledger in this repo — closes the gap DECISIONS.md D104 named ("spend accounting lives at M8").';
COMMENT ON COLUMN cycle_budget_ledger.allowed IS 'false rows are DENIED submits, kept for audit — a denial is not silently dropped.';
CREATE INDEX idx_cycle_budget_ledger_ws_op_run ON cycle_budget_ledger (workspace_id, op, run_id);

ALTER TABLE cycle_budget_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY cycle_budget_ledger_ws ON cycle_budget_ledger
  USING (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid));
