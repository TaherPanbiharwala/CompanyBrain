// Ordered .sql migration runner for Supabase. Runs as the OWNER (`postgres`, admin connection,
// pinned to one physical connection via adminSql max:1) so it can create the extension, the app
// role, and the schema.
//
// Conventions (see DECISIONS "Migration conventions"):
//  * schema.sql is the immutable baseline; changes go to new src/db/migrations/NNNN_*.sql
//    (zero-padded). Applied files are content-checksummed — editing an applied file fails loudly.
//  * Each file runs inside one transaction and is recorded atomically. A file needing
//    non-transactional DDL (e.g. CREATE INDEX CONCURRENTLY) must start with the pragma
//    `-- migrate:no-transaction`; such files must be individually idempotent.
import { readFile, readdir } from 'node:fs/promises';
import { createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { config, isDevEnv } from '../config.ts';
import { adminSql } from './client.ts';

const here = dirname(fileURLToPath(import.meta.url));

// Fixed key for the session-level advisory lock that serializes concurrent migrate runs.
const MIGRATE_LOCK_KEY = 4_021_970_233;

interface MigrationFile {
  name: string;
  path: string;
}

/** Numeric-aware ordering so '10_x.sql' sorts AFTER '2_x.sql' (plain lexical sort gets this wrong). */
export function orderMigrations(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Run a statement that embeds a secret via `format('%L', …)`, and make sure a failure cannot print it.
 *
 * The GUC indirection keeps the password out of the SQL we SEND — that part was already right. What
 * it does not cover: PL/pgSQL's `format('%L')` expands the literal before `EXECUTE`, and when an
 * EXECUTE fails PostgreSQL puts the FULLY EXPANDED statement into the error's CONTEXT and
 * INTERNAL QUERY fields. postgres.js copies those onto the error object as enumerable own properties
 * (`where`, `internal_query`), so `console.error('migration failed:', err)` prints the plaintext
 * password — into your terminal, and into whatever captures CI logs.
 *
 * Reachable without doing anything exotic: 42710 from a concurrent role creation, `permission denied
 * to create role`, `must have admin option on role`, or a platform password-policy hook. So the
 * fields are stripped here rather than trusted to stay clean.
 */
export async function runWithSecret(sql: postgres.Sql, statement: string, label: string): Promise<void> {
  try {
    await sql.unsafe(statement);
  } catch (err) {
    const e = err as Record<string, unknown>;
    for (const field of ['where', 'internal_query', 'query', 'detail', 'hint']) {
      if (typeof e[field] === 'string') e[field] = `[redacted: ${label} embeds a password literal]`;
    }
    throw err;
  }
}

/**
 * Does `role` ALREADY authenticate with `password`? Returns null when the verifier cannot be read or
 * parsed, which the caller treats as "don't know — go ahead and set it".
 *
 * WHY THIS EXISTS — this took the whole database offline (D63). `ALTER ROLE … PASSWORD` was issued
 * unconditionally on every migrate run, and a SCRAM verifier is SALTED WITH FRESH RANDOMNESS, so
 * re-setting the SAME password still writes a DIFFERENT verifier. Supabase's pooler caches tenant
 * SCRAM credentials, so each run invalidated that cache and produced a burst of 28P01
 * ("reconnect with fresh credentials") failures; enough of those trip Supavisor's circuit breaker,
 * which then refuses NEW CONNECTIONS ON EVERY LANE — app, auth and admin alike. Four migrate runs in
 * one afternoon was enough. `migrate` is supposed to be safe to re-run; that is the whole contract.
 *
 * Verification follows RFC 5802: SaltedPassword = PBKDF2-HMAC-SHA256(password, salt, iterations),
 * StoredKey = SHA256(HMAC(SaltedPassword, "Client Key")). Compared with timingSafeEqual out of habit
 * rather than need — both sides are already on the trusted side of the admin connection.
 */
export function scramMatches(verifier: string, password: string): boolean | null {
  // SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 StoredKey>:<base64 ServerKey>
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (!m) return null; // md5 verifier, or a shape we do not understand — do not guess.
  const [, itersRaw, saltB64, storedB64] = m;
  const iterations = Number(itersRaw);
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || !saltB64 || !storedB64) return null;
  try {
    const expected = Buffer.from(storedB64, 'base64');
    const derives = (pw: string): boolean => {
      const salted = pbkdf2Sync(pw, Buffer.from(saltB64, 'base64'), iterations, 32, 'sha256');
      const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
      return stored.length === expected.length && timingSafeEqual(stored, expected);
    };
    // Try the raw password, then its NFKC form. PostgreSQL applies SASLprep (RFC 4013) before
    // hashing, which NFKC-normalizes and maps compatibility characters — so a password containing
    // a ligature or a decomposed accent hashes to something the raw bytes never reproduce.
    //
    // MEASURED against a real server rather than reasoned about, because two reviewers disagreed on
    // whether this mattered: 'café-münchen' and 'pass word' match raw, while 'ﬁ-ligature' (U+FB01)
    // and a NFD-decomposed 'é' do NOT — and both match after .normalize('NFKC').
    //
    // Trying BOTH is deliberate and cannot weaken the check: an incorrect password fails under every
    // normalization. What it prevents is the false NEGATIVE — which is not merely cosmetic here,
    // because a false negative re-runs ALTER ROLE on every migrate and reinstates exactly the
    // credential-cache churn D63 exists to stop.
    if (derives(password)) return true;
    const prepped = password.normalize('NFKC');
    return prepped === password ? false : derives(prepped);
  } catch {
    return null;
  }
}

/** true = already correct (skip the ALTER), false = needs setting, null = cannot tell (set it). */
async function passwordAlreadyCorrect(sql: postgres.Sql, role: string, password: string): Promise<boolean | null> {
  let verifier: string | null = null;
  try {
    const rows = await sql<{ rolpassword: string | null }[]>`
      select rolpassword from pg_authid where rolname = ${role}`;
    verifier = rows[0]?.rolpassword ?? null;
  } catch {
    // pg_authid is superuser-only on some platforms. Fall back to the old behaviour rather than
    // failing the migration — the cost is the churn this function exists to avoid, not a broken run.
    return null;
  }
  if (!verifier) return null;
  return scramMatches(verifier, password);
}

const PRAGMA_NO_TX = /^\s*--\s*migrate:no-transaction\s*$/im;
// Standalone transaction-control statements the runner must reject (it wraps each file in one tx).
// Covers every Postgres synonym: BEGIN/START TRANSACTION (with optional TRANSACTION/WORK/options),
// COMMIT, END (a COMMIT synonym), ROLLBACK, ABORT. Requires the keyword to stand alone on its line
// ending in ';', so PL/pgSQL constructs inside DO $$ … $$ are NOT matched: block `begin` has no
// trailing ';', and `end $$;` / `end if;` / `end loop;` have tokens between the keyword and the ';'.
export const TXN_CONTROL =
  /^\s*(?:(?:begin|commit|end|rollback|abort)(?:\s+(?:transaction|work))?|start\s+transaction[^;]*)\s*;\s*$/im;

/** Minimum server version. `sessions`'s composite FK uses the column-list form of ON DELETE SET
 *  NULL, which is PostgreSQL 15+ syntax. */
const MIN_PG_VERSION_NUM = 150_000;

async function ensureBootstrap(sql: postgres.Sql): Promise<void> {
  // Version FIRST, before any role or extension is created.
  //
  // The requirement was documented only in two SQL comments, and one of them lives in 0001 — which
  // is applied AFTER schema.sql, i.e. after the very failure it exists to explain. On an older
  // server this used to create cb_app and cb_auth, set their passwords, install default privileges,
  // and only then die inside schema.sql with a bare `syntax error at or near "("`. It failed loudly
  // but unintelligibly, having already made changes.
  const v = await sql<{ n: number }[]>`select current_setting('server_version_num')::int as n`;
  const versionNum = v[0]?.n ?? 0;
  if (versionNum < MIN_PG_VERSION_NUM) {
    const pretty = `${Math.floor(versionNum / 10_000)}.${versionNum % 10_000}`;
    throw new Error(
      `company-brain requires PostgreSQL ${MIN_PG_VERSION_NUM / 10_000}+ — this server reports ${pretty}. ` +
        `sessions uses the column-list form of ON DELETE SET NULL (active_workspace_id), which older ` +
        `servers reject with an unhelpful syntax error partway through schema.sql.`,
    );
  }

  // pgvector. On Supabase the type may live in the `extensions` schema; keep it on the search_path.
  await sql`create extension if not exists vector`;

  const hasPassword = !!config.CB_APP_DB_PASSWORD;
  const roleRows = await sql<{ exists: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = 'cb_app') as exists`;
  const roleExists = roleRows[0]?.exists ?? false;

  if (!hasPassword && !roleExists) {
    // Applying the schema without a usable app role yields a "successful" migration whose app
    // cannot connect. Fail loudly instead (review adv #8).
    throw new Error(
      'CB_APP_DB_PASSWORD is unset and the cb_app role does not exist. Set CB_APP_DB_PASSWORD (see .env.example) or create the cb_app role manually before migrating.',
    );
  }

  // Only touch the password when it is actually wrong. See scramMatches() — an unconditional ALTER
  // rewrites the salted verifier every run and invalidates the pooler's cached credentials (D63).
  const appPwOk = hasPassword && roleExists
    ? await passwordAlreadyCorrect(sql, 'cb_app', config.CB_APP_DB_PASSWORD)
    : false;
  if (hasPassword && appPwOk === true) {
    // The old unconditional statement was `alter role cb_app LOGIN password %L`, so it also
    // re-asserted LOGIN on every run. Skipping the password must not silently drop that repair —
    // a role left NOLOGIN by an operator or an incident would otherwise stay broken through a
    // migrate that reports success. LOGIN alone touches no verifier, so it is free to re-assert.
    await sql`alter role cb_app login`;
    console.log('= cb_app password already matches CB_APP_DB_PASSWORD; not re-setting it');
  } else if (hasPassword) {
    // Password travels via a bind param into a session GUC, then into a format(%L) literal —
    // never string-concatenated into SQL.
    await sql`select set_config('cb.app_password', ${config.CB_APP_DB_PASSWORD}, false)`;
    // try/finally, because the wipe below is the whole point and an exception used to skip it: the
    // DDL throwing left the plaintext password resident in the session GUC — the exact state the
    // comment after this block says must not happen.
    try {
    await runWithSecret(sql, `do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cb_app') then
    execute format('create role cb_app login password %L nosuperuser nobypassrls nocreatedb nocreaterole noreplication', current_setting('cb.app_password'));
  else
    execute format('alter role cb_app login password %L', current_setting('cb.app_password'));
  end if;
end $$;`, 'cb_app role DDL');
    } finally {
      // Do not leave the plaintext password resident in a session GUC (review sec S10).
      await sql`select set_config('cb.app_password', '', false)`;
    }
  } else {
    console.log('= cb_app role already exists; CB_APP_DB_PASSWORD unset, leaving its password unchanged');
  }

  await sql.unsafe(`do $$ begin execute format('grant connect on database %I to cb_app', current_database()); end $$;`);
  await sql.unsafe(`do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'extensions') then
    execute 'grant usage on schema extensions to cb_app';
  end if;
end $$;`);
  await sql`grant usage on schema public to cb_app`;
  await sql`alter role cb_app set search_path = public, extensions`;
  await sql`alter default privileges in schema public grant select, insert, update, delete on tables to cb_app`;
  await sql`alter default privileges in schema public grant usage, select on sequences to cb_app`;

  await ensureAuthRole(sql);
}

/** The `cb_auth` role (M2): least-privilege login/onboarding identity. Must exist BEFORE the
 *  migration loop — `CREATE POLICY … TO cb_auth` in 0001 fails to parse if the role is absent.
 *  Deliberately gets NO `alter default privileges`: every future table would otherwise auto-grant
 *  cb_auth DML, silently widening the pre-auth surface as M4/M5 add tables. Its grants are set
 *  explicitly, from zero, by grantAuth() on every run. */
async function ensureAuthRole(sql: postgres.Sql): Promise<void> {
  const hasPassword = !!config.CB_AUTH_DB_PASSWORD;
  const roleRows = await sql<{ exists: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = 'cb_auth') as exists`;
  const roleExists = roleRows[0]?.exists ?? false;

  if (!hasPassword && !roleExists) {
    throw new Error(
      'CB_AUTH_DB_PASSWORD is unset and the cb_auth role does not exist. Set CB_AUTH_DB_PASSWORD ' +
        '(see .env.example) — it must equal the password embedded in DATABASE_AUTH_URL.',
    );
  }

  // Same idempotence rule as cb_app: never rewrite a verifier that is already correct (D63).
  const authPwOk = hasPassword && roleExists
    ? await passwordAlreadyCorrect(sql, 'cb_auth', config.CB_AUTH_DB_PASSWORD)
    : false;
  if (hasPassword && authPwOk === true) {
    await sql`alter role cb_auth login`; // see cb_app above: keep the LOGIN repair the ALTER carried
    console.log('= cb_auth password already matches CB_AUTH_DB_PASSWORD; not re-setting it');
  } else if (hasPassword) {
    // Same posture as cb_app: the password travels as a bind param into a session GUC, then into a
    // format(%L) literal — never string-concatenated into SQL — and is wiped immediately after.
    await sql`select set_config('cb.auth_password', ${config.CB_AUTH_DB_PASSWORD}, false)`;
    try { // see cb_app above — the wipe must survive a failing DDL
    await runWithSecret(sql, `do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cb_auth') then
    execute format('create role cb_auth login password %L nosuperuser nobypassrls nocreatedb nocreaterole noreplication', current_setting('cb.auth_password'));
  else
    execute format('alter role cb_auth login password %L', current_setting('cb.auth_password'));
  end if;
end $$;`, 'cb_auth role DDL');
    } finally {
      await sql`select set_config('cb.auth_password', '', false)`;
    }
  } else {
    console.log('= cb_auth role already exists; CB_AUTH_DB_PASSWORD unset, leaving its password unchanged');
  }

  await sql.unsafe(`do $$ begin execute format('grant connect on database %I to cb_auth', current_database()); end $$;`);
  await sql`grant usage on schema public to cb_auth`;
  await sql`alter role cb_auth set search_path = public, extensions`;
}

