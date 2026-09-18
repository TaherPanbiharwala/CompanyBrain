// Workspace-scoped cycle lock (M8), backed by the `cycle_locks` table (migration 0020).
//
// Ported from gbrain's src/core/db-lock.ts (MIT), trimmed to what this repo actually needs: one
// Postgres engine (no PGLite branch), and one lock per workspace (lock_key = `cycle:<workspaceId>`)
// rather than gbrain's multi-namespace (`gbrain-cycle`, `gbrain-sync:<source>`, elections, …) table.
// Every operation here runs inside withScopedTx(ctx, …), so RLS (cycle_locks_ws) already confines
// every read/write to the caller's own workspace — there is no cross-tenant scan to guard against,
// unlike gbrain's reaper which sweeps a shared, unscoped table.
//
// Row-based, not pg_advisory_lock: appSql() runs behind Supabase's transaction pooler
// (src/db/client.ts, prepare: !isPooler), which drops session state between calls, so a
// session-scoped advisory lock would not reliably hold across the many short transactions one
// cycle run makes. See DECISIONS.md D111.
import { hostname } from 'node:os';
import type postgres from 'postgres';
import { withScopedTx } from '../../db/client.ts';
import { buildContext, wsGrant, type OperationContext } from '../context.ts';

type Tx = postgres.TransactionSql;

export const DEFAULT_LOCK_TTL_MINUTES = 30;

/** Grace window before a same-host dead-pid lock is eligible for automatic takeover. Defends
 *  against PID reuse: the OS can recycle a crashed holder's PID, so takeover waits until the lock
 *  row is older than this. Ported from gbrain's HOLDER_TAKEOVER_GRACE_MS. */
export const HOLDER_TAKEOVER_GRACE_MS = 60_000;

/** Refresh cadence: ~1/6th of the TTL window, floored at 15s. The single source both
 *  resolveStealGraceSeconds() and withRefreshingCycleLock()'s default heartbeat interval derive
 *  from, so the two can't silently drift apart (they used to be two independent formulas). */
export function refreshIntervalMs(ttlMinutes: number): number {
  return Math.max(15_000, (ttlMinutes * 60 * 1000) / 6);
}

/** A holder whose last_refreshed_at is within this window is treated as ALIVE and not stolen even
 *  if ttl_expires_at has lapsed — defends a live, actively-refreshing holder whose tick was briefly
 *  starved. Derived from the TTL so it scales with the refresh cadence, floored at 60s — which
 *  means, verified live during the M8 review's kill-9 test: a crashed holder is NOT reclaimable
 *  faster than this floor via the TTL path, no matter how short a TTL it was given. Same floor as
 *  HOLDER_TAKEOVER_GRACE_MS above, by design — both exist to defend against the same class of
 *  false-positive (a lock that only LOOKS dead). CB_CYCLE_LOCK_STEAL_GRACE_SECONDS overrides it —
 *  ported from gbrain's identical GBRAIN_LOCK_STEAL_GRACE_SECONDS escape hatch — for tests that need
 *  to exercise real reclaim without waiting out the floor for real. */
export function resolveStealGraceSeconds(ttlMinutes: number): number {
  const override = Number(process.env.CB_CYCLE_LOCK_STEAL_GRACE_SECONDS ?? '');
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(Math.floor((refreshIntervalMs(ttlMinutes) / 1000) * 2), 60);
}

export type HolderLiveness = 'cross_host' | 'alive' | 'too_young' | 'dead_eligible' | 'unknown';

export interface HolderLivenessOpts {
  graceMs?: number;
  localHost?: string;
  processKill?: (pid: number, signal: number) => void;
}

/** Pure liveness classification, ported near-verbatim from gbrain's classifyHolderLiveness so the
 *  same reasoning (EPERM-as-alive, ESRCH-with-grace, cross-host-never) applies here. */
export function classifyHolderLiveness(
  holderPid: number,
  holderHost: string,
  ageMs: number,
  opts: HolderLivenessOpts = {},
): HolderLiveness {
  const localHost = opts.localHost ?? hostname();
  if (holderHost !== localHost) return 'cross_host';

  const probe = opts.processKill ?? ((p: number, s: number) => process.kill(p, s));
  let probeResult: 'alive' | 'dead' | 'eperm' | 'unknown';
  try {
    probe(holderPid, 0);
    probeResult = 'alive';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    probeResult = code === 'ESRCH' ? 'dead' : code === 'EPERM' ? 'eperm' : 'unknown';
  }

  // EPERM: the PID exists but isn't ours. Treat as alive — stealing a live lock is the worst case.
  if (probeResult === 'alive' || probeResult === 'eperm') return 'alive';
  if (probeResult === 'unknown') return 'unknown';

  const grace = opts.graceMs ?? HOLDER_TAKEOVER_GRACE_MS;
  return ageMs < grace ? 'too_young' : 'dead_eligible';
}

