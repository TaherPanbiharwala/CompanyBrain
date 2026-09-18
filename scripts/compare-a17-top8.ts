// Directional A17 top-eight dump comparator. This is intentionally NOT the NovaByte gate: it
// scores the ten A17 retrieval questions only. Kept as `score:top8` for compatibility.
import { readFileSync } from 'node:fs';

const qrels = JSON.parse(readFileSync('eval/a17-qrels.json', 'utf8')) as
  { id: string; question: string; relevantSlugs: string[] }[];

function parse(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const heading = line.match(/^## (q\d+)\s/);
    if (heading) {
      current = heading[1]!;
      out.set(current, []);
      continue;
    }
    const result = line.match(/^\s+\d+\.\s+(\S+)#\d+\s*$/);
    if (result && current) out.get(current)!.push(result[1]!);
  }
  return out;
}

function score(path: string, label: string): void {
  const ranks = parse(path);
  let mrrSum = 0;
  let rank1 = 0;
  let rank3 = 0;
  let rank5 = 0;
  let foundAll = 0;
  for (const question of qrels) {
    const slugs = ranks.get(question.id) ?? [];
    const firstRelevant = slugs.findIndex((slug) => question.relevantSlugs.includes(slug));
    if (firstRelevant >= 0) {
      mrrSum += 1 / (firstRelevant + 1);
      if (firstRelevant < 1) rank1++;
      if (firstRelevant < 3) rank3++;
      if (firstRelevant < 5) rank5++;
    }
    if (question.relevantSlugs.every((slug) => slugs.includes(slug))) foundAll++;
  }
  const n = qrels.length;
  console.log(`${label.padEnd(6)}  MRR=${(mrrSum / n).toFixed(3)}  a-relevant-hit@1=${rank1}/${n}  ` +
    `@3=${rank3}/${n}  @5=${rank5}/${n}  all-relevant-in-top8=${foundAll}/${n}`);
}

const oldPath = process.argv[2];
const newPath = process.argv[3];
if (!oldPath || !newPath) throw new Error('usage: bun run compare:a17-top8 <old-dump> <new-dump>');
score(oldPath, 'OLD');
score(newPath, 'NEW');
console.log();

const comparableRank = (index: number) => index < 0 ? Number.POSITIVE_INFINITY : index;
for (const question of qrels) {
  const oldSlugs = parse(oldPath).get(question.id) ?? [];
  const newSlugs = parse(newPath).get(question.id) ?? [];
  const positions = (slugs: string[]) => question.relevantSlugs.map((relevant) => {
    const index = slugs.indexOf(relevant);
    return `${relevant}@${index < 0 ? 'MISS' : index + 1}`;
  }).join(' ');
  const oldRank = comparableRank(oldSlugs.findIndex((slug) => question.relevantSlugs.includes(slug)));
  const newRank = comparableRank(newSlugs.findIndex((slug) => question.relevantSlugs.includes(slug)));
  const marker = newRank === oldRank ? '  =' : newRank < oldRank ? ' UP' : 'DOWN';
  console.log(`${marker} ${question.id}  OLD[${positions(oldSlugs)}]  NEW[${positions(newSlugs)}]`);
}
