// Live DB coverage of the M8 storage substrate: lock acquire/refresh/release, checkpoint
// round-trip, budget-ledger insert, and RLS cross-tenant isolation. The kill-9/resume exit
// criterion is a separate suite (test/cycle-kill9.live.test.ts) since it spawns a real subprocess.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { buildCycleContext, tryAcquireCycleLock, cycleLockKey } from '../src/core/cycle/lock.ts';
import { loadCheckpoint, saveCheckpoint, clearCheckpoint, fingerprintParams } from '../src/core/cycle/checkpoint.ts';
import { BudgetMeter, BudgetExhaustedError } from '../src/core/cycle/budget-meter.ts';
import { recordFailure, clearFailure, unresolvedFailures } from '../src/core/cycle/failure-ledger.ts';
import { writeIngestLog } from '../src/core/cycle/ingest-log.ts';
import { runCycle, registerPhase } from '../src/core/cycle.ts';
import { BaseCyclePhase } from '../src/core/cycle/base-phase.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('cycle', hasDbEnv());

describe.skipIf(!live)('cycle engine (M8) — live', () => {
  let ws1 = '';
  let ws2 = '';
  let p1 = '';

  beforeAll(async () => {
    const admin = adminSql();
    p1 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`cycle-${RUN}@ex.com`}, ${`cycle-${RUN}@ex.com`}) returning id`)[0]!.id;
    ws1 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'cycle-ws1'}, ${p1}) returning id`)[0]!.id;
    ws2 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'cycle-ws2'}, ${p1}) returning id`)[0]!.id;
  });

  afterAll(async () => {
    const admin = adminSql();
    await admin`delete from workspaces where id in (${ws1}, ${ws2})`;
    await admin`delete from principals where id in (${p1})`;
    await closePools({ timeout: 5 });
  });

  describe('cycle_locks', () => {
    it('acquires, refreshes and releases without error', async () => {
      const ctx = buildCycleContext(ws1);
      const handle = await tryAcquireCycleLock(ctx, { ttlMinutes: 30 });
      expect(handle).not.toBeNull();
      await handle!.refresh();
      await handle!.release();
    });

    it('a second acquire while the first is held returns null (busy)', async () => {
      const ctx = buildCycleContext(ws1);
      const first = await tryAcquireCycleLock(ctx, { ttlMinutes: 30 });
      expect(first).not.toBeNull();
      try {
        const second = await tryAcquireCycleLock(ctx, { ttlMinutes: 30 });
        expect(second).toBeNull();
      } finally {
        await first!.release();
      }
    });

    it('RLS: a lock acquired for one workspace is invisible/unstealable from another', async () => {
      const ctx1 = buildCycleContext(ws1);
      const ctx2 = buildCycleContext(ws2);
      const handle1 = await tryAcquireCycleLock(ctx1, { ttlMinutes: 30 });
      expect(handle1).not.toBeNull();
      try {
        // ws2's own lock key is different (cycle:<ws2>), so this must succeed independently —
        // proving ws1's lock does not block ws2, and that RLS scopes each workspace to its own row.
        const handle2 = await tryAcquireCycleLock(ctx2, { ttlMinutes: 30 });
        expect(handle2).not.toBeNull();
        await handle2!.release();

        // Confirm ws1's row is still exactly ws1's, unaffected by ws2's acquire (RLS-scoped read).
        const admin = adminSql();
        const rows = await admin<{ workspace_id: string }[]>`select workspace_id from cycle_locks where lock_key = ${cycleLockKey(ws1)}`;
        expect(rows[0]?.workspace_id).toBe(ws1);
      } finally {
        await handle1!.release();
      }
    });
  });

  describe('op_checkpoints', () => {
    it('round-trips: empty by default, saves, loads back, clears', async () => {
      const ctx = buildCycleContext(ws1);
      const fp = fingerprintParams({ test: RUN });
      expect(await loadCheckpoint(ctx, { op: 'test-op', fingerprint: fp })).toEqual([]);

      await saveCheckpoint(ctx, { op: 'test-op', fingerprint: fp }, ['a', 'b']);
      expect(await loadCheckpoint(ctx, { op: 'test-op', fingerprint: fp })).toEqual(['a', 'b']);

      await saveCheckpoint(ctx, { op: 'test-op', fingerprint: fp }, ['a', 'b', 'c']);
      expect(await loadCheckpoint(ctx, { op: 'test-op', fingerprint: fp })).toEqual(['a', 'b', 'c']);

      await clearCheckpoint(ctx, { op: 'test-op', fingerprint: fp });
      expect(await loadCheckpoint(ctx, { op: 'test-op', fingerprint: fp })).toEqual([]);
    });

    it('RLS: a checkpoint saved for one workspace is invisible from another', async () => {
      const ctx1 = buildCycleContext(ws1);
      const ctx2 = buildCycleContext(ws2);
      const fp = fingerprintParams({ shared: 'key' });
      await saveCheckpoint(ctx1, { op: 'iso-op', fingerprint: fp }, ['only-ws1']);
      expect(await loadCheckpoint(ctx2, { op: 'iso-op', fingerprint: fp })).toEqual([]);
      await clearCheckpoint(ctx1, { op: 'iso-op', fingerprint: fp });
    });
  });

  describe('cycle_budget_ledger', () => {
    it('check() commits a row and allows spend under the cap', async () => {
      const ctx = buildCycleContext(ws1);
      const meter = new BudgetMeter(ctx, { workspaceId: ws1, op: 'budget-test', runId: crypto.randomUUID(), budgetUsd: 1 });
      const result = await meter.check({ modelId: 'openai:text-embedding-3-small', estimatedInputTokens: 100, maxOutputTokens: 0, kind: 'embed' });
      expect(result.allowed).toBe(true);
      expect(result.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('check() throws BudgetExhaustedError and still commits the denied row when projected spend exceeds the cap', async () => {
      const ctx = buildCycleContext(ws1);
      const runId = crypto.randomUUID();
      // A tiny cap with a large estimate guarantees denial regardless of the placeholder rate used.
      const meter = new BudgetMeter(ctx, { workspaceId: ws1, op: 'budget-deny-test', runId, budgetUsd: 0.000001 });
      await expect(
        meter.check({ modelId: 'openai:text-embedding-3-small', estimatedInputTokens: 1_000_000, maxOutputTokens: 0, kind: 'embed' }),
      ).rejects.toThrow(BudgetExhaustedError);

      const admin = adminSql();
      const rows = await admin<{ allowed: boolean }[]>`select allowed from cycle_budget_ledger where run_id = ${runId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.allowed).toBe(false);
    });

    it('record() updates the ledger row with actual cost', async () => {
      const ctx = buildCycleContext(ws1);
      const runId = crypto.randomUUID();
      const meter = new BudgetMeter(ctx, { workspaceId: ws1, op: 'budget-record-test', runId, budgetUsd: 1 });
      await meter.check({ modelId: 'openai:text-embedding-3-small', estimatedInputTokens: 100, maxOutputTokens: 0, kind: 'embed' });
      await meter.record({ modelId: 'openai:text-embedding-3-small', inputTokens: 90, kind: 'embed' });

      const admin = adminSql();
      const rows = await admin<{ actual_cost_usd: string | null }[]>`select actual_cost_usd from cycle_budget_ledger where run_id = ${runId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actual_cost_usd).not.toBeNull();
    });

    // Regression test for the M8 review's finding: check()'s "prior spent" sum used to count only
    // actual_cost_usd (NULL until record() runs), so two check() calls in a row with no record() in
    // between could each independently pass even though their combined estimate exceeded the cap.
    // Fixed by coalescing to estimated_cost_usd for still-pending rows.
    it('two check() calls in the same run without an intervening record() still cap combined spend', async () => {
      const ctx = buildCycleContext(ws1);
      const runId = crypto.randomUUID();
      // Each individual estimate (100 tokens @ $0.02/1M ≈ $0.000002) fits well under a $0.000003 cap,
      // but two of them together should not.
      const meter = new BudgetMeter(ctx, { workspaceId: ws1, op: 'budget-cumulative-test', runId, budgetUsd: 0.000003 });
      const first = await meter.check({ modelId: 'openai:text-embedding-3-small', estimatedInputTokens: 100, maxOutputTokens: 0, kind: 'embed' });
      expect(first.allowed).toBe(true);
      await expect(
        meter.check({ modelId: 'openai:text-embedding-3-small', estimatedInputTokens: 100, maxOutputTokens: 0, kind: 'embed' }),
      ).rejects.toThrow(BudgetExhaustedError);
    });

    it('RLS: a budget ledger row written for one workspace is invisible from another', async () => {
      const ctx1 = buildCycleContext(ws1);
      const ctx2 = buildCycleContext(ws2);
      const runId = crypto.randomUUID();
      const meter1 = new BudgetMeter(ctx1, { workspaceId: ws1, op: 'budget-rls-test', runId, budgetUsd: 1 });
      await meter1.check({ modelId: 'openai:text-embedding-3-small', estimatedInputTokens: 10, maxOutputTokens: 0, kind: 'embed' });

      // Same run_id, but scoped to ws2 — the row belongs to ws1 and must not be visible.
      const meter2 = new BudgetMeter(ctx2, { workspaceId: ws2, op: 'budget-rls-test', runId, budgetUsd: 1 });
      const result2 = await meter2.check({ modelId: 'openai:text-embedding-3-small', estimatedInputTokens: 10, maxOutputTokens: 0, kind: 'embed' });
      // If ws1's row leaked into ws2's view, cumulativeCostUsd would reflect both rows' spend.
      expect(result2.cumulativeCostUsd).toBeCloseTo(result2.estimatedCostUsd, 10);

      const admin = adminSql();
      const rows = await admin<{ workspace_id: string }[]>`select workspace_id from cycle_budget_ledger where run_id = ${runId} order by id`;
      expect(rows.map((r) => r.workspace_id)).toEqual([ws1, ws2]);
    });
  });

  describe('cycle_failures', () => {
    it('records, increments attempts on repeat, and clears', async () => {
      const ctx = buildCycleContext(ws1);
      const op = `fail-test-${RUN}`;
      const first = await recordFailure(ctx, { op, itemKey: 'item-1', error: new Error('boom') });
      expect(first.attempts).toBe(1);
      const second = await recordFailure(ctx, { op, itemKey: 'item-1', error: new Error('boom again') });
      expect(second.attempts).toBe(2);

      const open = await unresolvedFailures(ctx, { op });
      expect(open.some((f) => f.itemKey === 'item-1' && f.attempts === 2)).toBe(true);

      await clearFailure(ctx, { op, itemKey: 'item-1' });
      const afterClear = await unresolvedFailures(ctx, { op });
      expect(afterClear.some((f) => f.itemKey === 'item-1')).toBe(false);
    });

    it('RLS: a failure recorded for one workspace is invisible from another', async () => {
      const ctx1 = buildCycleContext(ws1);
      const ctx2 = buildCycleContext(ws2);
      const op = `fail-rls-test-${RUN}`;
      await recordFailure(ctx1, { op, itemKey: 'ws1-only-item', error: new Error('boom') });

      const seenFromWs2 = await unresolvedFailures(ctx2, { op });
      expect(seenFromWs2.some((f) => f.itemKey === 'ws1-only-item')).toBe(false);

      const seenFromWs1 = await unresolvedFailures(ctx1, { op });
      expect(seenFromWs1.some((f) => f.itemKey === 'ws1-only-item')).toBe(true);

      await clearFailure(ctx1, { op, itemKey: 'ws1-only-item' });
    });
  });

  describe('ingest_log', () => {
    it('writes a row', async () => {
      const ctx = buildCycleContext(ws1);
      const runId = crypto.randomUUID();
      await writeIngestLog(ctx, {
        runId, op: 'ingest-log-test', status: 'ok', summary: 'test', details: {}, durationMs: 1, startedAt: new Date(),
      });
      const admin = adminSql();
      const rows = await admin<{ status: string }[]>`select status from ingest_log where run_id = ${runId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('ok');
    });
  });

  describe('runCycle — the noop phase end to end', () => {
    it('runs the noop phase, checkpoints, clears the checkpoint on success, and reports ok', async () => {
      const report = await runCycle({ workspaceId: ws1, phases: ['noop'] });
      expect(report.status).toBe('ok');
      expect(report.phases).toHaveLength(1);
      expect(report.phases[0]?.phase).toBe('noop');
      expect(report.phases[0]?.status).toBe('ok');

      // Checkpoint was cleared on success — nothing left to resume from.
      const admin = adminSql();
      const rows = await admin<{ n: number }[]>`select count(*)::int as n from op_checkpoints where workspace_id = ${ws1} and op = 'noop'`;
      expect(rows[0]?.n).toBe(0);
    });

    it('a concurrent run for the same workspace is skipped, not queued or errored', async () => {
      const ctx = buildCycleContext(ws1);
      const handle = await tryAcquireCycleLock(ctx, { ttlMinutes: 30 });
      expect(handle).not.toBeNull();
      try {
        const report = await runCycle({ workspaceId: ws1, phases: ['noop'] });
        expect(report.status).toBe('skipped');
        expect(report.reason).toBe('cycle_already_running');
        expect(report.phases).toEqual([]);
      } finally {
        await handle!.release();
      }
    });

    it('rejects an unregistered phase name before acquiring anything', async () => {
      await expect(runCycle({ workspaceId: ws1, phases: ['does-not-exist'] })).rejects.toThrow(/unknown cycle phase/);
    });
  });

  // Every other test in this file only ever runs the noop phase, which always reports 'ok' — so
  // runCycle's own ok/partial/failed classification (src/core/cycle.ts) has never been exercised
  // against a phase that actually fails or warns. Register throwaway stub phases to close that gap.
  describe('runCycle — status aggregation across phase outcomes', () => {
    class AlwaysOkPhase extends BaseCyclePhase {
      readonly name = 'test-always-ok';
      protected readonly budgetUsdDefault = 0.01;
      protected async process() {
        return { summary: 'ok', details: {} };
      }
    }
    class AlwaysWarnPhase extends BaseCyclePhase {
      readonly name = 'test-always-warn';
      protected readonly budgetUsdDefault = 0.01;
      protected async process() {
        return { summary: 'warn', details: {}, status: 'warn' as const };
      }
    }
    class AlwaysFailPhase extends BaseCyclePhase {
      readonly name = 'test-always-fail';
      protected readonly budgetUsdDefault = 0.01;
      protected async process(): Promise<never> {
        throw new Error('deliberate test failure');
      }
    }

    registerPhase('test-always-ok', () => new AlwaysOkPhase());
    registerPhase('test-always-warn', () => new AlwaysWarnPhase());
    registerPhase('test-always-fail', () => new AlwaysFailPhase());

    it('all phases ok -> report status ok', async () => {
      const report = await runCycle({ workspaceId: ws1, phases: ['test-always-ok'] });
      expect(report.status).toBe('ok');
    });

    it('a mix of ok and fail -> report status partial', async () => {
      const report = await runCycle({ workspaceId: ws1, phases: ['test-always-ok', 'test-always-fail'] });
      expect(report.status).toBe('partial');
      expect(report.phases.map((p) => p.status)).toEqual(['ok', 'fail']);
    });

    it('a mix of ok and warn -> report status partial', async () => {
      const report = await runCycle({ workspaceId: ws1, phases: ['test-always-ok', 'test-always-warn'] });
      expect(report.status).toBe('partial');
    });

    it('every phase fails -> report status failed', async () => {
      const report = await runCycle({ workspaceId: ws1, phases: ['test-always-fail'] });
      expect(report.status).toBe('failed');
    });
  });
});
