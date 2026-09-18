// cycle_failures (migration 0020) — the failure ledger, specifically for retry/alerting on one
// failing item within a phase run. Ported (simplified) from gbrain's file-based
// sync-failure-ledger.ts; dropping its git-sync-specific auto_skipped state and sentinel hard-block
// (ingestion-gate policy that doesn't exist as a concept here yet — see DECISIONS.md D111).
import { withScopedTx } from '../../db/client.ts';
import type { OperationContext } from '../context.ts';

export interface CycleFailureRow {
  op: string;
  itemKey: string;
  errorCode: string;
  errorMessage: string;
  attempts: number;
  state: 'open' | 'acknowledged';
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function errorCodeAndMessage(error: unknown): { code: string; message: string } {
  if (error instanceof Error) return { code: error.name || 'Error', message: error.message };
  return { code: 'UNKNOWN', message: String(error) };
}

/** Record (or bump) a failure for one item. attempts increments on every call for the same
 *  (op, item_key) while it stays open; a fresh failure after clearFailure() resolved it starts
 *  back at 1. */
export async function recordFailure(
  ctx: OperationContext,
  args: { op: string; itemKey: string; error: unknown },
): Promise<{ attempts: number }> {
  const { code, message } = errorCodeAndMessage(args.error);
  return withScopedTx(ctx, async (tx) => {
    const rows = await tx<{ attempts: number }[]>`
      insert into cycle_failures (workspace_id, op, item_key, error_code, error_message, attempts, state, first_seen_at, last_seen_at)
      values (${ctx.workspaceId}, ${args.op}, ${args.itemKey}, ${code}, ${message}, 1, 'open', now(), now())
      on conflict (workspace_id, op, item_key) do update
        set error_code = excluded.error_code, error_message = excluded.error_message,
            attempts = case when cycle_failures.state = 'open' then cycle_failures.attempts + 1 else 1 end,
            state = 'open', last_seen_at = now(), resolved_at = null
      returning attempts`;
    return { attempts: rows[0]?.attempts ?? 1 };
  });
}

/** Called when an item that previously failed now succeeds — removes it from the ledger entirely
 *  rather than leaving a resolved row, so a future failure starts a clean attempt count. */
export async function clearFailure(ctx: OperationContext, args: { op: string; itemKey: string }): Promise<void> {
  await withScopedTx(ctx, (tx) => tx`
    delete from cycle_failures where workspace_id = ${ctx.workspaceId} and op = ${args.op} and item_key = ${args.itemKey}`);
}

export async function acknowledgeFailures(ctx: OperationContext, args: { op?: string } = {}): Promise<{ count: number }> {
  return withScopedTx(ctx, async (tx) => {
    const rows = args.op
      ? await tx<{ id: number }[]>`
          update cycle_failures set state = 'acknowledged', resolved_at = now()
          where workspace_id = ${ctx.workspaceId} and op = ${args.op} and state = 'open' returning id`
      : await tx<{ id: number }[]>`
          update cycle_failures set state = 'acknowledged', resolved_at = now()
          where workspace_id = ${ctx.workspaceId} and state = 'open' returning id`;
    return { count: rows.length };
  });
}

interface RawFailureRow {
  op: string;
  item_key: string;
  error_code: string;
  error_message: string;
  attempts: number;
  state: 'open' | 'acknowledged';
  first_seen_at: Date;
  last_seen_at: Date;
}

export async function unresolvedFailures(ctx: OperationContext, args: { op?: string } = {}): Promise<CycleFailureRow[]> {
  return withScopedTx(ctx, async (tx) => {
    const rows = args.op
      ? await tx<RawFailureRow[]>`
          select op, item_key, error_code, error_message, attempts, state, first_seen_at, last_seen_at
          from cycle_failures where workspace_id = ${ctx.workspaceId} and op = ${args.op} and state = 'open'
          order by last_seen_at desc`
      : await tx<RawFailureRow[]>`
          select op, item_key, error_code, error_message, attempts, state, first_seen_at, last_seen_at
          from cycle_failures where workspace_id = ${ctx.workspaceId} and state = 'open'
          order by last_seen_at desc`;
    return rows.map((r) => ({
      op: r.op,
      itemKey: r.item_key,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      attempts: r.attempts,
      state: r.state,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    }));
  });
}
