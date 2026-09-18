// ingest_log (migration 0020) — ordinary per-phase-run audit history. One row per run, win or
// lose. Contrast cycle_failures (failure-ledger.ts), which is specifically for retry/alerting on
// one failing item within a run.
import type postgres from 'postgres';
import { withScopedTx } from '../../db/client.ts';
import type { OperationContext } from '../context.ts';
import type { PhaseStatus } from './types.ts';

export interface IngestLogEntry {
  runId: string;
  op: string;
  status: PhaseStatus;
  summary: string;
  details: Record<string, unknown>;
  durationMs: number;
  startedAt: Date;
}

export async function writeIngestLog(ctx: OperationContext, entry: IngestLogEntry): Promise<void> {
  // sql.json(), not JSON.stringify(entry.details) — see checkpoint.ts's saveCheckpoint for why:
  // postgres.js JSON-encodes whatever value it's given for a jsonb slot, so a pre-stringified value
  // gets encoded a second time into a jsonb string rather than a jsonb object. sql.json() is the
  // properly-typed way to pass an arbitrary object (an array, like completed_keys, types directly).
  await withScopedTx(ctx, (tx) => tx`
    insert into ingest_log (workspace_id, run_id, op, status, summary, details, duration_ms, started_at)
    values (${ctx.workspaceId}, ${entry.runId}, ${entry.op}, ${entry.status}, ${entry.summary},
            ${tx.json(entry.details as postgres.JSONValue)}, ${entry.durationMs}, ${entry.startedAt})`);
}