/** Both the pooled client and a transaction handle satisfy this — the grant helpers below MUST be
 *  callable inside `sql.begin` so the widen and the narrow commit atomically. */
type SqlLike = postgres.Sql | postgres.TransactionSql;

async function grantExisting(sql: SqlLike): Promise<void> {
  // Grant DML on every table EXCEPT the migration ledger — cb_app must never be able to rewrite
  // migration history (review sec S2 / data-mig D7).
  //
  // This revoke is load-bearing on its own terms: `grant … on all tables` immediately above has just
  // re-granted full DML on _migrations, so without it the ledger would be writable. It also strips
  // whatever a previous run left. The ledger is additionally revoked at creation time in run(), so a
  // mid-migration failure never leaves cb_app able to write it.
  //
  // (An earlier version of this comment claimed _migrations has RLS DISABLED and that GRANTs were
  // therefore the only control. That was false — Supabase ships an `rls_auto_enable` event trigger
  // that turns RLS on for every new table, so the ledger is RLS-enabled with zero policies, i.e.
  // default-deny for both roles.
  //
  // A LATER version of this comment then claimed `bun run doctor` asserts that state. It does not:
  // doctor.ts EXEMPTS _migrations from both RLS checks by name (`and c.relname <> '_migrations'`)
  // precisely because it is deliberately policy-less. So the RLS posture here is INFERRED from the
  // event trigger, not verified — and on a non-Supabase Postgres, or if that trigger changes, the
  // ledger would be created with RLS off and nothing would say so. The REVOKE on the next line is
  // the control that is actually asserted and actually load-bearing; treat RLS here as a bonus.)
  await sql`grant select, insert, update, delete on all tables in schema public to cb_app`;
  await sql`revoke all on table _migrations from cb_app`;
  await sql`grant usage, select on all sequences in schema public to cb_app`;
}

