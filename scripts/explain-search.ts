// `bun run explain:search` — where the retrieval wall clock actually goes.
//
// measure:a17 says hybridSearch takes N milliseconds. It cannot say WHICH of the four arms spent
// them, and a fix aimed at the wrong arm is indistinguishable from no fix. This script answers the
// second question: it runs `EXPLAIN (ANALYZE, BUFFERS)` on the REAL retrieval statement, and then
// re-measures each arm in isolation so the total is attributed rather than apportioned by guess.
//
// The full-query plan comes from `hybridQuery()` in src/search/hybrid.ts — the same fragment the
// request path executes, interpolated into `explain`. It is deliberately NOT a copy of that SQL: a
// copy is accurate on the day it is pasted and silently wrong afterwards, which is exactly how
// idx_pages_title_prefix (migration 0011) shipped serving nothing.
//
// The per-arm probes below ARE hand-written, and that is the honest trade: each is a strict subset
// of one CTE, kept as small as possible so the number it reports belongs to one operation. They are
// labelled with the CTE they stand in for.
//
//   bun run explain:search --workspace "multihop eval (plain)"
//   bun run explain:search --workspace A17 --query "what did the team decide?"
//
// Read-only: EXPLAIN ANALYZE executes the statement, but every statement here is a SELECT.
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { hybridQuery, keywordQueryText } from '../src/search/hybrid.ts';
import { embed, withRouterScope } from '../src/ai/router.ts';
import { toVectorLiteral } from '../src/ai/vector.ts';
import { describeTarget, resolveWorkspaceTarget, workspaceFlag } from './workspace-target.ts';
import type postgres from 'postgres';

const DEFAULT_QUESTION = 'What did the engineering team decide about the deployment pipeline?';

/** Repeats per probe. The FIRST run of any statement pays cold shared_buffers, and on a 53MB TOAST
 *  relation that is most of the number — so the median of a few is the figure a warm request sees. */
const REPEATS = 3;

/** `--query "<question>"`. The workspace flag is shared (workspace-target.ts); this one is local
 *  because only this script takes a question. */
