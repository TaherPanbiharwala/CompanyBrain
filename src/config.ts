// Env-driven config. Bun auto-loads .env. The /health path needs no secrets and boots without one.
import { z } from 'zod';
import { resolveEnvironmentRetrievalKnobs } from './search/retrieval-knobs.ts';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('development'),
  // Dev-only: when 1 (and NODE_ENV != production), POST /api/:op trusts x-cb-* identity headers with
  // NO verification (src/api/dev-auth.ts). Demoted at M2 to a no-session-presented fallback (D45).
  // NEVER set in production.
  DEV_AUTH: z.coerce.number().default(0),

  // Database = Supabase (managed Postgres + pgvector), DECISIONS D22.
  //   DATABASE_URL       = the dedicated NON-BYPASSRLS role `cb_app` (RLS applies), via the
  //                        TRANSACTION pooler. All request traffic uses this.
  //   DATABASE_ADMIN_URL = the `postgres` owner, via the SESSION pooler (port 5432 on the pooler
  //                        host). Used only by migrate.ts.
  DATABASE_URL: z.string().default(''),
  DATABASE_ADMIN_URL: z.string().default(''),
  // Supabase's pooler is transaction-mode -> 1 disables prepared statements so the per-request
  // SET LOCAL GUC pattern is pool-safe (DECISIONS D6).
  DB_TRANSACTION_POOLER: z.coerce.number().default(1),
  // 'require' encrypts but does NOT verify the server cert; use 'verify-full' (with the Supabase
  // CA) in production. 'disable' to turn off (local only).
  //
  // .trim().toLowerCase() because this value is compared VERBATIM in two places — sslOption() in
  // db/client.ts, and the production warning just below — and both used to compare the raw env
  // string. A pasted Railway variable carrying a trailing newline or space, or a hand-typed
  // "Verify-Full", fell through both comparisons' switch/equality to the WEAK default: TLS still
  // on, certificate silently unverified, with the dashboard showing exactly the value you meant to
  // set. Normalizing once here means both call sites see the same string and cannot disagree.
  DB_SSL: z.string().default('require').transform((v) => v.trim().toLowerCase()),
  // App pool sizing (postgres.js). Kept modest under the Supabase pooler's client-connection limit.
  DB_POOL_MAX: z.coerce.number().default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().default(20),
  DB_CONNECT_TIMEOUT: z.coerce.number().default(30),
  // Per-connection GUCs on the APP pool (ms). Bound a runaway query and an abandoned open tx so a
  // stuck statement (or a tx that ever spans an LLM call) becomes a bounded error, not a fleet-wide
  // hang — neither idle_timeout nor connect_timeout bounds a *running* query. Applies to cb_app only.
  DB_STATEMENT_TIMEOUT: z.coerce.number().default(15000),
  DB_IDLE_IN_TX_TIMEOUT: z.coerce.number().default(15000),
  // Password migrate.ts assigns to the cb_app role (must match the one embedded in DATABASE_URL).
  CB_APP_DB_PASSWORD: z.string().default(''),
  //   DATABASE_AUTH_URL = the least-privilege `cb_auth` role (M2), via the TRANSACTION pooler. Used
  //     ONLY for login/onboarding writes — never on the /api/:op hot path (G3). Optional in the
  //     schema so the offline unit suite boots; authSql() is fatal on FIRST USE when unset.
  DATABASE_AUTH_URL: z.string().default(''),
  CB_AUTH_DB_PASSWORD: z.string().default(''),

  // --- auth (M2) ---
  // APP_BASE_URL is the SINGLE source of truth for: the OIDC redirect URI, the __Host- cookie-name
  // decision, the CSRF origin check, and the dev-login loopback gate. Printed at boot.
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  // G5: absolute session lifetime. Refresh rotation is CUT from M2 (G2), so there is no reuse
  // detection — a stolen cookie is valid for this whole window. 7 days, deliberately not 14.
  SESSION_TTL_DAYS: z.coerce.number().default(7),
  INVITE_TTL_DAYS: z.coerce.number().default(7),
  // Dedicated flag for POST /auth/dev-login: a route that MINTS A REAL SESSION with no Google
  // verification needs its own switch, not a shared one (gate 2 of five).
  DEV_LOGIN: z.coerce.number().default(0),
  // Unset => never call app.set('trust proxy'). 'loopback', or a numeric hop count.
  TRUST_PROXY: z.string().default(''),
  // CI sets 1 so the live-DB security tests FAIL instead of silently skipping.
  CB_REQUIRE_LIVE_TESTS: z.coerce.number().default(0),
  // Opt-in for test/perf-recall.test.ts: filtered-HNSW recall at corpus scale, GUC bleed on a max=1
  // pool, and pool headroom under concurrent generations. SEPARATE from CB_REQUIRE_LIVE_TESTS on
  // purpose (D93): those three seed a few hundred chunks, mutate DB_POOL_MAX, and are the only
  // timing-dependent tests in the repo. test/leak-canary.test.ts:7 states the reason the split
  // exists — welding the flakiest tests to the flag CI sets, and that the sacred canary depends on,
  // is how the sacred flag gets turned off. 0/unset = skip, and that skip is honest because nobody
  // asked for the suite. Once it IS asked for, perfOrFail applies liveOrFail's no-silent-skip rule
  // in full.
  CB_RUN_PERF_TESTS: z.coerce.number().default(0),

  OPENROUTER_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  // The chat model is CHOSEN (DECISIONS D12.1: openrouter:deepseek/deepseek-v4-flash) but has no
  // code default — Anthropic and OpenAI chat models are ruled out on cost, so silently defaulting to
  // anything would spend money on a provider the operator did not pick. router.ts throws and names
  // the chosen slug. (This comment said "OPEN decision" for two milestones after D12.1 resolved it,
  // and the thrown error told the operator to go ask themselves a question they had answered.)
  CHAT_MODEL: z.string().default(''),
  // RESERVED for M7 (compiled-truth synthesis), per D12.1: openrouter:deepseek/deepseek-v4-pro.
  // Declared and read by NOTHING today — deliberately, and marked so, because a config key that is
  // declared-and-unread is otherwise indistinguishable from a forgotten one (D43 records exactly
  // that failure for CB_REQUIRE_LIVE_TESTS).
  FRONTIER_MODEL: z.string().default(''),
  // Embeddings are a separate, already-locked decision (D13) — OpenAI's embedding model is fine;
  // only the *chat* model is restricted per the founder's cost preference above.
  EMBEDDING_MODEL: z.string().default('openai:text-embedding-3-small'),
  EMBEDDING_DIM: z.coerce.number().default(1536),
  // Cross-encoder reranking. OFF by default (empty = off), and the default is the decision, not
  // laziness: a reranker adds a paid provider call to the hot ask path, and there is no eval in this
  // repo that could show it earning that. The seam is real and wired — set e.g.
  // `cohere:rerank-v3.5` to turn it on — so enabling it later is configuration, not code.
  // D15 kept this seam in v0 precisely so the shape would exist before the evidence did.
  RERANK_MODEL: z.string().default(''),
  // Multi-query expansion: paraphrase the question with the chat model and widen the KEYWORD arm
  // with the extra terms. 0 = off. Also a paid call on the ask path, also unmeasurable here.
  QUERY_EXPANSION: z.coerce.number().default(0),

  // M7: trusted server-wide retrieval-policy overrides. Parsed and fully validated here so malformed
  // JSON, unknown fields, or unsafe bounds fail during startup rather than changing ranking silently.
  // Per-workspace settings remain a reserved (empty) resolver layer and are not exposed publicly.
  CB_RETRIEVAL_KNOBS_JSON: z.string().default(''),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  // DERIVED from APP_BASE_URL below. Kept as an explicit override only — two independently-set
  // origin values drift into Google's `redirect_uri_mismatch`, which is the #1 OAuth setup failure.
  OIDC_REDIRECT_URI: z.string().default(''),
  SESSION_SECRET: z.string().default(''),
});