/** cb_auth's table grants. Starts from ZERO every run (the REVOKE ALL below), then re-grants
 *  exactly what login + onboarding need — so a privilege added by hand, or inherited from some
 *  future default-privilege change, is stripped on the next migrate rather than accumulating.
 *  cb_auth gets NOTHING on teams, team_memberships, acl_grants, pages, content_chunks, _migrations. */
async function grantAuth(sql: SqlLike): Promise<void> {
  await sql`revoke all on all tables in schema public from cb_auth`;
  await sql`grant select, insert on principals to cb_auth`;
  // Column-restricted: cb_auth refreshes the profile + the invite-matching key on every login, but
  // google_sub is NOT here — the identity binding is written only by cb_internal.adopt_principal,
  // whose `google_sub IS NULL` guard lives in the database rather than in a TypeScript string.
  await sql`grant update (name, email, email_normalized, updated_at) on principals to cb_auth`;
  await sql`grant select, insert on sessions to cb_auth`;
  await sql`grant update (active_workspace_id) on sessions to cb_auth`;
  await sql`grant select, insert on workspaces to cb_auth`;
  await sql`grant select, insert on workspace_members to cb_auth`;
  await sql`grant select on invites to cb_auth`;
  await sql`grant update (status, accepted_by) on invites to cb_auth`;
  // READ ONLY, deliberately. Onboarding must consult the block list before auto-joining by domain,
  // but a login lane that could delete its own block would not be a block at all.
  await sql`grant select on workspace_domain_blocks to cb_auth`;
}

