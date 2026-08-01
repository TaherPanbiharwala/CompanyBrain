// The UI's grounded/ungrounded decision, tested where it is decided.
//
// `confidenceOf` is the function that chooses between rendering an answer as a normal cited answer
// and rendering it in the DISTINCT ungrounded container. That distinction is the product's core
// promise made visible, and getting it wrong is silent by construction:
//
//   src/answer/answer.ts has a documented fallback where unparseable model output becomes the
//   ENTIRE answer with citations: [], and scrubMarkers then strips any inline marker — so the user
//   receives confident prose, no chips, in a box identical to a fully cited answer.
//
// Deriving confidence from the RESPONSE SHAPE rather than asking the model is the other half of the
// decision. A model self-reporting confidence about its own retrieval-grounded answer is noise: it
// cannot see whether retrieval worked. These three states cost nothing and cannot be hallucinated.
//
// Offline and pure: no database, no server, no DOM. It imports one function from the web bundle.
import { describe, it, expect } from 'bun:test';
import { confidenceOf, type AskResult, type ChunkHit } from '../web/src/lib/api.ts';

const chunk = (n: number): ChunkHit => ({
  chunkId: `c${n}`,
  pageId: `p${n}`,
  slug: `slug-${n}`,
  title: `Title ${n}`,
  ord: 0,
  content: `content ${n}`,
  locator: null,
  citation: null,
  scope: 'workspace',
  score: 1,
});

const result = (over: Partial<AskResult> = {}): AskResult => ({
  answer: 'some answer text',
  citations: [],
  cited: [],
  sources: [],
  ...over,
});

describe('confidenceOf — which container an answer renders in', () => {
  it('grounded: the answer cites retrieved sources', () => {
    expect(
      confidenceOf(result({ sources: [chunk(1)], cited: [chunk(1)], citations: [1] })),
    ).toBe('grounded');
  });

  it('none: nothing was retrieved at all', () => {
    // Remedy is different from the case below — ask something else, or upload the document — so it
    // must be a distinguishable state, not folded into one "no citations" bucket.
    expect(confidenceOf(result({ sources: [], citations: [] }))).toBe('none');
  });

  it('unsupported: sources WERE retrieved and the answer cited none of them', () => {
    // THE DANGEROUS ONE. This is the shape produced both by a model that ignored its evidence and
    // by answer.ts's parse-failure fallback. Rendering it identically to a cited answer is exactly
    // the failure this whole distinction exists to prevent.
    expect(confidenceOf(result({ sources: [chunk(1), chunk(2)], citations: [] }))).toBe(
      'unsupported',
    );
  });

  it('a degraded answer that still cites is grounded — degraded is a separate axis', () => {
    // `degraded: 'keyword_only'` says the SEARCH ran at reduced quality; it says nothing about
    // whether the answer used what it found. Collapsing the two would either hide a real citation
    // or cry wolf on a perfectly good answer.
    expect(
      confidenceOf(
        result({ sources: [chunk(1)], cited: [chunk(1)], citations: [1], degraded: 'keyword_only' }),
      ),
    ).toBe('grounded');
  });

  it('sources present but empty citations is NOT rescued by a non-empty cited array', () => {
    // Defensive: `cited` is derived server-side from `citations`, so this combination should never
    // arrive. Pinning it anyway means a future change to that derivation cannot quietly turn an
    // uncited answer into a grounded-looking one.
    expect(confidenceOf(result({ sources: [chunk(1)], cited: [chunk(1)], citations: [] }))).toBe(
      'unsupported',
    );
  });
});

// ── The citation NUMBER, and whether the surface is wired to any of this ──────
//
// Everything above tests confidenceOf() as a pure function. None of it asserts AnswerView calls it,
// and none of it touches the number rendered on a source chip — which is where the product's one
// promise actually lands. Both gaps were found by review; both are source scans, because this repo
// has no DOM test harness and adding one to assert two facts is the wrong trade.
describe('the answer surface is wired to the contract, not just to the types', () => {
  const view = () =>
    Bun.file(new URL('../web/src/components/AnswerView.tsx', import.meta.url)).text();
  /** Comments state the rules this file checks, so a scan that reads them proves nothing. */
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  it('the source chip shows the CITATION NUMBER, not its position in the list', async () => {
    // `citations` are 1-based indices into `sources` (answer.ts:22) and scrubMarkers keeps every
    // in-range marker, so the prose reads "[2]"/"[5]" verbatim. Numbering the chips {i + 1} made
    // the list say 1, 2 — every marker resolving to the wrong document. It coincides only when
    // citations[i] === i + 1, which is exactly the shape every case above uses (`citations: [1]`),
    // so the existing suite could not see it.
    const src = stripComments(await view());
    const at = src.indexOf('function Sources(');
    expect(at, "the Sources component is gone — this scan reads nothing").toBeGreaterThan(-1);
    const body = src.slice(at);
    expect(body.length).toBeGreaterThan(200);
    expect(body, 'the chip is numbered by array position again').not.toMatch(/\{i \+ 1\}(?!\s*\})/);
    expect(body).toMatch(/citations\[i\]/);
    // And it must actually be handed the array, not derive one.
    expect(src).toMatch(/citations=\{result\.citations\}/);
  });

  it('AnswerView DERIVES confidence from confidenceOf — the tests above guard nothing otherwise', async () => {
    // Replacing this call with a literal renders every ungrounded answer in the normal cited
    // container while all five cases above stay green. Same "wired, not merely exported" check
    // test/web-mount.test.ts applies to assertWebBuildPresent.
    const src = stripComments(await view());
    expect(src).toMatch(/const\s+confidence\s*=\s*confidenceOf\(/);
    expect(src, 'confidence is hardcoded — the decision under test is bypassed').not.toMatch(
      /const\s+confidence\s*=\s*'(grounded|none|unsupported)'/,
    );
    // Both containers must stay reachable, or one branch is dead.
    expect(src).toMatch(/confidence === 'grounded'/);
    expect(src).toMatch(/UngroundedAnswer/);
  });
});