/** The environments where dev-only behaviour (identity stubs, dev-login, destructive resets) may be
 *  permitted at all.
 *
 *  Fail CLOSED on this axis: an allowlist, never `!== 'production'`. A negative match fails OPEN for
 *  an unset, blank, or misspelled NODE_ENV ('prod', 'Production', 'staging').
 *
 *  ONE definition. It had drifted into three copies — api/dev-auth.ts, boot.ts and db/migrate.ts —
 *  each independently deciding where destructive or identity-bypassing behaviour is allowed. That is
 *  the last set of strings that should exist more than once. */
export const DEV_ENVS: ReadonlySet<string> = new Set(['development', 'test']);

/**
 * Is this a GENUINE development environment — i.e. did somebody actually say so?
 *
 * The one place that question is answered, because it was previously answered in three places and
 * two of them were wrong. `NODE_ENV` is `z.string().default('development')`, so an ABSENT variable
 * arrives as the string 'development' and sails through a bare `DEV_ENVS.has(cfg.NODE_ENV)` check.
 * `assertDevAuthSafe` and `boot.ts`'s missing-secrets gate both did exactly that while their
 * docstrings (and DECISIONS D33) claimed to cover "unset" — so a container with DEV_AUTH=1 and no
 * NODE_ENV booted with the header-trusting stub live and every auth secret empty.
 *
 * `devLoginEnabled` had it right, but via a SECOND mechanism (an `env` parameter read straight from
 * process.env), which is precisely why the other two could drift away from it. Same shape as
 * `appBaseUrlExplicit` below: when a default would satisfy the check, the check has to know whether
 * it is looking at a default.
 */
