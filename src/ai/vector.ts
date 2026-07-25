// postgres.js has no bind-param type for pgvector, so every embedding travels as a TEXT LITERAL.
//
// How it reaches the column differs by call site, and the difference is deliberate:
//   * search (src/search/hybrid.ts) casts explicitly — `${literal}::vector` — because the value is
//     compared with `<=>` and Postgres needs the type before it can pick the operator.
//   * ingest (src/ingest/import.ts) does NOT cast: the batched multi-row INSERT lets postgres.js
//     bind it and the target column's own `vector(N)` type drives the coercion. Verified against the
//     database after the batching change — 20 rows, 0 nulls, 1536 dims, real values.
// Shared by both.
export function toVectorLiteral(vec: readonly number[]): string {
  for (const v of vec) {
    if (!Number.isFinite(v)) throw new Error('embedding contains a non-finite value');
  }
  return '[' + vec.join(',') + ']';
}