/** The cb_app deny-matrix. MUST run after grantExisting, which re-grants
 *  `select,insert,update,delete on ALL tables` on EVERY run — so anything revoked in a migration
 *  file is silently re-broadened moments later. This is the only place those privileges are
 *  actually narrowed, and `bun run doctor` diffs the result against a checked-in fixture.
 *
 *  Ordering matters twice over: a table-level grant DOMINATES a column-level grant, so every
 *  column GRANT below must be preceded by a table-level REVOKE of the same privilege. */
async function narrowGrants(sql: SqlLike): Promise<void> {
  // Identity rows are written only by cb_auth (and google_sub only by a definer function).
  await sql`revoke insert, update, delete on principals from cb_app`;
  // Sessions are read and written exclusively through cb_internal.* definer functions, so the
  // tenant-facing role needs no privilege on the table at all — not even SELECT.
  await sql`revoke all on sessions from cb_app`;
  // Without this revoke, `UPDATE workspaces SET domain='bigco.com'` passes workspaces_current
  // (USING-only, so the USING expression doubles as the write check) and steals an entire org's
  // auto-join. The domain claim path is guarded in app code; this makes the mutation path
  // structurally impossible.
  await sql`revoke insert, update, delete on workspaces from cb_app`;
  await sql`grant update (name) on workspaces to cb_app`;
  // WITH CHECK(false) blocks INSERT/UPDATE but NOT DELETE (Postgres governs DELETE by USING alone).
  // Without these revokes any member could DELETE their own workspace row — cascading away every
  // page and chunk in the tenant — or delete every colleague's membership.
  await sql`revoke insert, update, delete on workspace_members from cb_app`;
  await sql`revoke insert, update, delete on acl_grants from cb_app`;
  await sql`revoke insert, update, delete on teams from cb_app`;
  await sql`revoke insert, update, delete on team_memberships from cb_app`;
  // Read-only for cb_app too: a request lane that could delete a block could re-admit a removed
  // member simply by clearing the tombstone. Writes are admin-only until the M5 removal UI.
  await sql`revoke insert, update, delete on workspace_domain_blocks from cb_app`;
  // create_invite (an admin-gated op) INSERTs; revocation flips status rather than deleting. UPDATE
  // must be revoked at table level first or the column grant below is decoration.
  await sql`revoke update, delete on invites from cb_app`;
  await sql`grant update (status) on invites to cb_app`;
  // The stored source file is immutable: replace_page deletes the row and inserts a new one, so the
  // bytes and the sha256 that identifies them can never diverge through a partial UPDATE. INSERT and
  // DELETE stay — ingest writes, delete_page/replace_page reap.
  // GUARDED ON EXISTENCE, matching the pattern ensureAuthFunctions already uses for
  // current_grants(). These revokes name tables created by migration 0009, and 0010's own footer
  // tells a future operator to remove them "as its own migration" — the moment such a DROP commits,
  // an unguarded revoke here throws 42P01 and rolls back the ENTIRE grant transaction
  // (grantExisting + grantAuth + narrowGrants + ensureAuthFunctions). Since the DROP is already
  // recorded in _migrations, every subsequent `bun run migrate` fails identically until someone
  // edits TypeScript — a schema change bricking the runner that applies schema changes.
  //
  // rls-exempt: privilege DDL on the owner pool, not a row read. This is the code that DEFINES what
  // cb_app may do to these tables; running it on a scoped tx is not a stricter version of it.
  await sql.unsafe(`
DO $$ BEGIN
  -- The stored source file is immutable: replace_page deletes the row and inserts a new one, so the
  -- bytes and the sha256 that identifies them can never diverge through a partial UPDATE.
  IF to_regclass('public.page_sources') IS NOT NULL THEN
    EXECUTE 'revoke update on page_sources from cb_app';
  END IF;
  -- A quarantine verdict is a record of what the gate decided, so it must not be editable — a
  -- rewritable reason is not evidence. INSERT and DELETE stay: the gate writes, and a user may
  -- discard their own rejected upload.
  IF to_regclass('public.quarantine') IS NOT NULL THEN
    EXECUTE 'revoke update on quarantine from cb_app';
  END IF;
END $$;`);
  // Unchanged, full DML: pages, content_chunks. Unchanged: _migrations stays fully revoked.
}