export function isHolderDeadLocally(
  holderPid: number,
  holderHost: string,
  ageMs: number,
  opts: HolderLivenessOpts = {},
): boolean {
  return classifyHolderLiveness(holderPid, holderHost, ageMs, opts) === 'dead_eligible';
}

export function cycleLockKey(workspaceId: string): string {
  return `cycle:${workspaceId}`;
}

export interface CycleLockHandle {
  release(): Promise<void>;
  refresh(): Promise<void>;
}

export class CycleLockUnavailableError extends Error {
  constructor(readonly lockKey: string) {
    super(`cycle lock busy: ${lockKey}`);
    this.name = 'CycleLockUnavailableError';
  }
}

interface LockRow {
  lock_key: string;
  holder_pid: number;
  holder_host: string;
  acquired_at: Date;
  ttl_expires_at: Date;
  last_refreshed_at: Date;
}

async function readLockRow(tx: Tx, lockKey: string): Promise<LockRow | null> {
  const rows = await tx<LockRow[]>`
    select lock_key, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at
    from cycle_locks where lock_key = ${lockKey}`;
  return rows[0] ?? null;
}

/** Upsert-style acquire: INSERT, or UPDATE-in-place when the existing row's TTL has lapsed AND it
 *  is past the heartbeat steal grace. Empty result means a live holder still has it. */
async function upsertAcquire(
  tx: Tx,
  lockKey: string,
  workspaceId: string,
  ttlMinutes: number,
  stealGraceSeconds: number,
): Promise<boolean> {
  const ttl = `${ttlMinutes} minutes`;
  const rows = await tx<{ lock_key: string }[]>`
    insert into cycle_locks (lock_key, workspace_id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
    values (${lockKey}, ${workspaceId}, ${process.pid}, ${hostname()}, now(), now() + ${ttl}::interval, now())
    on conflict (lock_key) do update
      set holder_pid = ${process.pid}, holder_host = ${hostname()}, acquired_at = now(),
          ttl_expires_at = now() + ${ttl}::interval, last_refreshed_at = now()
      where cycle_locks.ttl_expires_at < now()
        and cycle_locks.last_refreshed_at < now() - ${stealGraceSeconds} * interval '1 second'
    returning lock_key`;
  return rows.length > 0;
}

/** Try to acquire the cycle lock for `ctx.workspaceId`. Returns null if a live holder has it.
 *  Reaps a same-host, provably-dead holder first (best-effort) so a crashed run recovers within
 *  seconds rather than waiting out the full TTL. */
export async function tryAcquireCycleLock(
  ctx: OperationContext,
  opts: { ttlMinutes?: number } = {},
): Promise<CycleLockHandle | null> {
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_LOCK_TTL_MINUTES;
  // Only scripts/run-cycle.ts validates --lock-ttl-minutes today; guard here too so a future
  // non-CLI caller (an admin API route, say) can't pass 0/negative and get an instantly-stealable
  // lock that defeats mutual exclusion the moment it's granted.
  if (!(ttlMinutes > 0)) throw new Error(`tryAcquireCycleLock: ttlMinutes must be positive, got ${ttlMinutes}`);
  const stealGraceSeconds = resolveStealGraceSeconds(ttlMinutes);
  const lockKey = cycleLockKey(ctx.workspaceId);

  const acquired = await withScopedTx(ctx, (tx) => upsertAcquire(tx, lockKey, ctx.workspaceId, ttlMinutes, stealGraceSeconds));
  if (acquired) return makeHandle(ctx, lockKey, ttlMinutes);

  // Busy per TTL/steal-grace. If the holder is same-host and provably dead (past the takeover
  // grace), reap it and retry once — best-effort; any error here just falls through to "busy".
  try {
    const reaped = await reapDeadCycleLocks(ctx);
    if (reaped.reaped > 0) {
      const second = await withScopedTx(ctx, (tx) => upsertAcquire(tx, lockKey, ctx.workspaceId, ttlMinutes, stealGraceSeconds));
      if (second) return makeHandle(ctx, lockKey, ttlMinutes);
    }
  } catch {
    // Auto-takeover is best-effort; never throw from the acquire path.
  }
  return null;
}

