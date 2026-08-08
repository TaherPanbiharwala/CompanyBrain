// Ingest an eval corpus into its two workspaces (plain + meta).
//
// Modelled on scripts/load-a17-corpus.ts, with four corrections that clone would otherwise inherit:
//
//   1. RE-RUNS ARE NOT FAILURES. load-a17-corpus.ts counts an `already_exists` refusal as a failure
//      and exits 1, so re-running it on a loaded corpus reports 609 failures. Here a document that is
//      already present is SKIPPED, reported as such, and the run exits 0.
//   2. SKIP BEFORE SPENDING. `importPage` embeds BEFORE the insert (src/ingest/import.ts:43-46), so
//      "try it and catch the duplicate" re-pays for the embeddings of every loaded document. The
//      existing slugs are read once, up front, and the work list is the difference.
//   3. VALIDATE SLUGS FIRST. Three of the 609 MultiHop URLs exceed the 200-character ingest cap.
//      Discovering that at document ~400 means the embeddings for the first 400 are already bought.
//   4. NO STALE-SHELL TARGET. The workspace ids come from the seed's state file, not from
//      CB_CLI_WORKSPACE — which `load:a17` also uses, and which `assertMembership` happily accepts.
import { closePools, withScopedTx } from '../src/db/client.ts';
import { dispatchOp } from '../src/api/dispatch.ts';
import { deletePage } from '../src/ingest/lifecycle.ts';
import { resolveAdapter } from '../src/eval/adapters/index.ts';
import { slugify, findSlugCollisions, SLUG_MAX_LEN, SLUG_RE } from '../src/eval/slug.ts';
import type { EvalDocument } from '../src/eval/types.ts';
import {
  parseArgs, say, ctxFor, loadWorkspaces, bodyFor, VARIANTS, knownDatasets,
  type Variant, type CommonArgs,
} from './eval-common.ts';
import type { OperationContext } from '../src/core/context.ts';

const CONCURRENCY = 4; // DB_POOL_MAX is 10 and each ingest holds one pooled connection for its tx.

const HELP = `
bun run load:eval [--dataset <name>] [--dir <path>] [--purge --yes] [--variant plain|meta]

Ingests an eval corpus into the two workspaces created by seed:eval.

  --dataset <name>   Which benchmark to load. Default: multihop. Known: ${knownDatasets()}
  --dir <path>       Override the dataset location (also reads MULTIHOP_DIR).
  --variant <v>      Load only one of "plain" | "meta". Default: both.
  --purge --yes      Delete this dataset's pages from the target workspaces. The only clean undo.
  --help             This text.

Re-running is safe and cheap: documents already present are skipped without re-embedding.
`;

interface LoadOutcome {
  variant: Variant;
  ingested: number;
  skipped: number;
  failed: { slug: string; reason: string }[];
}

/** One query, not one per document. 609 existence round trips over an intercontinental link roughly
 *  doubles the wall clock of a load that is otherwise dominated by embedding calls. */
async function existingSlugs(ctx: OperationContext): Promise<Set<string>> {
  const rows = await withScopedTx(ctx, async (tx) => {
    return tx<{ slug: string }[]>`select slug from pages`;
  });
  return new Set(rows.map((r) => r.slug));
}

