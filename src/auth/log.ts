// Structured, shape-only auth logging.
//
// The /auth/* routes and the app-wide guards sit OUTSIDE mountApi, so they inherit none of the
// dispatch logger — without this, a failed login or a shed flood leaves no trace at all.
//
// Lives in its own module because it has three callers in two files (routes.ts, csrf.ts's two
// guards) and was previously a private function in routes.ts with the JSON re-inlined by hand in
// csrf.ts. Hand-copied log shapes drift, and a log line whose shape drifts is one a query misses.
//
// NEVER logs a token, a code, an email or a cookie value — `fields` is for shape only (booleans,
// codes, counts, paths).
export function logAuth(reqId: string, stage: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    level: 'info', kind: 'auth', ts: new Date().toISOString(), reqId, auth_stage: stage, ...fields,
  }));
}
