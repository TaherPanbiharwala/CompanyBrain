// Meta-test: the live gate cannot rot.
//
// `CB_REQUIRE_LIVE_TESTS=1` only means something if EVERY database-backed suite routes its gate
// through liveOrFail(). The M2 review found the flag wired to nothing, which meant the whole
// cross-tenant canary could report green on a machine with no database. Fixing the six suites that
// existed then is not enough — the seventh, written six months from now, is the one that will
// silently skip. So this asserts the property mechanically instead of trusting a convention.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = new URL('.', import.meta.url).pathname;

/** Suites that MUST exist and MUST be live-gated. Deleting the file is a way to disable a test that
 *  a content scan cannot see, and the leak canary is the one file where that matters (D16 —
 *  sacred, runs in CI forever). Neutering it trips the scan below; deleting it trips this. */
const REQUIRED_LIVE_SUITES = ['leak-canary.test.ts'];

test('every suite gated on a live database routes through liveOrFail', () => {
  const offenders: string[] = [];
  const present = readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.ts'));

  for (const name of present) {
    const src = readFileSync(join(TEST_DIR, name), 'utf8');

    // A suite is "live" if it needs a database — either by reading a connection string directly, or
    // (far more common here) via the shared hasDbEnv() helper.
    //
    // The `hasDbEnv` half is load-bearing and was missing: hasDbEnv's own `process.env` read lives
    // in test/helpers/live.ts, which is not a `.test.ts` file and so is never scanned. Under the
    // old DATABASE_-only predicate exactly ONE suite matched (m2-auth) while nine others —
    // rls-smoke, scope-acl, hybrid, answer, ingest, api, mcp, invites — were invisible. A meta-test
    // written so "a suite added later cannot quietly opt out" was checking 10% of the suites, and a
    // canary using hasDbEnv() (which is the documented pattern) would not have been one of them.
    const usesDb = /hasDbEnv|process\.env\.DATABASE_(URL|ADMIN_URL|AUTH_URL)/.test(src);
    if (!usesDb) continue;

    // …and it must derive its gate from the shared helper, not from a hand-rolled boolean.
    if (!src.includes('liveOrFail')) offenders.push(name);
  }

  // A SECOND way to opt out, found in the M3 review: keep liveOrFail and then weaken its RESULT.
  // test/ingest-file.test.ts had `const live = liveOrFail('ingest-file', hasDbEnv()) && HAVE;` —
  // the scan above passed (the string is right there), liveOrFail returned true, and `&& HAVE`
  // turned it back to false, so a missing fixture skipped the whole suite green under the very flag
  // that exists to forbid skipping. The condition belongs INSIDE the call, where it can throw.
  // Paren-balanced, NOT a regex. `/liveOrFail\([^)]*\)\s*&&/` looks right and is wrong: `[^)]*`
  // stops at the first `)`, which inside `liveOrFail('mcp', hasDbEnv() && ...)` is hasDbEnv's own —
  // so it flags every suite that legitimately passes a compound condition INTO the call, which is
  // precisely the shape being asked for. Walk to the matching close paren instead.
  const weakened = present.filter((name) => {
    // COMMENTS STRIPPED FIRST. Both this file and ingest-file.test.ts document the forbidden shape
    // in prose, and a scanner that cannot tell code from a comment about code flags its own
    // explanation — which is how the `...process.env` assertion in test/extract.test.ts started
    // failing on a comment describing it.
    const src = readFileSync(join(TEST_DIR, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    for (let at = src.indexOf('liveOrFail('); at !== -1; at = src.indexOf('liveOrFail(', at + 1)) {
      let depth = 0;
      let i = at + 'liveOrFail'.length;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      // What follows the CALL, not what is inside it.
      if (/^\s*(?:&&|\|\|)/.test(src.slice(i + 1))) return true;
    }
    return false;
  });
  expect(
    weakened,
    `these suites combine liveOrFail() with another condition, which re-enables silent skipping: ` +
      `${weakened.join(', ')}. Fold the extra condition into the call — liveOrFail(name, a && b) — ` +
      `so it FAILS under CB_REQUIRE_LIVE_TESTS=1 instead of skipping.`,
  ).toEqual([]);

  expect(
    offenders,
    `these suites need a live database but do not use liveOrFail(), so they will SKIP ` +
      `instead of FAIL under CB_REQUIRE_LIVE_TESTS=1: ${offenders.join(', ')}`,
  ).toEqual([]);

  const missing = REQUIRED_LIVE_SUITES.filter((n) => !present.includes(n));
  expect(
    missing,
    `these suites are required to exist and are gone: ${missing.join(', ')}. ` +
      `The leak canary is sacred (D16) — if it is genuinely being renamed, update ` +
      `REQUIRED_LIVE_SUITES in this file as part of the same change.`,
  ).toEqual([]);
});

test('liveOrFail throws rather than skipping when the flag demands a live run', async () => {
  const { liveOrFail } = await import('./helpers/live.ts');
  const { config } = await import('../src/config.ts');

  // Ready ⇒ true regardless of the flag.
  expect(liveOrFail('probe', true)).toBe(true);

  const original = config.CB_REQUIRE_LIVE_TESTS;
  try {
    (config as { CB_REQUIRE_LIVE_TESTS: number }).CB_REQUIRE_LIVE_TESTS = 0;
    expect(liveOrFail('probe', false)).toBe(false); // permitted to skip

    (config as { CB_REQUIRE_LIVE_TESTS: number }).CB_REQUIRE_LIVE_TESTS = 1;
    expect(() => liveOrFail('probe', false)).toThrow(/CB_REQUIRE_LIVE_TESTS=1/);
  } finally {
    (config as { CB_REQUIRE_LIVE_TESTS: number }).CB_REQUIRE_LIVE_TESTS = original;
  }
});
