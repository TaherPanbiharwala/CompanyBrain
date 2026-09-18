// Meta-test: the live gate cannot rot.
//
// `CB_REQUIRE_LIVE_TESTS=1` only means something if EVERY database-backed suite routes its gate
// through liveOrFail(). The M2 review found the flag wired to nothing, which meant the whole
// cross-tenant canary could report green on a machine with no database. Fixing the six suites that
// existed then is not enough — the seventh, written six months from now, is the one that will
// silently skip. So this asserts the property mechanically instead of trusting a convention.
//
// MERGE NOTE: master and the M3 branch each rewrote this file from scratch after finding DIFFERENT
// ways it had already failed, so what follows is the UNION of both and not a choice between them.
// From master: the three-signal touchesDb() and the anti-vacuity FLOOR. From M3: the paren-balanced
// weakened-gate scanner. Dropping either would drop a guard that exists because the thing it catches
// has happened once already. This file has now been broken and re-fixed three times; treat any
// change to it as high risk.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = new URL('.', import.meta.url).pathname;

/** Suites that MUST exist as FILES. Deleting the file is a way to disable a test that a content scan
 *  cannot see, and the leak canary is the one file where that matters (D16 — sacred, runs in CI
 *  forever). Neutering it trips the scan below; deleting it trips this.
 *
 *  Distinct from REQUIRED_LIVE_SUITES further down, which pins gate NAMES. Both arrived in this file
 *  from different branches and they catch different things: a filename survives a gate rename, a gate
 *  name survives a file rename. Keeping only one leaves the other hole open. */
const REQUIRED_LIVE_SUITE_FILES = ['leak-canary.test.ts'];

/** The ONLY suites permitted to gate on `perfOrFail` instead of `liveOrFail` (D93).
 *
 *  An ALLOWLIST, and checked in BOTH directions below. `perfOrFail` is a second escape hatch by
 *  construction — it returns false whenever CB_RUN_PERF_TESTS is unset — so it is exactly the kind of
 *  helper that, left ungoverned, becomes the way a suite skips green under CB_REQUIRE_LIVE_TESTS=1.
 *  Widening this list must be a deliberate act, never a side effect of someone adding a slow test. */
const PERF_SUITE_FILES = ['perf-recall.test.ts'];

/** Does this suite touch the database?
 *
 *  THREE signals, not one. The first version looked only for a literal `process.env.DATABASE_*` in
 *  the file — and every live suite reads those through `hasDbEnv()`, whose own `process.env` read
 *  lives in test/helpers/live.ts, which is not a `.test.ts` file and so is never scanned. Exactly
 *  ONE suite of ten matched (m2-auth) while rls-smoke, scope-acl, hybrid, answer, ingest, api, mcp
 *  and invites were invisible. The guard written to stop a suite silently opting out could not see
 *  the suites it was guarding.
 *
 *  Importing anything from `src/db/client.ts` is the reliable signal: adminSql/appSql/withScopedTx/
 *  closePools are the only ways into the pools, and a suite cannot reach the database without one. */
