// Env-driven config. Bun auto-loads .env. The /health path needs no secrets and boots without one.
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('development'),

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
  DB_SSL: z.string().default('require'),
  // App pool sizing (postgres.js). Kept modest under the Supabase pooler's client-connection limit.
  DB_POOL_MAX: z.coerce.number().default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().default(20),
  DB_CONNECT_TIMEOUT: z.coerce.number().default(30),
  // Password migrate.ts assigns to the cb_app role (must match the one embedded in DATABASE_URL).
  CB_APP_DB_PASSWORD: z.string().default(''),

  OPENROUTER_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  // Chat model is an OPEN decision (DECISIONS D12.1) — founder ruled out Anthropic (too
  // expensive) and OpenAI's chat models. Left unset until that conversation happens at M3;
  // router.ts throws a clear error rather than silently defaulting to either.
  CHAT_MODEL: z.string().default(''),
  FRONTIER_MODEL: z.string().default(''),
  // Embeddings are a separate, already-locked decision (D13) — OpenAI's embedding model is fine;
  // only the *chat* model is restricted per the founder's cost preference above.
  EMBEDDING_MODEL: z.string().default('openai:text-embedding-3-small'),
  EMBEDDING_DIM: z.coerce.number().default(1536),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  // Defaults to http://localhost:<PORT>/auth/google/callback when unset (derived below).
  OIDC_REDIRECT_URI: z.string().default(''),
  SESSION_SECRET: z.string().default(''),
});

/** Pure: parse an env bag into the resolved config. No process/global reads — testable. */
export function parseConfig(env: Record<string, string | undefined>) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  const d = parsed.data;
  return {
    ...d,
    isPooler: d.DB_TRANSACTION_POOLER === 1,
    OIDC_REDIRECT_URI: d.OIDC_REDIRECT_URI || `http://localhost:${d.PORT}/auth/google/callback`,
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