function queryFlag(): string | undefined {
  const i = process.argv.indexOf('--query');
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

interface PlanResult {
  text: string;
  execMs: number;
  planMs: number;
}

/** EXPLAIN (ANALYZE, BUFFERS) one fragment and pull the two timings out of the text plan. */
async function explain(tx: postgres.TransactionSql, frag: postgres.Fragment): Promise<PlanResult> {
  const rows = await tx<{ 'QUERY PLAN': string }[]>`explain (analyze, buffers, timing, costs) ${frag}`;
  const text = rows.map((r) => r['QUERY PLAN']).join('\n');
  const exec = /Execution Time: ([\d.]+) ms/.exec(text);
  const plan = /Planning Time: ([\d.]+) ms/.exec(text);
  return { text, execMs: Number(exec?.[1] ?? NaN), planMs: Number(plan?.[1] ?? NaN) };
}

async function main(): Promise<void> {
  const question = queryFlag() ?? DEFAULT_QUESTION;
  const sql = adminSql();

  const target = await resolveWorkspaceTarget(sql, workspaceFlag());

  const principal = target.ownerPrincipal;
  const ctx = buildContext({
    principal,
    workspaceId: target.id,
    role: 'owner',
    grants: resolveGrants(principal, target.id),
    remote: false,
  });

  console.log(describeTarget(target));
  console.log(`question: ${question}`);

  const orQuery = keywordQueryText(question);
  console.log(`or-query: ${orQuery.split(' OR ').length} terms — ${orQuery}`);

  // A REAL embedding, not a stub. The vector arm is one of the four things being attributed, and an
  // HNSW traversal toward an arbitrary point is not the traversal the request path performs.
  const [queryVector] = await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () => embed([question]));
  const vectorLiteral = toVectorLiteral(queryVector!);

  // since/until/author (migration 0014) left null: this script attributes the SHIPPED query's cost,
  // and an unfiltered ask is the common case the arms' predicates must stay cheap for.
  const params = { query: question, orQuery, vectorLiteral, hasVector: true, fetchK: 8, since: null, until: null, author: null };

  await withScopedTx(ctx, async (tx) => {
    // ── 1. The whole statement, as shipped ────────────────────────────────
    const runs: PlanResult[] = [];
    for (let i = 0; i < REPEATS; i++) {
      runs.push(await explain(tx, hybridQuery(tx, params)));
    }
    const warm = runs[runs.length - 1]!;
    console.log(`\n${'═'.repeat(78)}\nFULL hybridQuery — EXPLAIN (ANALYZE, BUFFERS)\n${'═'.repeat(78)}`);
    console.log(warm.text);
    console.log(
      `\ncold exec ${runs[0]!.execMs.toFixed(0)}ms → warm exec ${median(runs.map((r) => r.execMs)).toFixed(0)}ms median ` +
        `(planning ${warm.planMs.toFixed(1)}ms)`,
    );

    // ── 2. Each arm on its own ────────────────────────────────────────────
    //
    // Ordered so that consecutive probes differ by ONE thing, which is what turns a list of timings
    // into an attribution. The keyword probes come in PAIRS — the same operation written against the
    // computed expression (the pre-0013 shape) and against the stored column (the shipped shape) —
    // because "the keyword arm is slow" and "computing to_tsvector at query time is slow" are
    // different claims, and only the pair distinguishes them.
    const probes: { label: string; note: string; frag: postgres.Fragment }[] = [
      {
        label: 'kw @@  computed  (pre-0013)',
        note: 'to_tsvector(content) per row',
        frag: tx`select count(*) from content_chunks c
                 where to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${orQuery})`,
      },
      {
        label: 'kw @@  stored    (shipped)',
        note: 'content_tsv per row',
        frag: tx`select count(*) from content_chunks c
                 where c.content_tsv @@ websearch_to_tsquery('english', ${orQuery})`,
      },
      {
        label: 'kw_pool computed (pre-0013)',
        note: 'membership + rank + and_tier',
        frag: tx`select count(*), count(*) filter (where a), sum(r) from (
                   select (to_tsvector('english', c.content) @@ plainto_tsquery('english', ${question})) as a,
                          ts_rank_cd(to_tsvector('english', c.content),
                                     websearch_to_tsquery('english', ${orQuery})) as r
                   from content_chunks c
                   where to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${orQuery})) x`,
      },
      {
        label: 'kw_pool stored   (shipped)',
        note: 'membership + rank + and_tier',
        frag: tx`select count(*), count(*) filter (where a), sum(r) from (
                   select (c.content_tsv @@ plainto_tsquery('english', ${question})) as a,
                          ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', ${orQuery})) as r
                   from content_chunks c
                   where c.content_tsv @@ websearch_to_tsquery('english', ${orQuery})) x`,
      },
      {
        label: 'vec: HNSW arm',
        note: '20 nearest under RLS',
        frag: tx`select count(*) from (
                   select c.id from content_chunks c
                   where c.embedding is not null
                   order by c.embedding <=> ${vectorLiteral}::vector
                   limit 20) v`,
      },
      {
        label: 'title: pages arm',
        note: 'title tsvector match',
        frag: tx`select count(*) from (
                   select c.id
                   from pages p join content_chunks c on c.page_id = p.id and c.ord = 0
                   where to_tsvector('english', coalesce(p.title, '')) @@ websearch_to_tsquery('english', ${orQuery})
                   order by ts_rank_cd(to_tsvector('english', coalesce(p.title, '')),
                                       websearch_to_tsquery('english', ${orQuery})) desc, c.id
                   limit 10) t`,
      },
    ];

    console.log(`\n${'═'.repeat(78)}\nPER-ARM (each probe is a strict subset of one CTE)\n${'═'.repeat(78)}`);
    for (const p of probes) {
      const ms: number[] = [];
      let last: PlanResult | null = null;
      for (let i = 0; i < REPEATS; i++) {
        last = await explain(tx, p.frag);
        ms.push(last.execMs);
      }
      // The row counts and the dominant node, which is the part of the plan worth one line.
      const rowsLine = /actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/.exec(last!.text);
      console.log(
        `${p.label.padEnd(30)} ${median(ms).toFixed(0).padStart(6)}ms   rows=${(rowsLine?.[1] ?? '?').padStart(5)}   ${p.note}`,
      );
    }

    // ── 3. Corpus-wide selectivity of the OR query ────────────────────────
    //
    // The number the hypothesis turns on: what FRACTION of the workspace does a typical question's
    // OR query match? If it is most of it, the arm is not a keyword filter, it is a scan with a sort.
    const [sel] = await tx<{ matched: number; total: number }[]>`
      select count(*) filter (where to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${orQuery}))::int as matched,
             count(*)::int as total
      from content_chunks c`;
    console.log(
      `\nOR-query selectivity: ${sel!.matched}/${sel!.total} visible chunks = ${((sel!.matched / sel!.total) * 100).toFixed(0)}%`,
    );
  });

  await closePools();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
