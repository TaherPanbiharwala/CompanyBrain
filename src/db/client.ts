// Postgres access (Supabase).
//   * `appSql()` — the app pool, connected as the NON-BYPASSRLS role `cb_app` via the transaction
//     pooler. All request traffic uses this so RLS policies apply (DECISIONS D5, D7, D22). Lazy so
//     that merely importing this module (e.g. from a test that only needs adminSql) doesn't open a
//     pool, and so an unset DATABASE_URL fails loudly instead of silently hitting localhost.
//   * `adminSql()` — the `postgres` owner pool (session pooler), used ONLY by migrate.ts.
//   * `withScopedTx(ctx, fn)` — opens a transaction and sets the tx-local GUCs the RLS policies
//     read. It must wrap DB work ONLY, never the LLM call (pool exhaustion; DECISIONS D6).
import postgres from 'postgres';
import { config } from '../config.ts';
import { serializeGrants, type OperationContext } from '../core/context.ts';

export function sslOption(): 'require' | 'prefer' | 'verify-full' | false {
  switch (config.DB_SSL) {
    case '':
    case 'disable':
    case 'false':
      return false;
    case 'prefer':
      return 'prefer';
    case 'verify-full':
      return 'verify-full';
    default:
      return 'require';
  }
}

let _app: postgres.Sql | null = null;
export function appSql(): postgres.Sql {
  if (!_app) {
    if (!config.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set (Supabase cb_app connection). See .env.example.');
    }
    _app = postgres(config.DATABASE_URL, {
      prepare: !config.isPooler, // prepare:false behind the tx pooler so SET LOCAL GUCs are pool-safe
      ssl: sslOption(),
      max: config.DB_POOL_MAX,
      idle_timeout: config.DB_IDLE_TIMEOUT,
      connect_timeout: config.DB_CONNECT_TIMEOUT,
      // Bound a runaway query / abandoned open tx so a stuck statement can't pin a pooled connection
      // indefinitely and hang the fleet (set as GUCs on every cb_app connection).
      connection: {
        statement_timeout: config.DB_STATEMENT_TIMEOUT,
        idle_in_transaction_session_timeout: config.DB_IDLE_IN_TX_TIMEOUT,
      },
      onnotice: () => {},
    });
  }
  return _app;
}

let _admin: postgres.Sql | null = null;
export function adminSql(): postgres.Sql {
  // max:1 pins bootstrap to ONE physical connection so session state (search_path, the
  // cb.app_password GUC, the advisory lock) set by one statement is visible to the next.
  if (!_admin) {
    if (!config.DATABASE_ADMIN_URL) {
      throw new Error('DATABASE_ADMIN_URL is not set (Supabase postgres connection). See .env.example.');
    }
    _admin = postgres(config.DATABASE_ADMIN_URL, { prepare: false, ssl: sslOption(), max: 1, onnotice: () => {} });
  }
  return _admin;
}

/** End both pools AND reset the singletons so a later appSql()/adminSql() re-creates fresh ones.
 *  Tests must use this (not `pool.end()`) so live test files don't hand each other a dead pool.
 *  Test-only helper: the null-before-await ordering is intentional (a concurrent appSql() must not
 *  reuse a pool that is mid-close). Safe because test files run sequentially. */
export async function closePools(opts: { timeout?: number } = {}): Promise<void> {
  const timeout = opts.timeout ?? 5;
  const app = _app;
  const admin = _admin;
  _app = null;
  _admin = null;
  if (app) await app.end({ timeout });
  if (admin) await admin.end({ timeout });
}

/**
 * Run `fn` inside a transaction bound to the caller's tenant + keyring via tx-local GUCs
 * (`set_config(..., true)` = local to this transaction, released at commit). Only ever wrap
 * database work in here — generate LLM answers OUTSIDE this transaction (DECISIONS D6).
 */
export async function withScopedTx<T>(
  ctx: OperationContext,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // Last-hop fail-closed backstop: never bind an empty keyring (buildContext already enforces this).
  if (ctx.grants.length === 0) throw new Error('withScopedTx: empty grants keyring');
  const grantsCsv = serializeGrants(ctx.grants);
  return appSql().begin(async (tx) => {
    // All three GUCs in one round trip — the tx-pooler backend slot is the scarce resource (D6).
    await tx`select
      set_config('app.workspace', ${ctx.workspaceId}, true),
      set_config('app.principal', ${ctx.principal}, true),
      set_config('app.grants', ${grantsCsv}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