/** The SECURITY DEFINER surface (G3): the entire pre-context read path, reduced from "cb_auth can
 *  read five tables unconditionally" to five fixed function signatures.
 *
 *  Deliberately NOT in a checksummed migration. `CREATE OR REPLACE FUNCTION` grants EXECUTE to
 *  PUBLIC by default, so the REVOKE is load-bearing and must be re-asserted on EVERY run — a later
 *  DROP+CREATE for a signature change would otherwise silently restore public execute. Runs last,
 *  in its own transaction, so the create and the revoke land together. */
// Takes a transaction handle: run() calls it INSIDE the grant transaction so the definers and the
// revokes that depend on them commit or roll back together. It no longer opens its own — a nested
// sql.begin would be a savepoint, which would let the inner work roll back while the outer grants
// stayed, reintroducing exactly the split-state this is meant to prevent.
async function ensureAuthFunctions(tx: SqlLike): Promise<void> {
  {
    await tx.unsafe(`
CREATE SCHEMA IF NOT EXISTS cb_internal AUTHORIZATION postgres;
REVOKE ALL   ON SCHEMA cb_internal FROM PUBLIC;
GRANT  USAGE ON SCHEMA cb_internal TO cb_app;
GRANT  USAGE ON SCHEMA cb_internal TO cb_auth;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM cb_app;
REVOKE CREATE ON SCHEMA public FROM cb_auth;

-- (1) The ONLY pre-context read on the hot path. Hash in, four scalars out. It takes NO workspace
-- or principal parameter ON PURPOSE: a (principal, workspace) argument would make it a membership
-- oracle keyed on request input, which is exactly the D25 violation the whole design exists to
-- prevent. workspace_id and member_role are selected ONLY from the membership row, so "no
-- membership => no workspace" is structural rather than a code convention.
CREATE OR REPLACE FUNCTION cb_internal.resolve_session(p_token_hash text)
RETURNS TABLE (reason text, principal_id uuid, workspace_id uuid, member_role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT
    CASE WHEN s.expires_at <= now()         THEN 'expired'
         WHEN s.epoch <> p.session_epoch    THEN 'epoch_stale'
         WHEN s.active_workspace_id IS NULL THEN 'no_active_ws'
         WHEN m.principal_id IS NULL        THEN 'membership_revoked'
         ELSE 'ok' END AS reason,
    CASE WHEN s.expires_at > now() AND s.epoch = p.session_epoch THEN s.principal_id END,
    CASE WHEN s.expires_at > now() AND s.epoch = p.session_epoch THEN m.workspace_id END,
    CASE WHEN s.expires_at > now() AND s.epoch = p.session_epoch THEN m.role END
  FROM public.sessions   s
  JOIN public.principals p ON p.id = s.principal_id
  LEFT JOIN public.workspace_members m
         ON m.workspace_id = s.active_workspace_id AND m.principal_id = s.principal_id
  WHERE s.token_hash = p_token_hash
  LIMIT 1
$fn$;

-- (2) Logout, this session only. Token-keyed so cb_app cannot delete arbitrary sessions.
CREATE OR REPLACE FUNCTION cb_internal.revoke_session(p_token_hash text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$ DELETE FROM public.sessions WHERE token_hash = p_token_hash $fn$;

-- (3) Sign out everywhere. Also token-keyed: taking the principal as an argument would hand any
-- cb_app holder a targeted "log this user out" primitive. The expires_at guard means a stale
-- cookie cannot trigger it.
CREATE OR REPLACE FUNCTION cb_internal.revoke_all_sessions(p_token_hash text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$ UPDATE public.principals SET session_epoch = session_epoch + 1
        WHERE id = (SELECT s.principal_id FROM public.sessions s
                    WHERE s.token_hash = p_token_hash AND s.expires_at > now()) $fn$;

-- (4) D25 for session-less callers (bun run call, the MCP bridge, the A17 scripts): the env says
-- WHICH principal and workspace, this says whether that pair is real and what the role actually is.
CREATE OR REPLACE FUNCTION cb_internal.membership_role(p_principal uuid, p_workspace uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$ SELECT m.role FROM public.workspace_members m
        WHERE m.principal_id = p_principal AND m.workspace_id = p_workspace $fn$;

-- (5) One-time account link, called ONLY from the 23505 branch of the login upsert. Returns NULL
-- when the row was already claimed by a different sub, which the caller turns into 409
-- account_conflict. Keeping the IS NULL guard here is what lets cb_auth refresh a profile without
-- ever holding UPDATE on principals.google_sub.
CREATE OR REPLACE FUNCTION cb_internal.adopt_principal(p_id uuid, p_sub text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$ UPDATE public.principals SET google_sub = p_sub, updated_at = now()
        WHERE id = p_id AND google_sub IS NULL RETURNING id $fn$;

-- Postgres grants EXECUTE to PUBLIC on every new function. Without this REVOKE the definers would
-- be callable by every role the moment they are created, inverting the whole design.
REVOKE ALL ON FUNCTION cb_internal.resolve_session(text), cb_internal.revoke_session(text),
  cb_internal.revoke_all_sessions(text), cb_internal.membership_role(uuid,uuid),
  cb_internal.adopt_principal(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cb_internal.resolve_session(text), cb_internal.revoke_session(text),
  cb_internal.revoke_all_sessions(text), cb_internal.membership_role(uuid,uuid) TO cb_app;
GRANT EXECUTE ON FUNCTION cb_internal.adopt_principal(uuid,text) TO cb_auth;

-- public.current_grants() is CREATED by migration 0007, not here — a policy cannot reference a
-- function this helper has not made yet, because ensureAuthFunctions runs AFTER the migration loop.
-- Its ACL is re-asserted on every run for the same reason the definers' is: a later DROP+CREATE for
-- a signature change would silently restore PUBLIC EXECUTE, and the GRANT is what stands between
-- cb_app and a 42501 on every single content query. Guarded so a database that has not reached 0007
-- yet (a fresh clone mid-migrate) does not fail here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'current_grants') THEN
    REVOKE ALL ON FUNCTION public.current_grants() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.current_grants() TO cb_app;
  END IF;
END $$;
`);
  }
}

