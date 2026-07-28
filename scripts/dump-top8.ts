// The cheap regression detector. Not an eval — a diffable snapshot.
//
// There is no answer-quality harness (eval/a17-report.md is 10 questions with every metric pinned at
// 1.00 and every hand-grade blank), so nothing in this repo can currently tell you that a retrieval
// change made results WORSE. This closes the smallest useful part of that gap: it writes the ranked
// top-K for the existing A17 questions to a committed file, so a change to chunking, fusion, dedup or
// autocut shows up as a `git diff` you have to look at rather than a silence you never notice.
//
// It deliberately does NOT score anything. Scoring needs relevance judgements this corpus cannot
// support. A diff needs none — you read it and decide whether the movement was intended.
//
// CAPTURE THE BASELINE BEFORE TOUCHING THE CHUNKER. If the corpus is re-chunked first, the "before"
// side already contains the change and the diff shows nothing.
//
//   bun run dump:top8            # write eval/top8-baseline.txt
//   bun run dump:top8 --check    # re-run and diff against it; non-zero exit on drift
//
// Uses the REAL embedding provider, because the fake embedder's vectors are uncorrelated across
// different strings — a ranking produced under it is a stable pseudorandom permutation, so a diff
// under fakes would show movement that means nothing.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { assertMembership } from '../src/auth/membership.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { closePools } from '../src/db/client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const QRELS = join(here, '..', 'eval', 'a17-qrels.json');
const OUT = join(here, '..', 'eval', 'top8-baseline.txt');

interface Qrel {
  id: string;
  question: string;
}

async function render(): Promise<string> {
  const principal = process.env.CB_CLI_PRINCIPAL;
  const workspaceId = process.env.CB_CLI_WORKSPACE;
  if (!principal || !workspaceId) {
    console.error('set CB_CLI_PRINCIPAL and CB_CLI_WORKSPACE first (run: bun run seed:a17)');
    process.exit(2);
  }
  // D25 on this surface too: the env names the pair, the database supplies the authoritative role.
  const role = await assertMembership(principal, workspaceId);
  const ctx = buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: false });

  const qrels: Qrel[] = JSON.parse(await readFile(QRELS, 'utf8'));
  const lines: string[] = [
    '# Retrieval snapshot — top-K per question, in rank order.',
    '#',
    '# This is a DIFF TARGET, not a score. Regenerate with `bun run dump:top8` and read the diff:',
    '# movement here means chunking, fusion, dedup or autocut changed what the answer step sees.',
    '# Chunk ids are omitted deliberately — they are uuids that churn on every re-ingest and would',
    '# make every diff unreadable. Slug + ordinal is stable across a re-ingest of the same corpus.',
    '',
  ];

  for (const q of qrels) {
    const { hits } = await hybridSearch(ctx, q.question);
    lines.push(`## ${q.id}  ${q.question}`);
    if (hits.length === 0) {
      lines.push('   (no hits)');
    } else {
      hits.forEach((h, i) => lines.push(`   ${String(i + 1).padStart(2)}. ${h.slug}#${h.ord}`));
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const rendered = await render();

  if (!check) {
    await writeFile(OUT, rendered, 'utf8');
    console.log(`wrote ${OUT}`);
    console.log('Commit this. Re-run with --check after a retrieval change and read the diff.');
    await closePools({ timeout: 5 });
    return;
  }

  let previous: string;
  try {
    previous = await readFile(OUT, 'utf8');
  } catch {
    console.error(`no baseline at ${OUT} — run \`bun run dump:top8\` first`);
    await closePools({ timeout: 5 });
    process.exit(2);
  }

  if (previous.trim() === rendered.trim()) {
    console.log('top-8 unchanged.');
    await closePools({ timeout: 5 });
    return;
  }

  // Show the first differing question rather than a wall of text.
  const a = previous.split('\n');
  const b = rendered.split('\n');
  let i = 0;
  while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
  console.error('RETRIEVAL DRIFT — the ranking changed.\n');
  console.error(`  first difference at line ${i + 1}:`);
  console.error(`    baseline: ${a[i] ?? '(end of file)'}`);
  console.error(`    now:      ${b[i] ?? '(end of file)'}`);
  console.error('\nIf this movement was intended, re-run `bun run dump:top8` and commit the new baseline');
  console.error('as part of the same change, so the diff is reviewed rather than discovered later.');
  await closePools({ timeout: 5 });
  process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
