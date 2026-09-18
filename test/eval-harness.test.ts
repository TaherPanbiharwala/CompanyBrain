// The eval harness's grading surface, tested with no database, no network and no money.
//
// WHY THIS FILE MATTERS MORE THAN IT LOOKS. Every number the MultiHop report prints is produced by
// the functions below, and the failure mode of a scorer is not a crash — it is a plausible wrong
// number that a milestone decision then rests on. Two defects this file exists to catch, both real:
//
//   1. Three of the 609 MultiHop URLs produce slugs of 250 characters against a 200-character ingest
//      cap. Without the check below, that surfaces as an `invalid_params` failure ~400 documents into
//      a paid load, after the embeddings for those documents have already been bought.
//   2. `allEvidenceRecall` over an EMPTY gold set is the subset-of-everything trap: the natural
//      implementation scores all 301 unanswerable questions a perfect 1.0 and inflates the headline
//      metric by 12% with no error anywhere.
//
// Hand-computed expectations throughout. A test that re-derives the formula proves nothing.
import { describe, it, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  SLUG_MAX_LEN as OP_SLUG_MAX_LEN, SLUG_RE as OP_SLUG_RE, MAX_BODY_CHARS,
} from '../src/api/operations.ts';
import { slugify, findSlugCollisions, SLUG_MAX_LEN, SLUG_RE } from '../src/eval/slug.ts';
import {
  classifyAnswer,
  classifyAbstention,
  isAbstention,
  normalizeAnswer,
  stratifiedSample,
  goldSlugs,
} from '../src/eval/core.ts';
import { scoreMultiHop, scoreCandidateRecall } from '../src/search/eval-score.ts';
import { adapterNames, resolveAdapter, DEFAULT_DATASET } from '../src/eval/adapters/index.ts';
import { applyCap } from '../scripts/replay-eval.ts';
import type { EvalQuestion, DatasetBundle } from '../src/eval/types.ts';

// ── The rule-pinning test (see the comment on SLUG_MAX_LEN in src/eval/slug.ts) ──────────────

describe('slug rule stays pinned to the ingest op', () => {
  it('eval slug constants equal the op schema constants', () => {
    // src/eval/slug.ts cannot import operations.ts (it would drag the db/dispatch chain into a test
    // that must run with no database), so the two copies are held together HERE or not at all.
    expect(SLUG_MAX_LEN).toBe(OP_SLUG_MAX_LEN);
    expect(SLUG_RE.source).toBe(OP_SLUG_RE.source);
  });
});

// ── slugify: properties, not corpus facts ───────────────────────────────────────────────────

describe('slugify — properties that survive the next dataset', () => {
  it('produces an op-valid slug for a plain URL', () => {
    expect(slugify('https://www.theverge.com/2023/9/28/23893269/ftx-trial')).toBe(
      'theverge-com-2023-9-28-23893269-ftx-trial',
    );
  });

  it('handles opaque non-URL ids (BEIR style) without mangling them', () => {
    expect(slugify('MED-10')).toBe('med-10');
    expect(slugify('PLAIN_TEXT_ID')).toBe('plain-text-id');
  });

  it('THE PROPERTY: ids differing only PAST the cap still get different slugs', () => {
    // This is the test that survives dataset #2. Asserting "the 609 happen to be unique" proves the
    // property for one corpus; this proves it for the construction. Plain truncation fails here.
    const prefix = 'https://example.com/' + 'a'.repeat(250);
    expect(slugify(prefix + '/one')).not.toBe(slugify(prefix + '/two'));
  });

  it('over-long ids stay within the cap and stay op-valid', () => {
    const long = 'https://example.com/' + 'a'.repeat(400);
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LEN);
    expect(SLUG_RE.test(slug)).toBe(true);
  });

  it('is deterministic — the loader and the scorer must agree', () => {
    const id = 'https://example.com/' + 'z'.repeat(300);
    expect(slugify(id)).toBe(slugify(id));
  });

  it('an id of pure punctuation still yields a valid slug (never a bare dash)', () => {
    const slug = slugify('///???///');
    expect(slug.length).toBeGreaterThan(0);
    expect(SLUG_RE.test(slug)).toBe(true); // leading char must be [a-z0-9]
  });

  it('findSlugCollisions reports both offending ids, not just a count', () => {
    // Normalization folds `_` and `-` together, which slugify cannot detect per-id. The loader runs
    // this over the whole corpus before the first paid embedding.
    const collisions = findSlugCollisions(['MED-10', 'med_10', 'other']);
    expect(collisions.size).toBe(1);
    expect(collisions.get('med-10')).toEqual(['MED-10', 'med_10']);
  });

  it('findSlugCollisions is empty for a clean corpus', () => {
    expect(findSlugCollisions(['a', 'b', 'c']).size).toBe(0);
  });
});

