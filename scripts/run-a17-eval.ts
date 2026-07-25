// A17's actual "done when": scores retrieval automatically (hit@1/hit@3/MRR) against
// eval/a17-qrels.json, then generates a real answer for each question and writes a transcript to
// eval/a17-report.md for the founder to hand-grade (the part no automated metric can substitute for).
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { assertMembership } from '../src/auth/membership.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { answerQuestion } from '../src/answer/answer.ts';
import { scoreRetrieval, type QrelQuestion } from '../src/search/eval-score.ts';
import { closePools } from '../src/db/client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const QRELS_PATH = join(here, '..', 'eval', 'a17-qrels.json');
const REPORT_PATH = join(here, '..', 'eval', 'a17-report.md');

async function main(): Promise<void> {
  const principal = process.env.CB_CLI_PRINCIPAL;
  const workspaceId = process.env.CB_CLI_WORKSPACE;
  if (!principal || !workspaceId) {
    console.error('set CB_CLI_PRINCIPAL and CB_CLI_WORKSPACE first (run: bun run seed:a17)');
    process.exit(2);
  }
  // D25: the env names the pair; the database supplies the authoritative role.
  const role = await assertMembership(principal, workspaceId);
  const ctx = buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: false });

  const qrels: QrelQuestion[] = JSON.parse(await readFile(QRELS_PATH, 'utf8'));

  console.log(`Scoring retrieval over ${qrels.length} questions...`);
  const summary = await scoreRetrieval(qrels, async (question) => {
    const hits = await hybridSearch(ctx, question);
    const slugs: string[] = [];
    for (const h of hits) if (!slugs.includes(h.slug)) slugs.push(h.slug);
    return slugs;
  });

  console.log(`hit@1: ${summary.hitAt1Rate.toFixed(2)}  hit@3: ${summary.hitAt3Rate.toFixed(2)}  MRR: ${summary.mrr.toFixed(2)}`);
  for (const s of summary.perQuestion) {
    console.log(`  ${s.id}: hit@1=${s.hitAt1} hit@3=${s.hitAt3} rr=${s.reciprocalRank.toFixed(2)}`);
  }

  console.log('\nGenerating answers for hand-grading...');
  const reportLines: string[] = [
    '# A17 answer-quality eval',
    '',
    '## Retrieval scoring',
    `- hit@1: ${summary.hitAt1Rate.toFixed(2)}`,
    `- hit@3: ${summary.hitAt3Rate.toFixed(2)}`,
    `- MRR: ${summary.mrr.toFixed(2)}`,
    '',
    '## Answer transcript — hand-grade each: does this correctly answer the question, with honest citations?',
    '',
  ];

  for (const q of qrels) {
    const result = await answerQuestion(ctx, q.question);
    console.log(`\n--- ${q.id}: ${q.question} ---`);
    console.log(result.answer);

    // `cited` is pre-resolved and index-aligned with `citations`, so this no longer hand-rolls the
    // 1-based offset (nor silently drops an out-of-range index, which is what the old
    // `if (source)` guard was quietly doing — answerQuestion now rejects those at the boundary).
    const citedPairs = result.citations.map((n, i) => ({ n, slug: result.cited[i]!.slug }));

    reportLines.push(
      `### ${q.id}: ${q.question}`,
      '',
      `**Answer:** ${result.answer}`,
      '',
      `**Cited:** ${citedPairs.length ? citedPairs.map((c) => `[${c.n}] ${c.slug}`).join(', ') : '(none)'}`,
      `**Retrieved:** ${result.sources.length ? result.sources.map((s) => s.slug).join(', ') : '(none)'}`,
      '',
      'Grade: [ ] pass  [ ] fail — notes:',
      '',
      '---',
      '',
    );
  }

  await writeFile(REPORT_PATH, reportLines.join('\n'), 'utf8');
  console.log(`\nFull report written to ${REPORT_PATH}`);
  await closePools({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