function touchesDb(src: string): boolean {
  return (
    /from '\.\.\/src\/db\/client\.ts'/.test(src) ||
    /hasDbEnv\s*\(/.test(src) ||
    /process\.env\.DATABASE_(URL|ADMIN_URL|AUTH_URL)/.test(src)
  );
}

test('every suite gated on a live database routes through liveOrFail', () => {
  const offenders: string[] = [];
  const perfMisuse: string[] = [];
  const inspected: string[] = [];
  const present = readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.ts'));

  for (const name of present) {
    const src = readFileSync(join(TEST_DIR, name), 'utf8');
    if (!touchesDb(src)) continue;
    inspected.push(name);

    // …and it must derive its gate from the shared helper, not from a hand-rolled boolean.
    // perfOrFail counts as gated (D93), but only for the suite entitled to use it — see next.
    if (!src.includes('liveOrFail') && !src.includes('perfOrFail')) offenders.push(name);

    // perfOrFail outside PERF_SUITE_FILES is the offender list's blind spot. It satisfies the check
    // above (a shared helper IS being used) while returning false whenever CB_RUN_PERF_TESTS is
    // unset — so a suite that adopted it would skip green under CB_REQUIRE_LIVE_TESTS=1, which is
    // the same hole as the `&& HAVE` shape below wearing a helper's name. The live-gate exclusion
    // matches the precedent at the name collector further down: this file's own perfOrFail
    // references are fixtures and prose, not a suite gate.
    if (name !== 'live-gate.test.ts' && src.includes('perfOrFail') && !PERF_SUITE_FILES.includes(name)) {
      perfMisuse.push(name);
    }
  }

  // The floor is the anti-vacuity clause, and it is the whole reason the old version passed while
  // covering one file in ten: `offenders` is empty both when every suite is gated AND when the
  // detector matches nothing at all. Those two states must not look alike. If a refactor renames
  // the client module or the suites stop importing it, this fails instead of quietly going blind.
  expect(
    inspected.length,
    `the live-suite detector matched only ${inspected.length} files (${inspected.join(', ')}). ` +
      `That is too few to be right — it means touchesDb() has gone blind, not that the suites are clean.`,
  ).toBeGreaterThanOrEqual(8);

  // A SECOND way to opt out, found in the M3 review: keep liveOrFail and then weaken its RESULT.
  // test/ingest-file.test.ts had `const live = liveOrFail('ingest-file', hasDbEnv()) && HAVE;` —
  // the scan above passed (the string is right there), liveOrFail returned true, and `&& HAVE`
  // turned it back to false, so a missing fixture skipped the whole suite green under the very flag
  // that exists to forbid skipping. The condition belongs INSIDE the call, where it can throw.
  //
  // Paren-balanced, NOT a regex. `/liveOrFail\([^)]*\)\s*&&/` looks right and is wrong: `[^)]*`
  // stops at the first `)`, which inside `liveOrFail('mcp', hasDbEnv() && ...)` is hasDbEnv's own —
  // so it would flag every suite that legitimately passes a compound condition INTO the call, which
  // is precisely the shape being asked for. Walk to the matching close paren instead.
  const weakened = present.filter((name) => {
    // COMMENTS STRIPPED FIRST. Both this file and ingest-file.test.ts document the forbidden shape
    // in prose, and a scanner that cannot tell code from a comment about code flags its own
    // explanation — which is how the `...process.env` assertion in test/extract.test.ts started
    // failing on a comment describing it.
    const src = readFileSync(join(TEST_DIR, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    // BOTH gate helpers (D93). perfOrFail carries the identical hazard — `perfOrFail(n, x) && HAVE`
    // keeps the call, weakens its result, and restores the silent skip — and it is worse there,
    // because that suite's whole justification is that it may skip when unrequested, so a weakened
    // gate reads as intentional. `fn.length - 1` lands i on the '(' already inside the search string,
    // exactly where the single-name version put it, so `depth` still starts from that paren.
    for (const fn of ['liveOrFail(', 'perfOrFail(']) {
      for (let at = src.indexOf(fn); at !== -1; at = src.indexOf(fn, at + 1)) {
        let depth = 0;
        let i = at + fn.length - 1;
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
    `these suites touch the database but do not use liveOrFail(), so they will SKIP ` +
      `instead of FAIL under CB_REQUIRE_LIVE_TESTS=1: ${offenders.join(', ')}`,
  ).toEqual([]);

  expect(
    perfMisuse,
    `these suites gate on perfOrFail() but are not in PERF_SUITE_FILES: ${perfMisuse.join(', ')}. ` +
      `perfOrFail returns false whenever CB_RUN_PERF_TESTS is unset, so adopting it outside the perf ` +
      `suite is a way to skip GREEN under CB_REQUIRE_LIVE_TESTS=1. Use liveOrFail, or add the file to ` +
      `PERF_SUITE_FILES deliberately.`,
  ).toEqual([]);

  const missingFiles = REQUIRED_LIVE_SUITE_FILES.filter((n) => !present.includes(n));
  expect(
    missingFiles,
    `these suites are required to exist and are gone: ${missingFiles.join(', ')}. ` +
      `The leak canary is sacred (D16) — if it is genuinely being renamed, update ` +
      `REQUIRED_LIVE_SUITE_FILES in this file as part of the same change.`,
  ).toEqual([]);

  // The other direction on PERF_SUITE_FILES. Without it the allowlist only ever RESTRICTS, and
  // deleting test/perf-recall.test.ts would silently drop three properties nothing else covers —
  // the same asymmetry the reverse check on REQUIRED_LIVE_SUITES exists to close.
  const perfGone = PERF_SUITE_FILES.filter(
    (n) => !present.includes(n) || !readFileSync(join(TEST_DIR, n), 'utf8').includes('perfOrFail'),
  );
  expect(
    perfGone,
    `these perf suites are required to exist AND to gate on perfOrFail, and do not: ${perfGone.join(', ')}. ` +
      `They hold the only coverage of filtered-HNSW recall at scale, GUC bleed across a pooled ` +
      `connection, and pool headroom (test/leak-canary.test.ts:5-7). If one is genuinely being ` +
      `renamed or retired, change PERF_SUITE_FILES in the same commit.`,
  ).toEqual([]);
});

/** The live suites that must EXIST, keyed by the name each one passes to liveOrFail().
 *
 *  The scan above answers "is every database-backed suite gated?". It cannot answer "is every suite
 *  that should exist still here?", because a deleted suite deletes its own evidence: drop the live
 *  `describe` block and the `src/db/client.ts` import goes with it, touchesDb() stops matching, and
 *  the file falls out of `inspected` entirely. The floor is the only thing left standing — and at 8
 *  against 10 real suites it will absorb the loss of two before it says a word.
 *
 *  Names, not filenames: a rename is free, a deletion is not. What is being pinned is the coverage,
 *  not the path it happens to live at today.
 *
 *  `mcp` is on this list for a specific reason. Its gate needs CB_MCP_PRINCIPAL and CB_MCP_WORKSPACE
 *  on top of the connection strings, so for as long as those were unset the suite could not run at
 *  all — and until M4, src/api/mcp.ts called dispatchOp with NO rate limiter (apiLimiter was
 *  REST-only), which made the agent lane the one paid surface with no meter on it. The budget now
 *  sits at dispatchOp rung 0 (D94) and that hole is closed, but the coverage is exactly what must not
 *  disappear: this is still the last suite that should be allowed to go quiet. */
const REQUIRED_LIVE_SUITES = [
  'answer',
  'api',
  // M8's storage substrate (locks, checkpoints, budget ledger, failure ledger) and the
  // kill-9/resume exit criterion — see test/cycle.live.test.ts and test/cycle-kill9.live.test.ts.
  'cycle',
  'cycle-kill9',
  'hybrid',
  'ingest',
  // The batch page ops (delete_page's pageIds arm, rescope_pages). Registered deliberately rather
  // than incidentally: these are the only ops that mutate ACLs after ingest, and leak-canary.test.ts
  // allowlists rescope_pages on the strength of this suite existing — so letting it go quiet would
  // hollow out the canary's exemption as well as its own coverage.
  'lifecycle-batch',
  // The three below are M3-era and were added when this list merged into master. The reverse check
  // at the bottom of this test is what caught their absence — the list was written against a tree
  // where they did not exist yet, and would otherwise have quietly pinned 9 of 12.
  'ingest-file',
  // ingest_files, the batch form. leak-canary.test.ts's allowlist entry for ingest_files points here
  // for its positive control, same as lifecycle-batch above does for rescope_pages — letting this go
  // quiet would hollow out that exemption too.
  'ingest-files',
  'invites',
  'leak-canary',
  'lifecycle',
  // M9's links table: RLS cross-tenant isolation, the from_acl/to_acl conjunction, backlinks
  // populating on ingest, and the link_extraction cycle phase — see test/links.live.test.ts.
  'links',
  'm2-auth',
  'mcp',
  'rls-smoke',
  'scope-acl',
] as const;

/** The perf suites that must EXIST, keyed by the name each one passes to perfOrFail() (D93).
 *
 *  A SEPARATE list from REQUIRED_LIVE_SUITES for a mechanical reason, not a stylistic one: that
 *  list's collector is /liveOrFail\(\s*'([^']+)'/g, which cannot match perfOrFail('perf-recall'.
 *  Putting 'perf-recall' there would make its forward check fail permanently — the list would be
 *  demanding a liveOrFail gate that, by design, will never exist. Same guarantee, own collector. */
const REQUIRED_PERF_SUITES = ['perf-recall'] as const;

test('every required live suite still declares a liveOrFail gate', () => {
  const found = new Set<string>();
  for (const name of readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.ts'))) {
    if (name === 'live-gate.test.ts') continue; // its own liveOrFail('probe') calls are fixtures, not suites
    const src = readFileSync(join(TEST_DIR, name), 'utf8');
    // Matches both the one-line form and the wrapped `liveOrFail(\n  'name',` used where the
    // readiness expression is long enough to break the line (api, m2-auth).
    for (const m of src.matchAll(/liveOrFail\(\s*'([^']+)'/g)) found.add(m[1]!);
  }

  const missing = REQUIRED_LIVE_SUITES.filter((s) => !found.has(s));
  expect(
    missing,
    `these live suites no longer declare a liveOrFail() gate anywhere in test/: ${missing.join(', ')}. ` +
      `Either the suite was deleted — restore it, or remove it from REQUIRED_LIVE_SUITES deliberately — ` +
      `or its gate name changed and this list needs updating.`,
  ).toEqual([]);

  // The other direction, so the list cannot rot into a historical artifact. Without this, suite #11
  // is registered by nobody and inherits exactly the deletion hole this test was written to close —
  // the same "written six months from now" failure the scan above is guarding against.
  const unregistered = [...found].filter((s) => !(REQUIRED_LIVE_SUITES as readonly string[]).includes(s));
  expect(
    unregistered,
    `these suites call liveOrFail() but are not in REQUIRED_LIVE_SUITES: ${unregistered.join(', ')}. ` +
      `Add them, so that deleting one later fails this test instead of silently reducing coverage.`,
  ).toEqual([]);
});

test('every required perf suite still declares a perfOrFail gate', () => {
  const found = new Set<string>();
  for (const name of readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.ts'))) {
    if (name === 'live-gate.test.ts') continue; // this file's own perfOrFail('probe') calls are fixtures
    const src = readFileSync(join(TEST_DIR, name), 'utf8');
    for (const m of src.matchAll(/perfOrFail\(\s*'([^']+)'/g)) found.add(m[1]!);
  }

  const missing = REQUIRED_PERF_SUITES.filter((s) => !found.has(s));
  expect(
    missing,
    `these perf suites no longer declare a perfOrFail() gate anywhere in test/: ${missing.join(', ')}. ` +
      `Either the suite was deleted — restore it, or remove it from REQUIRED_PERF_SUITES deliberately ` +
      `— or its gate name changed and this list needs updating.`,
  ).toEqual([]);

  const unregistered = [...found].filter((s) => !(REQUIRED_PERF_SUITES as readonly string[]).includes(s));
  expect(
    unregistered,
    `these suites call perfOrFail() but are not in REQUIRED_PERF_SUITES: ${unregistered.join(', ')}. ` +
      `Add them, so deleting one later fails this test instead of silently reducing coverage.`,
  ).toEqual([]);
});

test('perfOrFail is independent of CB_REQUIRE_LIVE_TESTS — the whole point of the split', async () => {
  const { perfOrFail } = await import('./helpers/live.ts');
  const { config } = await import('../src/config.ts');
  const c = config as { CB_REQUIRE_LIVE_TESTS: number; CB_RUN_PERF_TESTS: number };
  const [origLive, origPerf] = [c.CB_REQUIRE_LIVE_TESTS, c.CB_RUN_PERF_TESTS];

  try {
    // THE assertion this test exists for. CI sets CB_REQUIRE_LIVE_TESTS=1; the perf suite must still
    // skip, silently, both when the environment is missing AND when it is fully ready. Nobody asked
    // for it, so running it would be the surprise and throwing would be worse. Reverse the two `if`s
    // inside perfOrFail and this is the line that goes red.
    c.CB_REQUIRE_LIVE_TESTS = 1;
    c.CB_RUN_PERF_TESTS = 0;
    expect(perfOrFail('probe', false)).toBe(false);
    expect(perfOrFail('probe', true)).toBe(false);

    // …and once it IS asked for, liveOrFail's no-silent-skip rule applies in full.
    c.CB_RUN_PERF_TESTS = 1;
    expect(perfOrFail('probe', true)).toBe(true);
    expect(() => perfOrFail('probe', false)).toThrow(/CB_RUN_PERF_TESTS=1/);

    // ANY non-zero value means "asked for". Under the original `!== 1` form, CB_RUN_PERF_TESTS=2
    // parsed cleanly to 2 and skipped the whole suite GREEN — the precise failure this gate exists to
    // forbid, reachable by a typo. Only 0 and 1 were ever exercised, so nothing caught it.
    c.CB_RUN_PERF_TESTS = 2;
    expect(perfOrFail('probe', true), 'a non-1 truthy value silently skipped the perf suite').toBe(true);
    expect(() => perfOrFail('probe', false)).toThrow(/CB_RUN_PERF_TESTS=1/);

    // Independent in the other direction too: the perf flag alone decides, with the live flag off.
    c.CB_REQUIRE_LIVE_TESTS = 0;
    expect(perfOrFail('probe', true)).toBe(true);
    expect(() => perfOrFail('probe', false)).toThrow(/CB_RUN_PERF_TESTS=1/);
  } finally {
    c.CB_REQUIRE_LIVE_TESTS = origLive;
    c.CB_RUN_PERF_TESTS = origPerf;
  }
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