export function isDevEnv(cfg: Pick<Config, 'NODE_ENV' | 'nodeEnvExplicit'>): boolean {
  return cfg.nodeEnvExplicit && DEV_ENVS.has(cfg.NODE_ENV);
}

/** Every form a loopback host can arrive in.
 *
 *  `[::1]` is not redundant: `new URL(...).hostname` strips the brackets from an IPv6 literal but
 *  Express's `req.hostname` KEEPS them, and both feed this set. The M2 review found these two
 *  callers had each hand-rolled the list and already disagreed — the per-request dev-login belt
 *  omitted `[::1]`, so a request to `http://[::1]:3000` passed the boot gate and was then 404'd by
 *  the belt. One list, one predicate. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** THE loopback test. Takes a bare hostname (not a URL) so request-side and config-side callers
 *  share it. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** Host of APP_BASE_URL is a loopback address (dev-login gate 5). Malformed URL ⇒ false (fail closed). */
function loopbackHost(baseUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** APP_BASE_URL is https. Picks BOTH the `Secure` cookie attribute and the `__Host-` name prefix —
 *  one predicate, so the two can never disagree (a `__Host-` cookie without Secure is silently
 *  discarded by the browser: an infinite login loop with no error anywhere). */
function httpsBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Pure: parse an env bag into the resolved config. No process/global reads, NO boot assertions —
 *  this runs at import in every unit test, so anything that can throw belongs in assert*Safe(). */
export function parseConfig(env: Record<string, string | undefined>) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  const d = parsed.data;
  const appBaseUrl = d.APP_BASE_URL;
  return {
    ...d,
    // Any non-zero value enables pool-safe mode (prepare:false). Guard against a stray value like 2
    // silently falling back to prepare:true, which is unsafe behind the transaction pooler.
    isPooler: d.DB_TRANSACTION_POOLER !== 0,
    OIDC_REDIRECT_URI: d.OIDC_REDIRECT_URI || `${appBaseUrl.replace(/\/+$/, '')}/auth/google/callback`,
    // Whether APP_BASE_URL was EXPLICITLY provided. Gate 5 of dev-login would otherwise pass by
    // default (the fallback is loopback), so an unconfigured staging box would look local.
    appBaseUrlExplicit: env.APP_BASE_URL !== undefined && env.APP_BASE_URL !== '',
    // Whether NODE_ENV was EXPLICITLY provided. Same trap as APP_BASE_URL and strictly more
    // dangerous: NODE_ENV defaults to 'development', which is the value every dev-only gate treats
    // as permission. See isDevEnv() above — never test DEV_ENVS.has(NODE_ENV) without this.
    nodeEnvExplicit: env.NODE_ENV !== undefined && env.NODE_ENV !== '',
    appBaseIsLoopback: loopbackHost(appBaseUrl),
    appBaseIsHttps: httpsBase(appBaseUrl),
    retrievalKnobs: resolveEnvironmentRetrievalKnobs(d.CB_RETRIEVAL_KNOBS_JSON),
  } as const;
}

export const config = parseConfig(process.env);

// Weak-TLS-in-production warning (side effect kept out of the pure parser).
if (config.NODE_ENV === 'production' && config.DB_SSL !== 'verify-full') {
  console.warn(
    '[config] NODE_ENV=production but DB_SSL is not "verify-full": DB traffic is encrypted but the server certificate is NOT verified (MITM risk). Set DB_SSL=verify-full with the Supabase CA.',
  );
}

export type Config = typeof config;