async function collectFiles(): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [{ name: 'schema.sql', path: join(here, 'schema.sql') }];
  try {
    const dir = join(here, 'migrations');
    const names = orderMigrations((await readdir(dir)).filter((n) => n.endsWith('.sql')));
    for (const n of names) files.push({ name: `migrations/${n}`, path: join(dir, n) });
  } catch {
    // no migrations dir yet — schema.sql only
  }
  return files;
}

/**
 * Split a SQL script into individual statements on top-level semicolons.
 *
 * ONLY used by the no-transaction path, and it exists because that path was broken. Sending a
 * multi-statement string through `sql.unsafe()` uses the simple query protocol, and Postgres wraps a
 * multi-statement simple query in an IMPLICIT transaction block — so `CREATE INDEX CONCURRENTLY`
 * failed with 25001 "cannot run inside a transaction block", which is the exact statement the pragma
 * and the migrations README exist to support. The pragma had never worked; nothing had used it yet.
 *
 * Semicolons are only statement terminators when they are not inside something. This tracks the four
 * things that can contain one: line comments, block comments, single-quoted literals, and
 * dollar-quoted bodies (`$$ … $$` / `$tag$ … $tag$`, which is how every DO block in this repo is
 * written). Double-quoted identifiers can contain a semicolon too and are tracked for completeness.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          // Doubled quote is an escaped quote, not a terminator.
          if (sql[i + 1] === ch) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      const stmt = sql.slice(start, i).trim();
      if (stmt) out.push(stmt);
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

async function applyFile(sql: postgres.Sql, file: MigrationFile, text: string): Promise<void> {
  const checksum = sha256(text);
  if (PRAGMA_NO_TX.test(text)) {
    // Non-transactional: statements can't be rolled back together. The file must be idempotent.
    //
    // ONE STATEMENT PER ROUND TRIP, deliberately. A multi-statement `unsafe()` is a simple query,
    // which Postgres runs in an implicit transaction — defeating the entire point of the pragma.
    console.log(`+ applying ${file.name} (no-transaction)`);
    for (const stmt of splitStatements(text)) {
      await sql.unsafe(stmt);
    }
    await sql`insert into _migrations (filename, checksum) values (${file.name}, ${checksum})`;
    return;
  }
  if (TXN_CONTROL.test(text)) {
    throw new Error(
      `${file.name} contains a top-level BEGIN/COMMIT/ROLLBACK. The runner wraps each file in one transaction; remove the statement, or add the '-- migrate:no-transaction' pragma if it genuinely needs to run outside a transaction.`,
    );
  }
  console.log(`+ applying ${file.name}`);
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`insert into _migrations (filename, checksum) values (${file.name}, ${checksum})`;
  });
}

async function run(): Promise<void> {
  if (!config.DATABASE_ADMIN_URL) {
    throw new Error('DATABASE_ADMIN_URL is not set (Supabase `postgres` connection). See .env.example.');
  }
  // The README states that `bun run migrate` refuses to start without the auth lane. It did not:
  // migrate never read DATABASE_AUTH_URL (it appeared once, inside an error string), and the only
  // auth-lane requirement was CB_AUTH_DB_PASSWORD — and even that fired only when the cb_auth role
  // did not already exist. So a fresh clone could migrate "successfully" and then 500 on the first
  // login, which is the fresh-clone failure P0-5 was supposed to have closed.
  //
  // Making the documented behaviour real rather than deleting the sentence: migrate CREATES the
  // cb_auth role, so it is the right place to insist the URL that role is reached through exists.
  // Checked here, before any connection, so the message arrives instead of a confusing later error.
  if (!config.DATABASE_AUTH_URL) {
    throw new Error(
      'DATABASE_AUTH_URL is not set. migrate creates the cb_auth role, and the app needs this URL to ' +
        'use it — without it every login fails at runtime with a much less obvious error. It is the ' +
        'transaction pooler (port 6543) with username cb_auth.<project-ref>. See .env.example.',
    );
  }
  const sql = adminSql();
  // Serialize concurrent migrate runs (session-level advisory lock; adminSql is max:1).
  await sql`select pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
  try {
    // Make sure the vector type resolves during schema application regardless of where it lives.
    await sql`set search_path to public, extensions`;
    await ensureBootstrap(sql);

    await sql`
      create table if not exists _migrations (
        filename   text primary key,
        checksum   text,
        applied_at timestamptz not null default now()
      )
    `;
    await sql`alter table _migrations add column if not exists checksum text`;
    // Revoke the ledger from cb_app NOW (it inherited the default-privilege DML grant on creation),
    // so even if a migration below fails before grantExisting runs, the app role can never write
    // migration history. cb_app exists by here (ensureBootstrap created/verified it).
    await sql`revoke all on table _migrations from cb_app`;

    const appliedRows = await sql<{ filename: string; checksum: string | null }[]>`
      select filename, checksum from _migrations`;
    const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

    for (const file of await collectFiles()) {
      const text = await readFile(file.path, 'utf8');
      if (applied.has(file.name)) {
        const prior = applied.get(file.name);
        const now = sha256(text);
        // A NULL checksum silently exempts a file from immutability FOREVER. The column was added
        // retroactively (`add column if not exists checksum text`), so a row can legitimately
        // predate it — and the natural manual repair, `insert into _migrations (filename) values
        // (…)`, writes exactly that. Treat missing like mismatched: unverified is not verified.
        if (prior == null) {
          throw new Error(
            `${file.name} is recorded as applied but has NO checksum, so its contents cannot be verified. ` +
              `Set it deliberately: UPDATE _migrations SET checksum = '${now}' WHERE filename = '${file.name}'; ` +
              `— only after confirming the file matches what is actually in the database.`,
          );
        }
        if (prior !== now) {
          throw new Error(
            `${file.name} was already applied but its contents changed (checksum drift). Applied files are immutable.\n` +
              `  * If the edit was a MISTAKE: revert it (git checkout -- ${file.name}) and put the change in a new src/db/migrations/NNNN_*.sql.\n` +
              `  * If the edit is SEMANTICALLY INERT (a comment or whitespace fix) and the database already matches: re-point the ledger, non-destructively —\n` +
              `      UPDATE _migrations SET checksum = '${now}' WHERE filename = '${file.name}';\n` +
              `    Review \`git diff ${file.name}\` first and never set the checksum to NULL.\n` +
              `  * Do NOT reach for migrate:reset — it DESTROYS the database. See docs/auth-setup.md.`,
          );
        }
        console.log(`= ${file.name} (already applied)`);
        continue;
      }
      await applyFile(sql, file, text);
    }

    // ONE transaction. GRANT/REVOKE are fully transactional in Postgres, and grantExisting MUST be
    // inside it: it re-grants full DML on every table, so a transaction that began after it
    // committed would leave exactly the window it claims to close — cb_app holding
    // INSERT/UPDATE/DELETE on principals, sessions, workspace_members and acl_grants for however
    // long narrowGrants takes to run.
    //
    // ensureAuthFunctions is INSIDE the same transaction for the same reason. narrowGrants revokes
    // everything on `sessions` from cb_app on the understanding that cb_internal.resolve_session
    // replaces that access. If the definers were a separate commit and failed — a network blip, a
    // return-type change that CREATE OR REPLACE refuses — the database would be left committed in a
    // state where cb_app has neither the table nor the function: every authenticated request fails,
    // with no down path and nothing to roll back to. Fail-closed, but a total outage.
    try {
      await sql.begin(async (tx) => {
        await grantExisting(tx);
        await grantAuth(tx);
        await narrowGrants(tx);
        await ensureAuthFunctions(tx);
      });
    } catch (err) {
      console.error('SECURITY POSTURE NOT APPLIED — the grant matrix was rolled back. Re-run `bun run migrate`.');
      throw err;
    }
    console.log('migrations complete — run `bun run doctor` to verify the security posture');
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATE_LOCK_KEY})`;
    await sql.end();
  }
}

/** The Supabase project this connection string points at.
 *
 *  Supabase pooler usernames are `<role>.<project-ref>`, and the project ref is the only part of the
 *  connection string that actually distinguishes one project from another. `current_database()` does
 *  NOT: every Supabase project's database is literally named `postgres`, so confirming on the
 *  database name asked the operator to type the same word for their scratch project and for the one
 *  holding the corpus. Returns '' when the shape is unrecognized, which fails the check closed. */
