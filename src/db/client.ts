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

let _auth: postgres.Sql | null = null;
/** The `cb_auth` pool (M2): least-privilege, NOBYPASSRLS, used ONLY for login/onboarding writes.
 *  NEVER touched on the /api/:op hot path — that goes through cb_internal.resolve_session on the
 *  cb_app pool (G3). Small `max` on purpose: it is reachable pre-authentication, so a junk-cookie
 *  flood must not be able to starve anything else. Fatal on FIRST USE (not at import) so the
 *  offline unit suite still boots without auth credentials. */
export function authSql(): postgres.Sql {
  if (!_auth) {
    if (!config.DATABASE_AUTH_URL) {
      throw new Error('DATABASE_AUTH_URL is not set (Supabase cb_auth connection). See .env.example.');
    }
    _auth = postgres(config.DATABASE_AUTH_URL, {
      prepare: !config.isPooler,
      ssl: sslOption(),
      max: 3,
      idle_timeout: config.DB_IDLE_TIMEOUT,
      connect_timeout: config.DB_CONNECT_TIMEOUT,
      connection: {
        statement_timeout: config.DB_STATEMENT_TIMEOUT,
        idle_in_transaction_session_timeout: config.DB_IDLE_IN_TX_TIMEOUT,
      },
      onnotice: () => {},
    });
  }
  return _auth;
}

// ── Pool identity assertions ──────────────────────────────────────────────
// The likeliest catastrophic M2 misconfiguration is pasting DATABASE_ADMIN_URL into
// DATABASE_AUTH_URL: the strings differ by ~10 characters, every pre-auth query then runs as the
// RLS-BYPASSING owner, and every test still passes. These assert the role each pool actually
// connected as. Deliberately LAZY (not inside appSql(), which is synchronous) and memoized, so the
// cost is one round trip per pool per process. A rejection clears the memo so a transient network
// failure doesn't permanently poison the pool.
export async function verifyPoolRole(sql: postgres.Sql, expected: string): Promise<void> {
  const rows = await sql<{ cur: string; bypass: boolean | null }[]>`
    select current_user as cur,
           (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
  const row = rows[0];
  if (!row) throw new Error(`pool identity check for ${expected} returned no row`);
  if (row.cur !== expected) {
    throw new Error(
      `Pool identity mismatch: connected as "${row.cur}" but expected "${expected}". ` +
        `Check the connection string — DATABASE_URL must be the cb_app role, DATABASE_AUTH_URL the ` +
        `cb_auth role, and neither may be the postgres owner. (Supabase's pooler username is ` +
        `"${expected}.<project-ref>"; current_user is the bare role name.)`,
    );
  }
  if (row.bypass) {
    throw new Error(
      `Refusing to serve: role "${row.cur}" has BYPASSRLS, so RLS would not constrain queries. ` +
        `This role must be NOBYPASSRLS.`,
    );
  }
}

let _appRoleChecked: Promise<void> | null = null;
export function assertAppPoolRole(): Promise<void> {
  _appRoleChecked ??= verifyPoolRole(appSql(), 'cb_app').catch((e) => {
    _appRoleChecked = null;
    throw e;
  });
  return _appRoleChecked;
}

let _authRoleChecked: Promise<void> | null = null;
export function assertAuthPoolRole(): Promise<void> {
  _authRoleChecked ??= verifyPoolRole(authSql(), 'cb_auth').catch((e) => {
    _authRoleChecked = null;
    throw e;
  });
  return _authRoleChecked;
}

/** THE cb_auth entry point. Every login/onboarding consumer must go through this rather than calling
 *  authSql() directly.
 *
 *  Why a helper and not "remember to call assertAuthPoolRole first": the M2 review found that
 *  assertAuthPoolRole had been written, documented in docs/auth-setup.md, and then called by nothing
 *  at all — eight cb_auth call sites each independently forgot it, and no test could notice because
 *  the guard's whole purpose is to catch a misconfiguration the test env never has. A guard a caller
 *  can skip is not a guard. Handing out the pool only through the assertion removes the choice.
 *
 *  Memoized, so this costs one round trip per process, not per call. */
export async function authLane(): Promise<postgres.Sql> {
  await assertAuthPoolRole();
  return authSql();
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
  const auth = _auth;
  _app = null;
  _admin = null;
  _auth = null;
  // Memoized identity checks belong to the pools we just dropped; a fresh pool must re-verify.
  _appRoleChecked = null;
  _authRoleChecked = null;
  if (app) await app.end({ timeout });
  if (admin) await admin.end({ timeout });
  if (auth) await auth.end({ timeout });
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
  // One memoized round trip per process: refuse to run tenant-scoped work on a pool that is not
  // cb_app (a mispasted DATABASE_URL would otherwise silently bypass RLS).
  await assertAppPoolRole();
  const grantsCsv = serializeGrants(ctx.grants);
  return appSql().begin(async (tx) => {
    // SIX settings, ONE round trip — the tx-pooler backend slot is the scarce resource (D6).
    // (Count the set_config calls below before changing this line; it is the audit line, not decoration.)
    //
    // The two timeouts are here, not only in the pool's `connection` block, because MEASUREMENT
    // showed the startup-packet form does not survive Supabase's transaction pooler: with
    // DB_STATEMENT_TIMEOUT=15000 configured, `select current_setting('statement_timeout')` inside a
    // scoped transaction returned Supabase's default `2min`, and idle_in_transaction_session_timeout
    // came back `0` (disabled). In transaction-pooling mode the client socket is not 1:1 with a
    // backend, so those parameters never reach the session the query actually runs on — meaning the
    // "a runaway statement can't pin a pooled connection and hang the fleet" protection this file
    // claims did not exist. set_config(…, true) is LOCAL to the transaction, so it does.
    // `hnsw.iterative_scan` rides along in the same statement because it is free to add here and
    // is NOT merely a performance knob. schema.sql:262 requires it, and without it pgvector's HNSW
    // scan returns at most ef_search GLOBALLY-nearest candidates and the RLS predicate is applied
    // afterwards, as a post-filter. With one tenant that is invisible — which is why A17 shipped
    // clean. M2 made the table genuinely multi-tenant, so a workspace holding a small share of
    // content_chunks gets a truncated or empty vector arm, and one large tenant silently degrades
    // every other tenant's retrieval. That is a cross-tenant isolation effect on the code path whose
    // entire job is answer quality, not a latency nit.
    await tx`select
      set_config('app.workspace', ${ctx.workspaceId}, true),
      set_config('app.principal', ${ctx.principal}, true),
      set_config('app.grants', ${grantsCsv}, true),
      set_config('statement_timeout', ${String(config.DB_STATEMENT_TIMEOUT)}, true),
      set_config('idle_in_transaction_session_timeout', ${String(config.DB_IDLE_IN_TX_TIMEOUT)}, true),
      set_config('hnsw.iterative_scan', 'relaxed_order', true)`;
    return fn(tx);
  }) as Promise<T>;
}