// ── scoreMultiHop: every boundary, hand-computed ─────────────────────────────────────────────

describe('scoreMultiHop', () => {
  const gold = new Set(['a', 'b']);

  it('all gold present within k → allEvidenceRecall 1', () => {
    const s = scoreMultiHop(gold, ['a', 'x', 'b', 'y'], [4]);
    expect(s.perK[0]).toEqual({
      k: 4,
      allEvidenceRecall: 1,
      evidenceRecall: 1,
      hitAt1: true,
      reciprocalRank: 1,
      distinctDocs: 4,
    });
  });

  it('one of two gold present → partial credit, allEvidenceRecall 0', () => {
    const s = scoreMultiHop(gold, ['a', 'x', 'y'], [3]);
    expect(s.perK[0]!.allEvidenceRecall).toBe(0);
    expect(s.perK[0]!.evidenceRecall).toBe(0.5);
  });

  it('gold sitting past k is not counted at that k', () => {
    // 'b' is at chunk index 3, so k=2 must not see it.
    const s = scoreMultiHop(gold, ['a', 'x', 'y', 'b'], [2, 4]);
    expect(s.perK[0]!.evidenceRecall).toBe(0.5);
    expect(s.perK[1]!.evidenceRecall).toBe(1);
  });

  it('EMPTY GOLD yields null, never 1.0 — the subset-of-everything trap', () => {
    // 301 of 2,556 MultiHop questions are unanswerable. Scoring them 1.0 would inflate the headline
    // metric by ~12% with nothing anywhere reporting an error.
    const s = scoreMultiHop(new Set(), ['a', 'b'], [8]);
    expect(s.perK[0]!.allEvidenceRecall).toBeNull();
    expect(s.perK[0]!.evidenceRecall).toBeNull();
  });

  it('empty ranked list scores zero, not NaN', () => {
    const s = scoreMultiHop(gold, [], [8]);
    expect(s.perK[0]!.evidenceRecall).toBe(0);
    expect(s.perK[0]!.reciprocalRank).toBe(0);
    expect(s.perK[0]!.distinctDocs).toBe(0);
  });

  it('k larger than the list does not pretend k results existed', () => {
    const s = scoreMultiHop(gold, ['a', 'b'], [20]);
    expect(s.perK[0]!.distinctDocs).toBe(2);
    expect(s.perK[0]!.allEvidenceRecall).toBe(1);
  });

  it('duplicate slugs collapse for ranking but consume chunk slots', () => {
    // Three chunks of page 'a' then 'b': at k=3 only 'a' is reachable, at k=4 both are.
    const s = scoreMultiHop(gold, ['a', 'a', 'a', 'b'], [3, 4]);
    expect(s.perK[0]!.distinctDocs).toBe(1);
    expect(s.perK[0]!.evidenceRecall).toBe(0.5);
    expect(s.perK[1]!.distinctDocs).toBe(2);
    expect(s.perK[1]!.evidenceRecall).toBe(1);
  });

  it('reciprocalRank is over DISTINCT documents, not chunks', () => {
    // 'b' is the second distinct document even though it is the fourth chunk.
    const s = scoreMultiHop(new Set(['b']), ['a', 'a', 'a', 'b'], [4]);
    expect(s.perK[0]!.reciprocalRank).toBe(0.5);
    expect(s.perK[0]!.hitAt1).toBe(false);
  });

  it('distinctDocsTotal spans the whole list regardless of k', () => {
    expect(scoreMultiHop(gold, ['a', 'b', 'c'], [1]).distinctDocsTotal).toBe(3);
  });
});

describe('scoreCandidateRecall', () => {
  it('measures pool membership, not rank', () => {
    expect(scoreCandidateRecall(new Set(['a', 'b']), ['z', 'y', 'b', 'a'])).toBe(1);
    expect(scoreCandidateRecall(new Set(['a', 'b']), ['z', 'a'])).toBe(0.5);
    expect(scoreCandidateRecall(new Set(['a']), [])).toBe(0);
  });

  it('is null for an unanswerable question', () => {
    expect(scoreCandidateRecall(new Set(), ['a'])).toBeNull();
  });
});

