// The live-test gate.
//
// Every suite that needs a real database is `describe.skipIf(!live)`. Skipping is right on a laptop
// with no credentials — but it is exactly wrong in CI, where a missing connection string would make
// the entire cross-tenant canary report green while asserting nothing. `CB_REQUIRE_LIVE_TESTS=1`
// flips skip into failure.
//
// The M2 review found the flag had been declared in config.ts and documented in .env.example, and
// then read by nothing at all — so the guarantee it advertised did not exist. Route every live suite
// through this one function rather than re-deriving the rule per file; test/live-gate.test.ts
// enforces that mechanically, so a suite added later cannot quietly opt out.
import { config } from '../../src/config.ts';

/**
 * Returns whether the live suite `name` should run.
 *
 * @param ready whatever that suite needs in order to run (connection strings, feature flags…)
 * @throws when CB_REQUIRE_LIVE_TESTS=1 and `ready` is false — a security suite must never be
 *         silently absent from a run that claims to have executed it.
 */
export function liveOrFail(name: string, ready: boolean): boolean {
  if (ready) return true;
  if (config.CB_REQUIRE_LIVE_TESTS === 1) {
    throw new Error(
      `${name}: CB_REQUIRE_LIVE_TESTS=1 but the live environment is not configured, so this suite ` +
        `would have been SKIPPED. Refusing to report a pass for tests that did not run. ` +
        `Set DATABASE_URL, DATABASE_ADMIN_URL and DATABASE_AUTH_URL (and DEV_AUTH/DEV_LOGIN where ` +
        `the suite needs them), or unset CB_REQUIRE_LIVE_TESTS to allow skipping.`,
    );
  }
  return false;
}

/**
 * The same contract as `liveOrFail`, for the ONE suite that must not be gated by
 * `CB_REQUIRE_LIVE_TESTS`: test/perf-recall.test.ts (D93).
 *
 * Two axes, and the ORDER between them is the whole design:
 *
 *   1. Was the perf suite ASKED FOR? If `CB_RUN_PERF_TESTS` is not 1, skip — and skipping is honest
 *      here, because nobody requested it. `CB_REQUIRE_LIVE_TESTS` gets no say. That is the point of
 *      the split: test/leak-canary.test.ts:7 explains that the slow, timing-dependent properties
 *      live apart precisely so the flag CI sets — the flag the SACRED canary depends on — never has
 *      a reason to be turned off because a scale test flaked.
 *   2. It WAS asked for. Now liveOrFail's rule applies in full and a skip becomes a throw. An
 *      operator who typed CB_RUN_PERF_TESTS=1 and got a green skip has been told a lie, which is the
 *      same lie D43 exists to prevent.
 *
 * Checking (1) first is load-bearing, not stylistic: reverse the two and a CI run with
 * CB_REQUIRE_LIVE_TESTS=1 and no perf opt-in would start THROWING on a suite nobody requested.
 * test/live-gate.test.ts pins this ordering with a dedicated test.
 *
 * @param ready whatever the suite needs in order to run
 * @throws when CB_RUN_PERF_TESTS=1 and `ready` is false
 */
export function perfOrFail(name: string, ready: boolean): boolean {
  if (config.CB_RUN_PERF_TESTS !== 1) return false;
  if (ready) return true;
  throw new Error(
    `${name}: CB_RUN_PERF_TESTS=1 but the live environment is not configured, so this suite would ` +
      `have been SKIPPED. Refusing to report a pass for tests that did not run. Set DATABASE_URL ` +
      `and DATABASE_ADMIN_URL, or unset CB_RUN_PERF_TESTS to stop asking for the perf suite.`,
  );
}

/** The connection strings every live suite needs. */
export function hasDbEnv(): boolean {
  return !!process.env.DATABASE_URL && !!process.env.DATABASE_ADMIN_URL;
}
