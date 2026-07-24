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
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { config } from '../config.ts';
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

const PRAGMA_NO_TX = /^\s*--\s*migrate:no-transaction\s*$/im;
// Standalone transaction-control statements the runner must reject (it wraps each file in one tx).
// Covers every Postgres synonym: BEGIN/START TRANSACTION (with optional TRANSACTION/WORK/options),
// COMMIT, END (a COMMIT synonym), ROLLBACK, ABORT. Requires the keyword to stand alone on its line
// ending in ';', so PL/pgSQL constructs inside DO $$ … $$ are NOT matched: block `begin` has no
// trailing ';', and `end $$;` / `end if;` / `end loop;` have tokens between the keyword and the ';'.
export const TXN_CONTROL =
  /^\s*(?:(?:begin|commit|end|rollback|abort)(?:\s+(?:transaction|work))?|start\s+transaction[^;]*)\s*;\s*$/im;

async function ensureBootstrap(sql: postgres.Sql): Promise<void> {
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

  if (hasPassword) {
    // Password travels via a bind param into a session GUC, then into a format(%L) literal —
    // never string-concatenated into SQL.
    await sql`select set_config('cb.app_password', ${config.CB_APP_DB_PASSWORD}, false)`;
    await sql.unsafe(`do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cb_app') then
    execute format('create role cb_app login password %L nosuperuser nobypassrls nocreatedb nocreaterole noreplication', current_setting('cb.app_password'));
  else
    execute format('alter role cb_app login password %L', current_setting('cb.app_password'));
  end if;
end $$;`);
    // Do not leave the plaintext password resident in a session GUC (review sec S10).
    await sql`select set_config('cb.app_password', '', false)`;
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
}

async function grantExisting(sql: postgres.Sql): Promise<void> {
  // Grant DML on every table EXCEPT the migration ledger — cb_app must never be able to rewrite
  // migration history (review sec S2 / data-mig D7). NOTE: _migrations has RLS DISABLED, so "no
  // policy" is NOT default-deny — table GRANTs fully govern it, so this revoke is load-bearing (it
  // also strips the DML that `grant … on all tables` just re-granted). The ledger is additionally
  // revoked at creation time in run(), so a mid-migration failure never leaves cb_app able to write it.
  await sql`grant select, insert, update, delete on all tables in schema public to cb_app`;
  await sql`revoke all on table _migrations from cb_app`;
  await sql`grant usage, select on all sequences in schema public to cb_app`;
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

async function applyFile(sql: postgres.Sql, file: MigrationFile, text: string): Promise<void> {
  const checksum = sha256(text);
  if (PRAGMA_NO_TX.test(text)) {
    // Non-transactional: statements can't be rolled back together. The file must be idempotent.
    console.log(`+ applying ${file.name} (no-transaction)`);
    await sql.unsafe(text);
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
        if (prior && prior !== now) {
          throw new Error(
            `${file.name} was already applied but its contents changed (checksum drift). Applied files are immutable — revert the edit and add a new src/db/migrations/NNNN_*.sql instead.`,
          );
        }
        console.log(`= ${file.name} (already applied)`);
        continue;
      }
      await applyFile(sql, file, text);
    }

    await grantExisting(sql);
    console.log('migrations complete');
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATE_LOCK_KEY})`;
    await sql.end();
  }
}

// Only run when invoked directly (`bun run migrate`), so tests can import orderMigrations etc.
if (import.meta.main) {
  run().catch((err) => {
    console.error('migration failed:', err);
    process.exit(1);
  });
}
