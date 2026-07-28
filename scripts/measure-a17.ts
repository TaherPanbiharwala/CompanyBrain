// `bun run measure:a17` — the BASELINE for the A17 latency work (plan P3).
//
// Written before any optimization, deliberately. The plan's P3 item is "measured", and a performance
// commit whose before-number was reconstructed after the fact is not measured — it is remembered.
//
// What it counts and why: `ask` is dominated by SEQUENTIAL database round trips on an intercontinental
// link (Supabase ap-northeast-2), not by CPU. So the number that predicts the wall clock is the count
// of awaited round trips, and the number that proves an improvement is the wall clock at a fixed
// query. Both are reported. The model call is not timed on its own — it is FAKED by default, so the
// reported answerQuestion number is search plus a near-zero stub, which is exactly the figure the
// P3 work should move.
//
// Model calls are FAKED by default (--fake, the default) so a baseline costs nothing and is not at
// the mercy of provider latency. Pass --real to include a genuine chat() call.
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { installFakeAiFetch } from '../test/helpers/fake-ai.ts';
import { answerQuestion } from '../src/answer/answer.ts';
import { config } from '../src/config.ts';

const REPEATS = 5;
const QUESTION = 'What did the engineering team decide about the deployment pipeline?';

function stats(ms: number[]): { min: number; median: number; max: number } {
  const s = [...ms].sort((a, b) => a - b);
  return { min: s[0]!, median: s[Math.floor(s.length / 2)]!, max: s[s.length - 1]! };
}

/** One round trip to the pooler, to price the link itself. Everything else is a multiple of this. */
async function measureRtt(): Promise<number[]> {
  const sql = adminSql();
  const out: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const t = performance.now();
    await sql`select 1`;
    out.push(performance.now() - t);
  }
  return out;
}

async function main(): Promise<void> {
  const real = process.argv.includes('--real');
  const sql = adminSql();

  // rls-exempt: corpus sizing on the owner pool, deliberately. This picks the BIGGEST tenant to
  // benchmark against, which is a question the app role cannot answer by construction — a scoped
  // read only ever sees one workspace. It reads counts, never content, and never runs in the
  // request path.
  const rows = await sql<{ workspace_id: string; owner_principal: string; pages: number; chunks: number }[]>`
    select p.workspace_id,
           min(p.owner_principal)          as owner_principal,
           count(distinct p.id)::int       as pages,
           count(c.id)::int                as chunks
    from pages p left join content_chunks c on c.page_id = p.id
    group by p.workspace_id
    order by count(c.id) desc
    limit 1`;
  const target = rows[0];
  if (!target) throw new Error('no corpus found — run `bun run load:a17` first');

  const principal = target.owner_principal;
  const ctx = buildContext({
    principal,
    workspaceId: target.workspace_id,
    role: 'owner',
    grants: resolveGrants(principal, target.workspace_id),
    remote: false,
  });

  console.log(`corpus: ${target.pages} pages / ${target.chunks} chunks in workspace ${target.workspace_id}`);

  const rtt = stats(await measureRtt());
  console.log(`\nlink: one pooler round trip = ${rtt.median.toFixed(0)}ms median (${rtt.min.toFixed(0)}–${rtt.max.toFixed(0)}ms)`);

  // installFakeAiFetch RETURNS the fake; installing it is the caller's job (same shape the live
  // suites use). Restore on the way out so a --real follow-up in the same process is unaffected.
  const mutableConfig = config as unknown as Record<string, unknown>;
  const realFetch = globalThis.fetch;
  const priorKeys = {
    openai: mutableConfig.OPENAI_API_KEY,
    openrouter: mutableConfig.OPENROUTER_API_KEY,
    chatModel: mutableConfig.CHAT_MODEL,
  };
  if (!real) {
    mutableConfig.OPENAI_API_KEY = 'measure-key';
    mutableConfig.OPENROUTER_API_KEY = 'measure-key';
    // CHAT_MODEL defaults to '' (config.ts) and chat() THROWS on an empty model id, so stubbing only
    // the two keys leaves the faked run failing at step 3 of 3 on a machine that has not set it.
    if (!mutableConfig.CHAT_MODEL) mutableConfig.CHAT_MODEL = 'openrouter:deepseek/deepseek-v4-flash';
    globalThis.fetch = installFakeAiFetch() as typeof fetch;
  }

  try {
    // 1. An empty scoped transaction — the fixed cost every operation pays before doing any work.
    const txMs: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const t = performance.now();
      await withScopedTx(ctx, async () => undefined);
      txMs.push(performance.now() - t);
    }
    const tx = stats(txMs);
    console.log(`withScopedTx (open + 6 GUCs + commit, no query): ${tx.median.toFixed(0)}ms median`);

    // 2. hybridSearch alone — embed + the two arms.
    const searchMs: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const t = performance.now();
      await hybridSearch(ctx, QUESTION);
      searchMs.push(performance.now() - t);
    }
    const search = stats(searchMs);
    console.log(`hybridSearch (embed + keyword arm + vector arm): ${search.median.toFixed(0)}ms median (${search.min.toFixed(0)}–${search.max.toFixed(0)}ms)`);

    // 3. The whole ask path.
    const askMs: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const t = performance.now();
      await answerQuestion(ctx, QUESTION);
      askMs.push(performance.now() - t);
    }
    const ask = stats(askMs);
    console.log(`answerQuestion (search + ${real ? 'REAL' : 'faked'} model call): ${ask.median.toFixed(0)}ms median (${ask.min.toFixed(0)}–${ask.max.toFixed(0)}ms)`);

    console.log(`\nsearch as a share of ask: ${((search.median / ask.median) * 100).toFixed(0)}%`);
    console.log(`search in units of one round trip: ${(search.median / rtt.median).toFixed(1)}x`);
  } finally {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = priorKeys.openai;
    mutableConfig.OPENROUTER_API_KEY = priorKeys.openrouter;
    mutableConfig.CHAT_MODEL = priorKeys.chatModel;
    await closePools();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