export function projectRefOf(adminUrl: string): string {
  try {
    const user = decodeURIComponent(new URL(adminUrl).username);
    const dot = user.indexOf('.');
    return dot > 0 ? user.slice(dot + 1) : '';
  } catch {
    return '';
  }
}

/** `bun run migrate:reset` — drop everything and re-migrate. Applied files are checksum-immutable,
 *  so this is the only way to iterate on 0001 before it is frozen. THIS DESTROYS ALL DATA, and
 *  there is exactly one Supabase project (it holds the A17 corpus), so it refuses unless all three
 *  independent confirmations line up, and prints what it is about to delete first. */
async function reset(): Promise<void> {
  const confirm = process.env.CB_CONFIRM_RESET ?? '';
  // isDevEnv, not DEV_ENVS.has — the third of the three drifted copies config.ts names. NODE_ENV
  // defaults to 'development', so an unset variable passed this gate too. Lower severity than the
  // auth gates only because --yes-destroy and CB_CONFIRM_RESET=<project-ref> still stand behind it;
  // the point of isDevEnv is that there is now one answer to this question, not three.
  if (!isDevEnv(config)) {
    const shown = config.nodeEnvExplicit ? JSON.stringify(config.NODE_ENV) : '(unset — it defaults to "development")';
    throw new Error(`migrate:reset refuses to run with NODE_ENV=${shown} (must be EXPLICITLY development or test).`);
  }
  if (!process.argv.includes('--yes-destroy')) {
    throw new Error('migrate:reset requires the explicit flag --yes-destroy.');
  }

  // Confirm on the PROJECT REF, not the database name. Three "independent" confirmations that all
  // reduce to typing `postgres` are one confirmation wearing three hats.
  const ref = projectRefOf(config.DATABASE_ADMIN_URL);
  if (!ref) {
    throw new Error(
      'migrate:reset cannot identify the Supabase project from DATABASE_ADMIN_URL (expected a ' +
        '"postgres.<project-ref>" username). Refusing to destroy a target it cannot name.',
    );
  }
  if (confirm !== ref) {
    throw new Error(
      `migrate:reset requires CB_CONFIRM_RESET to equal the Supabase PROJECT REF of the target — ` +
        `not the database name, which is "postgres" for every Supabase project. ` +
        `Got ${JSON.stringify(confirm)}, expected ${JSON.stringify(ref)}.`,
    );
  }

  const sql = adminSql();
  // Hold the migrate lock across the drop AND the re-run. Previously reset() dropped the schema
  // without it, so a concurrent `bun run migrate` that legitimately held the lock could have the
  // public schema — including the _migrations ledger it was mid-write on — deleted underneath it.
  await sql`select pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
  try {
    const dbRows = await sql<{ db: string }[]>`select current_database() as db`;
    console.warn(`\n⚠️  DESTROYING ALL DATA in project "${ref}" (database "${dbRows[0]?.db}"). Current contents:`);

    // REAL counts, not n_live_tup. That column is an autovacuum/ANALYZE estimate and reads 0 for any
    // table not analyzed since insert — so the one display that exists to stop a mistake could
    // cheerfully print "pages ~0 rows" for the corpus this guard is protecting.
    const tables = await sql<{ tbl: string }[]>`
      select relname as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by relname`;
    if (tables.length === 0) console.warn('   (no tables)');
    let total = 0;
    for (const t of tables) {
      const r = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public."${t.tbl.replace(/"/g, '""')}"`);
      const n = r[0]?.n ?? 0;
      total += n;
      console.warn(`   ${t.tbl.padEnd(26)} ${n} rows`);
    }
    console.warn(`\n   ${total} rows total will be destroyed.`);

    // A pause with nothing consuming the output is not a confirmation, but it is the difference
    // between noticing and not. Ctrl-C works here.
    console.warn('   Proceeding in 5s — Ctrl-C to abort.\n');
    await new Promise((r) => setTimeout(r, 5_000));

    await sql.unsafe(`DROP SCHEMA IF EXISTS cb_internal CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;`);
    console.log('schemas dropped; re-running migrations…');
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATE_LOCK_KEY})`;
  }
  await run();
}

// Only run when invoked directly (`bun run migrate`), so tests can import orderMigrations etc.
if (import.meta.main) {
  const task = process.argv.includes('--reset') ? reset : run;
  task().catch((err) => {
    console.error('migration failed:', err);
    process.exit(1);
  });
}