// ── classifyAnswer / abstention ──────────────────────────────────────────────────────────────

describe('classifyAnswer', () => {
  it('recognizes the real boolean vocabulary, both polarities', () => {
    for (const v of ['Yes', 'no', 'No', 'True', 'Consistent', 'Agree', 'false', 'Disagree']) {
      expect(classifyAnswer(v)).toBe('boolean');
    }
  });

  it('recognizes the null marker with or without its period', () => {
    expect(classifyAnswer('Insufficient information.')).toBe('null');
    expect(classifyAnswer('insufficient information')).toBe('null');
  });

  it('everything else is an entity', () => {
    expect(classifyAnswer('Sam Bankman-Fried')).toBe('entity');
    expect(classifyAnswer('Google')).toBe('entity');
  });

  it('normalizeAnswer keeps internal punctuation, strips only the edges', () => {
    expect(normalizeAnswer('  "Sam Bankman-Fried."  ')).toBe('sam bankman-fried');
  });
});

describe('classifyAbstention — the three-part conjunction', () => {
  it('clean abstention: phrase, no citations, no claim', () => {
    expect(classifyAbstention('The evidence provided does not contain this information.', []))
      .toBe('abstained');
  });

  it('no abstention phrase at all → answered', () => {
    expect(classifyAbstention('It was Sam Bankman-Fried [1].', [1])).toBe('answered');
  });

  it('THE TRAP: hedged then answered is partial, not a clean abstention', () => {
    // A keyword matcher scores this as a pass. It hedged and then answered anyway, which on private
    // documents is the shape that actually misleads a reader.
    expect(
      classifyAbstention("The evidence doesn't contain X, but based on [2] it may be Y.", [2]),
    ).toBe('partial');
  });

  it('abstention phrase WITH citations is partial even without a contrastive marker', () => {
    expect(classifyAbstention('The evidence does not contain this.', [1])).toBe('partial');
  });

  it('abstention phrase with a speculative continuation is partial even with no citations', () => {
    expect(classifyAbstention('Not enough information, though it suggests Acme.', [])).toBe('partial');
  });

  it('isAbstention treats partial as NOT an abstention', () => {
    expect(isAbstention("It doesn't contain X, but it may be Y.", [])).toBe(false);
    expect(isAbstention('The evidence does not contain this information.', [])).toBe(true);
  });
});

// ── stratifiedSample ─────────────────────────────────────────────────────────────────────────

function mkQuestions(spec: Record<string, number>): EvalQuestion[] {
  const out: EvalQuestion[] = [];
  for (const [type, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i++) {
      out.push({ id: `${type}-${i}`, text: 't', goldDocIds: [], type });
    }
  }
  return out;
}

describe('stratifiedSample', () => {
  const pop = mkQuestions({ a: 60, b: 30, c: 10 }); // 100 total, 60/30/10

  it('preserves proportions exactly', () => {
    const s = stratifiedSample(pop, 10, 1);
    const counts = { a: 0, b: 0, c: 0 } as Record<string, number>;
    for (const q of s) counts[q.type!]!++;
    expect(counts).toEqual({ a: 6, b: 3, c: 1 });
  });

  it('returns EXACTLY n even when the split does not divide evenly', () => {
    // 7 * 0.6 = 4.2, 7 * 0.3 = 2.1, 7 * 0.1 = 0.7 — largest remainder must land on 7, not 6.
    expect(stratifiedSample(pop, 7, 1).length).toBe(7);
  });

  it('same seed → identical selection; different seed → different selection', () => {
    const ids = (s: EvalQuestion[]) => s.map((q) => q.id).join(',');
    expect(ids(stratifiedSample(pop, 20, 42))).toBe(ids(stratifiedSample(pop, 20, 42)));
    expect(ids(stratifiedSample(pop, 20, 42))).not.toBe(ids(stratifiedSample(pop, 20, 43)));
  });

  it('n = 0 → empty, n = 1 → one, n > population → the whole population', () => {
    expect(stratifiedSample(pop, 0, 1)).toEqual([]);
    expect(stratifiedSample(pop, 1, 1).length).toBe(1);
    expect(stratifiedSample(pop, 500, 1).length).toBe(100);
  });

  it('never duplicates a question', () => {
    const s = stratifiedSample(pop, 37, 7);
    expect(new Set(s.map((q) => q.id)).size).toBe(37);
  });

  it('honours n when one stratum runs out of members', () => {
    // c has only 2 members but proportionally deserves ~10; the shortfall goes to a and b.
    const skewed = mkQuestions({ a: 50, b: 48, c: 2 });
    expect(stratifiedSample(skewed, 40, 3).length).toBe(40);
  });

  it('untyped questions form their own stratum rather than throwing', () => {
    const mixed: EvalQuestion[] = [
      { id: '1', text: 't', goldDocIds: [] },
      { id: '2', text: 't', goldDocIds: [], type: 'x' },
    ];
    expect(stratifiedSample(mixed, 2, 1).length).toBe(2);
  });
});

