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

/** Does this suite touch the database?
 *
 *  THREE signals, not one. The first version of this test looked only for a literal
 *  `process.env.DATABASE_*` in the file — and every live suite reads those through `hasDbEnv()`
 *  instead, so the scan matched exactly ONE of the ten and the other nine were invisible. The guard
 *  written to stop a suite silently opting out could not see the suites it was guarding.
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
  const inspected: string[] = [];

  for (const name of readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.ts'))) {
    const src = readFileSync(join(TEST_DIR, name), 'utf8');
    if (!touchesDb(src)) continue;
    inspected.push(name);

    // …and it must derive its gate from the shared helper, not from a hand-rolled boolean.
    if (!src.includes('liveOrFail')) offenders.push(name);
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

  expect(
    offenders,
    `these suites touch the database but do not use liveOrFail(), so they will SKIP ` +
      `instead of FAIL under CB_REQUIRE_LIVE_TESTS=1: ${offenders.join(', ')}`,
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
