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

/** The connection strings every live suite needs. */
export function hasDbEnv(): boolean {
  return !!process.env.DATABASE_URL && !!process.env.DATABASE_ADMIN_URL;
}