describe('goldSlugs', () => {
  it('maps gold ids through the same slugify the loader uses', () => {
    const q: EvalQuestion = {
      id: 'q', text: 't',
      goldDocIds: ['https://www.example.com/a', 'https://example.com/b'],
    };
    expect(goldSlugs(q)).toEqual(new Set(['example-com-a', 'example-com-b']));
  });

  it('is empty for an unanswerable question', () => {
    expect(goldSlugs({ id: 'q', text: 't', goldDocIds: [] }).size).toBe(0);
  });
});

// ── Adapter registry ─────────────────────────────────────────────────────────────────────────

describe('adapter registry', () => {
  it('exposes the default dataset', () => {
    expect(adapterNames()).toContain(DEFAULT_DATASET);
  });

  it('an unknown name tells you what IS available instead of returning undefined', () => {
    expect(() => resolveAdapter('nope')).toThrow(/unknown --dataset "nope"\. Available: /);
  });
});

// ── Dataset-dependent checks ─────────────────────────────────────────────────────────────────
//
// These read the real corpus off disk (no network, no DB). They skip when the dataset is absent so
// the suite stays runnable in CI, and say so loudly rather than passing silently.

const DATASET_DIR = process.env.MULTIHOP_DIR ?? `${process.env.HOME}/Desktop/Datasets/MultiHopRAG`;
const HAVE_DATASET = existsSync(`${DATASET_DIR}/corpus.json`);
if (!HAVE_DATASET) {
  console.warn(
    `[eval-harness.test] SKIPPING dataset checks: no corpus at ${DATASET_DIR}. ` +
      `The slug-vs-cap and adapter-conformance checks did NOT run.`,
  );
}