function makeHandle(ctx: OperationContext, lockKey: string, ttlMinutes: number): CycleLockHandle {
  return {
    refresh: async () => {
      const ttl = `${ttlMinutes} minutes`;
      await withScopedTx(ctx, (tx) => tx`
        update cycle_locks set ttl_expires_at = now() + ${ttl}::interval, last_refreshed_at = now()
        where lock_key = ${lockKey} and holder_pid = ${process.pid}`);
    },
    release: async () => {
      await withScopedTx(ctx, (tx) => tx`
        delete from cycle_locks where lock_key = ${lockKey} and holder_pid = ${process.pid}`);
    },
  };
}

/** Reap the workspace's own cycle-lock row if its holder is same-host and provably dead past the
 *  takeover grace. RLS already confines this to the caller's workspace, so — unlike gbrain's
 *  cross-tenant reaper — there is at most one row to consider. Snapshot-matched delete (lock_key +
 *  holder_pid + acquired_at) so a PID that was reused by a brand-new holder between the read and
 *  the delete cannot be reaped out from under it. */
export async function reapDeadCycleLocks(
  ctx: OperationContext,
  opts: HolderLivenessOpts = {},
): Promise<{ reaped: number; lockKey: string | null }> {
  const lockKey = cycleLockKey(ctx.workspaceId);
  const row = await withScopedTx(ctx, (tx) => readLockRow(tx, lockKey));
  if (!row) return { reaped: 0, lockKey: null };
  const ageMs = Date.now() - row.acquired_at.getTime();
  if (!isHolderDeadLocally(row.holder_pid, row.holder_host, ageMs, opts)) return { reaped: 0, lockKey: null };

  const deleted = await withScopedTx(ctx, (tx) => tx<{ lock_key: string }[]>`
    delete from cycle_locks
    where lock_key = ${lockKey} and holder_pid = ${row.holder_pid}
      and date_trunc('milliseconds', acquired_at) = ${row.acquired_at}
    returning lock_key`);
  return deleted.length > 0 ? { reaped: 1, lockKey } : { reaped: 0, lockKey: null };
}

export interface WithRefreshingCycleLockOpts {
  ttlMinutes?: number;
  /** How often to refresh, in ms. Default: ttl/6, matching the steal-grace derivation above. */
  heartbeatIntervalMs?: number;
}

/** Acquire the workspace's cycle lock, run `work`, always release. Auto-refreshes on a timer so a
 *  long phase run doesn't lose the lock to its own TTL. Throws CycleLockUnavailableError if busy —
 *  callers decide what "another cycle is already running" means for their CycleReport. */
export async function withRefreshingCycleLock<T>(
  ctx: OperationContext,
  work: () => Promise<T>,
  opts: WithRefreshingCycleLockOpts = {},
): Promise<T> {
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_LOCK_TTL_MINUTES;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? refreshIntervalMs(ttlMinutes);

  const handle = await tryAcquireCycleLock(ctx, { ttlMinutes });
  if (!handle) throw new CycleLockUnavailableError(cycleLockKey(ctx.workspaceId));

  const interval = setInterval(() => {
    void handle.refresh().catch((err) => {
      console.warn(`[cycle-lock] refresh failed for ${cycleLockKey(ctx.workspaceId)}; will retry next tick:`, err);
    });
  }, heartbeatIntervalMs);
  (interval as unknown as { unref?: () => void }).unref?.();

  try {
    return await work();
  } finally {
    clearInterval(interval);
    try {
      await handle.release();
    } catch {
      // Best-effort — the TTL is the backstop if release itself fails (e.g. connection already gone).
    }
  }
}

/** Build the synthetic system-principal context a cycle run authenticates as. None of the five M8
 *  tables have a principal/ACL dimension (workspace-equality RLS only), so this sentinel never
 *  appears in a predicate that matters — it exists only to satisfy OperationContext's non-null
 *  `principal` field and withScopedTx's GUC plumbing, keeping cycle work on the same least-privilege
 *  cb_app/RLS path as a real request rather than needing a new role. */
export const SYSTEM_PRINCIPAL = '00000000-0000-0000-0000-000000000000';

export function buildCycleContext(workspaceId: string): OperationContext {
  return buildContext({
    principal: SYSTEM_PRINCIPAL,
    workspaceId,
    grants: [wsGrant(workspaceId)],
    role: 'system',
    remote: false,
  });
}