async function pMap<T>(items: readonly T[], concurrency: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function purge(ctx: OperationContext, docs: readonly EvalDocument[], variant: Variant): Promise<number> {
  const present = await existingSlugs(ctx);
  const targets = docs.map((d) => slugify(d.id)).filter((s) => present.has(s));
  let deleted = 0;
  await pMap(targets, CONCURRENCY, async (slug) => {
    try {
      await deletePage(ctx, { slug });
      deleted++;
    } catch (err) {
      say(`  ! ${slug}: ${(err as Error).message}`);
    }
  });
  say(`  ${variant}: deleted ${deleted} of ${targets.length} pages`);
  return deleted;
}

async function loadVariant(
  ctx: OperationContext,
  docs: readonly EvalDocument[],
  variant: Variant,
): Promise<LoadOutcome> {
  const present = await existingSlugs(ctx);
  const work = docs.filter((d) => !present.has(slugify(d.id)));
  const skipped = docs.length - work.length;

  if (work.length === 0) {
    say(`  ${variant}: all ${docs.length} documents already present — nothing to do`);
    return { variant, ingested: 0, skipped, failed: [] };
  }
  say(`  ${variant}: ${work.length} to ingest, ${skipped} already present`);

  const outcome: LoadOutcome = { variant, ingested: 0, skipped, failed: [] };
  const started = Date.now();
  let done = 0;

  await pMap(work, CONCURRENCY, async (doc) => {
    const slug = slugify(doc.id);
    const result = await dispatchOp(
      ctx,
      'ingest',
      { slug, title: doc.title, body: bodyFor(doc, variant), tags: [] },
      {
        unmetered:
          'corpus seeding: a deliberate burst on a dedicated local principal, and a throttled load ' +
          'would fail partway with no resume path. The 120/min ceiling is not a property of this job.',
      },
    );
    if (result.ok) outcome.ingested++;
    else outcome.failed.push({ slug, reason: `${result.error.code} ${result.error.message}` });

    done++;
    // Progress every 50, with a rate and an ETA. Without it a multi-minute load is indistinguishable
    // from a hung one, which is the moment people Ctrl-C a job that was going to finish.
    if (done % 50 === 0 || done === work.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const eta = Math.round((work.length - done) / Math.max(rate, 0.001));
      say(`    ${done}/${work.length}  ${rate.toFixed(1)}/s  eta ${eta}s`);
    }
  });

  return outcome;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    say(HELP);
    return;
  }

  const args: CommonArgs = parseArgs(argv);
  const adapter = resolveAdapter(args.dataset);
  const { docs } = await adapter.load(args.dir);
  say(`${args.dataset}: ${docs.length} documents from ${args.dir}`);

  // ── Fail before spending anything ──────────────────────────────────────────
  const invalid = docs
    .map((d) => ({ id: d.id, slug: slugify(d.id) }))
    .filter((x) => x.slug.length > SLUG_MAX_LEN || !SLUG_RE.test(x.slug));
  if (invalid.length > 0) {
    const sample = invalid.slice(0, 3).map((x) => `  ${x.slug.length} chars: ${x.slug.slice(0, 60)}…`);
    throw new Error(
      `${invalid.length} of ${docs.length} documents produce an invalid slug (cap ${SLUG_MAX_LEN}, ` +
        `charset ${SLUG_RE}).\n${sample.join('\n')}\n` +
        `Nothing has been ingested and nothing spent. Fix slugify() in src/eval/slug.ts.`,
    );
  }

  const collisions = findSlugCollisions(docs.map((d) => d.id));
  if (collisions.size > 0) {
    const [slug, ids] = [...collisions.entries()][0]!;
    throw new Error(
      `${collisions.size} slug collision(s): distinct documents that map to the same page.\n` +
        `  "${slug}" <- ${ids.join(' , ')}\n` +
        `Every question touching them would score zero with no error anywhere. ` +
        `Nothing has been ingested and nothing spent.`,
    );
  }

  const state = loadWorkspaces(args.dataset);
  const only = args.values.get('variant') as Variant | undefined;
  if (only && !VARIANTS.includes(only)) {
    throw new Error(`--variant must be one of: ${VARIANTS.join(', ')}. Got "${only}"`);
  }
  const variants = only ? [only] : VARIANTS;

  // ── Purge path ─────────────────────────────────────────────────────────────
  if (args.flags.has('purge')) {
    if (!args.flags.has('yes')) {
      const names = variants.map((v) => `"${state.workspaces[v].name}"`).join(' and ');
      throw new Error(
        `--purge would delete up to ${docs.length} pages from ${names}.\n` +
          `This is the only clean undo for a mis-targeted load. Re-run with --purge --yes to proceed.`,
      );
    }
    for (const variant of variants) {
      const ctx = await ctxFor(state.principalId, state.workspaces[variant].workspaceId);
      await purge(ctx, docs, variant);
    }
    await closePools({ timeout: 5 });
    return;
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  say(`\nLoading into ${variants.length} workspace(s), concurrency ${CONCURRENCY}.`);
  say(`Expect a few minutes and roughly $0.035 in embeddings per workspace.\n`);

  const outcomes: LoadOutcome[] = [];
  for (const variant of variants) {
    const ws = state.workspaces[variant];
    say(`${variant} -> ${ws.workspaceId} ("${ws.name}")`);
    const ctx = await ctxFor(state.principalId, ws.workspaceId);
    outcomes.push(await loadVariant(ctx, docs, variant));
  }

  say('');
  let anyFailed = false;
  for (const o of outcomes) {
    say(`${o.variant}: ${o.ingested} ingested, ${o.skipped} already present (skipped), ${o.failed.length} failed`);
    for (const f of o.failed.slice(0, 10)) say(`  ! ${f.slug}: ${f.reason}`);
    if (o.failed.length > 10) say(`  … and ${o.failed.length - 10} more`);
    if (o.failed.length > 0) anyFailed = true;
  }

  if (anyFailed) {
    say(
      `\nRe-run \`bun run load:eval --dataset ${args.dataset}\` to retry only what is missing — ` +
        `it skips everything already loaded and does not re-pay for their embeddings.`,
    );
  } else {
    say(`\nNext:  bun run eval:rag --dataset ${args.dataset} --dry-run`);
  }

  await closePools({ timeout: 5 });
  // Exit non-zero ONLY for real failures. "Already present" is a successful no-op, not an error.
  if (anyFailed) process.exit(1);
}

main().catch(async (err) => {
  say(`\nload failed: ${(err as Error).message}`);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