describe.if(HAVE_DATASET)('MultiHop adapter, against the real files', () => {
  let bundle: DatasetBundle;

  it('loads', async () => {
    bundle = await resolveAdapter('multihop').load(DATASET_DIR);
    expect(bundle.docs.length).toBe(609);
    expect(bundle.questions.length).toBe(2556);
  });

  it('EVERY document slug satisfies the ingest op, cap included', async () => {
    // The highest-value assertion in this file: it is what stops the loader dying mid-run, after
    // paying for embeddings, on the three URLs that exceed 200 characters.
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    const bad = bundle.docs
      .map((d) => ({ id: d.id, slug: slugify(d.id) }))
      .filter((x) => x.slug.length > OP_SLUG_MAX_LEN || !OP_SLUG_RE.test(x.slug));
    expect(bad).toEqual([]);
  });

  it('slugs are unique across the corpus', async () => {
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    expect(findSlugCollisions(bundle.docs.map((d) => d.id)).size).toBe(0);
  });

  it('ROUND TRIP: every gold id resolves to a document that was loaded', async () => {
    // Collision-freedom is strictly weaker than the join actually needed. This is the join.
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    const corpus = new Set(bundle.docs.map((d) => slugify(d.id)));
    const dangling = bundle.questions
      .flatMap((q) => [...goldSlugs(q)])
      .filter((slug) => !corpus.has(slug));
    expect(dangling).toEqual([]);
  });

  it('unanswerable questions carry an EMPTY gold list', async () => {
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    const nulls = bundle.questions.filter((q) => q.type === 'null_query');
    expect(nulls.length).toBe(301);
    expect(nulls.every((q) => q.goldDocIds.length === 0)).toBe(true);
  });

  it('gold ids are deduped — evidence entries can share a document', async () => {
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    const answerable = bundle.questions.filter((q) => q.goldDocIds.length > 0);
    expect(answerable.every((q) => new Set(q.goldDocIds).size === q.goldDocIds.length)).toBe(true);
    // Measured distribution after dedupe: 2 -> 1169, 3 -> 774, 4 -> 312.
    const two = answerable.filter((q) => q.goldDocIds.length === 2).length;
    expect(two).toBe(1169);
  });

  it('classifyAnswer covers every gold answer in the set', async () => {
    // Only 107 distinct values, so this is a cheap exhaustive check that no answer shape is unhandled.
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    for (const q of bundle.questions) {
      expect(['boolean', 'entity', 'null']).toContain(classifyAnswer(q.expectedAnswer ?? ''));
    }
  });

  it('every null_query gold answer classifies as null', async () => {
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    for (const q of bundle.questions.filter((x) => x.type === 'null_query')) {
      expect(classifyAnswer(q.expectedAnswer ?? '')).toBe('null');
    }
  });

  it('metadata carries what the engine cannot index, for the plain-vs-meta A/B', async () => {
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    // source and published_at are present on every document — they are the two fields 92% of the
    // questions key on and that the engine has nowhere to put.
    expect(bundle.docs.every((d) => d.metadata?.source)).toBe(true);
    expect(bundle.docs.every((d) => d.metadata?.published_at)).toBe(true);
  });

  it('a missing author is OMITTED, never rendered as a literal', async () => {
    // Measured three ways, not two: 64 documents have a JSON `null` author, 4 more have an
    // empty-or-whitespace string, and 541 have a real one. Folding only the nulls would put
    // `Author: ` — a blank label — into the metadata header for those 4, adding a misleading token
    // to the index for the exact arm the plain-vs-meta A/B is trying to measure.
    bundle ??= await resolveAdapter('multihop').load(DATASET_DIR);
    const withAuthor = bundle.docs.filter((d) => d.metadata?.author !== undefined);
    expect(withAuthor.length).toBe(541);
    expect(withAuthor.every((d) => (d.metadata!.author as string).trim().length > 0)).toBe(true);
  });
});

// ── singletopic adapter, against the real files ──────────────────────────────────────────────

const SINGLETOPIC_DIR = process.env.SINGLETOPIC_DIR ?? `${process.env.HOME}/Desktop/RAGTest`;
const HAVE_SINGLETOPIC = existsSync(`${SINGLETOPIC_DIR}/documents.csv`);
if (!HAVE_SINGLETOPIC) {
  console.warn(
    `[eval-harness.test] SKIPPING dataset checks: no corpus at ${SINGLETOPIC_DIR}. ` +
      `The singletopic adapter-conformance checks did NOT run.`,
  );
}

describe.if(HAVE_SINGLETOPIC)('singletopic adapter, against the real files', () => {
  let bundle: DatasetBundle;
  const load = async () => (bundle ??= await resolveAdapter('singletopic').load(SINGLETOPIC_DIR));

  it('loads 20 documents and 120 questions (40 single + 40 multi + 40 no-answer)', async () => {
    bundle = await load();
    expect(bundle.docs.length).toBe(20);
    expect(bundle.questions.length).toBe(120);
  });

  it('EVERY document slug satisfies the ingest op, cap included', async () => {
    bundle = await load();
    const bad = bundle.docs
      .map((d) => ({ id: d.id, slug: slugify(d.id) }))
      .filter((x) => x.slug.length > OP_SLUG_MAX_LEN || !OP_SLUG_RE.test(x.slug));
    expect(bad).toEqual([]);
  });

  it('slugs are unique across the corpus', async () => {
    bundle = await load();
    expect(findSlugCollisions(bundle.docs.map((d) => d.id)).size).toBe(0);
  });

  it('every document body fits the ingest op\'s MAX_BODY_CHARS, even document 16', async () => {
    // Pinned to the live op constant, not to SAFE_BODY_CHARS's own copy of it — the same reason the
    // slug-rule test above pins to OP_SLUG_MAX_LEN: two independent copies of the same bound are a
    // silent-drift risk, one test away from a paid embedding call failing 16 documents into a load.
    bundle = await load();
    const over = bundle.docs.filter((d) => d.body.length > MAX_BODY_CHARS);
    expect(over).toEqual([]);
    // And the truncation is real, not a no-op — document 16 (Stardew Valley's Version History,
    // ~212k raw chars) must actually have been cut down, or this test would pass for the wrong reason.
    const doc16 = bundle.docs.find((d) => d.id === '16');
    expect(doc16?.body.length).toBeLessThan(200_000);
  });

  it('ROUND TRIP: every gold id resolves to a document that was loaded', async () => {
    bundle = await load();
    const corpus = new Set(bundle.docs.map((d) => slugify(d.id)));
    const dangling = bundle.questions
      .flatMap((q) => [...goldSlugs(q)])
      .filter((slug) => !corpus.has(slug));
    expect(dangling).toEqual([]);
  });

  it('single- and multi-passage questions each name EXACTLY ONE gold document', async () => {
    // Unlike MultiHop, this dataset has no cross-document multi-hop — see singletopic.ts's header.
    bundle = await load();
    for (const type of ['single_passage', 'multi_passage']) {
      const qs = bundle.questions.filter((q) => q.type === type);
      expect(qs.length).toBe(40);
      expect(qs.every((q) => q.goldDocIds.length === 1)).toBe(true);
    }
  });

  it('no-answer questions carry an EMPTY gold list, not the document they were paired with', async () => {
    bundle = await load();
    const nulls = bundle.questions.filter((q) => q.type === 'no_answer');
    expect(nulls.length).toBe(40);
    expect(nulls.every((q) => q.goldDocIds.length === 0)).toBe(true);
  });

  it('every document carries its source URL, for the plain-vs-meta A/B', async () => {
    bundle = await load();
    expect(bundle.docs.every((d) => typeof d.metadata?.source === 'string' && d.metadata.source.length > 0)).toBe(
      true,
    );
  });
});

