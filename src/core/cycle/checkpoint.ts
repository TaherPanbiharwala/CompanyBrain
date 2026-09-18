// op_checkpoints (migration 0020) — resume state for a long-running phase. Ported from gbrain's
// op-checkpoint.ts contract, minus its op_checkpoint_paths delta table (that exists only to avoid
// an O(N²) rewrite on ~200K-row checkpoints, premature for M8; revisit once a real M9+ phase's
// checkpoint set is large enough to need it).
import { createHash } from 'node:crypto';
import { withScopedTx } from '../../db/client.ts';
import type { OperationContext } from '../context.ts';

export interface CheckpointKey {
  workspaceId: string;
  op: string;
  fingerprint: string;
}

/** Deep-sorts object keys so key order never changes the hash — same recipe as
 * src/search/retrieval-knobs.ts's canonicalize(). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** sha256(canonical JSON) of a phase's resume-relevant params, truncated to 8 bytes (16 hex chars)
 *  — enough to make an unrelated param change start a fresh checkpoint instead of silently reusing
 *  a stale one, without the full 64-char hash being pasted into logs. */
export function fingerprintParams(params: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(params))).digest('hex').slice(0, 16);
}

export async function loadCheckpoint(ctx: OperationContext, key: Omit<CheckpointKey, 'workspaceId'>): Promise<string[]> {
  return withScopedTx(ctx, async (tx) => {
    const rows = await tx<{ completed_keys: string[] }[]>`
      select completed_keys from op_checkpoints
      where workspace_id = ${ctx.workspaceId} and op = ${key.op} and fingerprint = ${key.fingerprint}`;
    return rows[0]?.completed_keys ?? [];
  });
}

/** Rewrites the WHOLE completed_keys array on every call — gbrain's own op-checkpoint.ts documents
 *  the caller's contract as choosing a save cadence (e.g. every 100 items), not calling this per
 *  item. The reference `noop` phase saves every tick because it only ever has 3, but a real M9+
 *  phase walking thousands of items should batch its saveCheckpoint() calls, or this becomes the
 *  same O(N) full-array-rewrite-per-item cost the deferred op_checkpoint_paths table exists to
 *  avoid — just triggered by call frequency instead of array size. */
export async function saveCheckpoint(
  ctx: OperationContext,
  key: Omit<CheckpointKey, 'workspaceId'>,
  completedKeys: string[],
): Promise<void> {
  // Pass the array directly, NOT JSON.stringify(completedKeys) — postgres.js infers a jsonb
  // parameter from the `::jsonb` cast and JSON-encodes whatever JS value it's given for that slot.
  // Pre-stringifying double-encodes: the column ends up holding a jsonb STRING whose content is the
  // array's JSON text, not a jsonb ARRAY — which is exactly what op_checkpoints_completed_keys_array
  // (migration 0020) is designed to catch, and did, against a live database, during the M8 review.
  await withScopedTx(ctx, (tx) => tx`
    insert into op_checkpoints (workspace_id, op, fingerprint, completed_keys, updated_at)
    values (${ctx.workspaceId}, ${key.op}, ${key.fingerprint}, ${completedKeys}::jsonb, now())
    on conflict (workspace_id, op, fingerprint) do update
      set completed_keys = excluded.completed_keys, updated_at = now()`);
}

/** Called on a successful, fully-completed run — clears the checkpoint so the next run starts
 *  fresh instead of finding an (empty-to-walk) exhausted completed-keys set. */
export async function clearCheckpoint(ctx: OperationContext, key: Omit<CheckpointKey, 'workspaceId'>): Promise<void> {
  await withScopedTx(ctx, (tx) => tx`
    delete from op_checkpoints
    where workspace_id = ${ctx.workspaceId} and op = ${key.op} and fingerprint = ${key.fingerprint}`);
}
