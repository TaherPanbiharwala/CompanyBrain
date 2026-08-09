// Score two dump-top8 files against eval/a17-qrels.json. Not a substitute for an eval harness —
// it reads the same 10 questions the top-8 dump uses — but "the ranking moved" is not a verdict, and
// MRR/recall over hand-labelled relevant slugs is at least a directional one.
import { readFileSync } from 'node:fs';

const qrels = JSON.parse(readFileSync('eval/a17-qrels.json', 'utf8')) as
  { id: string; question: string; relevantSlugs: string[] }[];

function parse(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur = '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = line.match(/^## (q\d+)\s/);
    if (h) { cur = h[1]!; out.set(cur, []); continue; }
    const r = line.match(/^\s+\d+\.\s+(\S+)#\d+\s*$/);
    if (r && cur) out.get(cur)!.push(r[1]!);
  }
  return out;
}

function score(path: string, label: string) {
  const ranks = parse(path);
  let mrrSum = 0, r1 = 0, r3 = 0, r5 = 0, foundAll = 0;
  for (const q of qrels) {
    const slugs = ranks.get(q.id) ?? [];
    const firstRel = slugs.findIndex((s) => q.relevantSlugs.includes(s));
    if (firstRel >= 0) {
      mrrSum += 1 / (firstRel + 1);
      if (firstRel < 1) r1++;
      if (firstRel < 3) r3++;
      if (firstRel < 5) r5++;
    }
    const covered = q.relevantSlugs.filter((s) => slugs.includes(s)).length;
    if (covered === q.relevantSlugs.length) foundAll++;
  }
  const n = qrels.length;
  console.log(`${label.padEnd(6)}  MRR=${(mrrSum / n).toFixed(3)}  a-relevant-hit@1=${r1}/${n}  @3=${r3}/${n}  @5=${r5}/${n}  all-relevant-in-top8=${foundAll}/${n}`);
  return { mrr: mrrSum / n, r1, r3, foundAll };
}

// Called for the summary lines score() prints, not for the returned metrics — the per-question
// comparison below re-derives what it needs from the files directly.
score(process.argv[2]!, 'OLD');
score(process.argv[3]!, 'NEW');
console.log();
// findIndex returns -1 for "not found", and -1 sorts as the best possible rank in a plain numeric
// comparison — the opposite of what it means. A relevant doc present in OLD (rank 2) but missing in
// NEW (-1) was marked UP ("-1 < 2"); a doc missing in OLD but found in NEW was marked DOWN
// ("2 < -1" is false). Both directions inverted whenever a doc was missing on either side. Map
// "missing" to worse-than-any-real-rank before comparing; `pos()` below still prints -1 as MISS.
const rankFor = (i: number) => (i < 0 ? Infinity : i);

for (const q of qrels) {
  const oldS = parse(process.argv[2]!).get(q.id) ?? [];
  const newS = parse(process.argv[3]!).get(q.id) ?? [];
  const pos = (s: string[]) => q.relevantSlugs.map((r) => { const i = s.indexOf(r); return `${r}@${i < 0 ? 'MISS' : i + 1}`; }).join(' ');
  const oldFirst = oldS.findIndex((s) => q.relevantSlugs.includes(s));
  const newFirst = newS.findIndex((s) => q.relevantSlugs.includes(s));
  const oldRank = rankFor(oldFirst);
  const newRank = rankFor(newFirst);
  const mark = newRank === oldRank ? '  =' : newRank < oldRank ? ' UP' : 'DOWN';
  console.log(`${mark} ${q.id}  OLD[${pos(oldS)}]  NEW[${pos(newS)}]`);
}