// ── Replay: the per-page cap simulator ───────────────────────────────────────────────────────
//
// This decides whether a tuning line stays open, so its arithmetic is pinned here rather than
// trusted. The composition property is what makes replaying from a cap-3 log legitimate at all.

describe('applyCap — the per-page cap replay', () => {
  it('keeps the FIRST occurrences, in order', () => {
    expect(applyCap(['a', 'a', 'a', 'b', 'b', 'c'], 2)).toEqual(['a', 'a', 'b', 'b', 'c']);
  });

  it('THE COMPOSITION PROPERTY: filter(filter(L,3),2) === filter(L,2)', () => {
    // This is why a cap-3 log can be replayed at cap 2 without re-querying. If it failed, every
    // simulated number would be wrong and nothing would say so.
    const L = ['a', 'b', 'a', 'c', 'a', 'a', 'b', 'd', 'b', 'c'];
    expect(applyCap(applyCap(L, 3), 2)).toEqual(applyCap(L, 2));
  });

  it('a cap at or above the log’s own cap is the identity', () => {
    const L = ['a', 'a', 'b', 'c', 'c'];
    expect(applyCap(L, 3)).toEqual(L);
    expect(applyCap(L, 99)).toEqual(L);
  });

  it('cap 1 collapses to the distinct documents, in first-seen order', () => {
    expect(applyCap(['a', 'b', 'a', 'c', 'b'], 1)).toEqual(['a', 'b', 'c']);
  });

  it('WHY THE DISTINCT LIST CANNOT BE REPLAYED: two different logs, same distinct list', () => {
    // The bug this test exists to prevent. Both collapse to [a,b,c,d]; under cap 2 one yields 5
    // documents in the top 8 and the other is unchanged. A simulator fed the distinct list reports
    // "no effect" for every configuration and looks like it worked.
    const packed = ['a', 'a', 'a', 'b', 'b', 'c', 'd', 'd'];
    const spread = ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd'];
    expect([...new Set(packed)]).toEqual([...new Set(spread)]);
    expect(applyCap(packed, 2).slice(0, 8)).not.toEqual(applyCap(spread, 2).slice(0, 8));
  });

  it('is a no-op on an already-distinct list — the failure mode, demonstrated', () => {
    const distinctOnly = ['a', 'b', 'c', 'd'];
    expect(applyCap(distinctOnly, 2)).toEqual(distinctOnly);
  });

  it('empty input stays empty', () => {
    expect(applyCap([], 2)).toEqual([]);
  });
});

describe('adapter error shapes', () => {
  it('a missing directory names the dataset AND how to get it', async () => {
    await expect(resolveAdapter('multihop').load('/nonexistent/path/xyz')).rejects.toThrow(
      /hf download yixuantt\/MultiHopRAG/,
    );
  });
});
