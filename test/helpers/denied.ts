// Assert WHY a statement was refused, not merely that something threw.
//
// Lifted out of test/m2-auth.test.ts, where it was written for the grant matrix and then needed
// again by the leak canary. A bare `try { … } catch { denied = true }` passes for a typo'd table
// name, a closed pool, or a statement timeout — so a test standing in for the tenancy boundary can
// go green for entirely the wrong reason. Returning the SQLSTATE lets the caller name the control
// that actually stopped the statement: 42501 is insufficient_privilege (a GRANT), 42P01 is
// undefined_table (a typo), 23505 is unique_violation.
//
// A row hidden by RLS does NOT appear here at all — a policy filters rows, it does not raise. That
// distinction is the point: `expect(rows.length).toBe(0)` is the RLS assertion, `deniedCode` is the
// privilege assertion, and confusing the two is how a canary proves the wrong property.

/** Run `fn`; return its Postgres SQLSTATE if it was refused, or `undefined` if it SUCCEEDED. */
export async function deniedCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
}
