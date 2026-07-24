// postgres.js has no bind-param type for pgvector — every embedding must be formatted as a text
// literal and cast ::vector in the SQL. Shared by ingest (write) and search (query).
export function toVectorLiteral(vec: readonly number[]): string {
  for (const v of vec) {
    if (!Number.isFinite(v)) throw new Error('embedding contains a non-finite value');
  }
  return '[' + vec.join(',') + ']';
}
