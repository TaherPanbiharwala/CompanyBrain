// The facade every phase actually sees. Not a raw DB handle: a long phase must open MANY short
// withScopedTx transactions across its run (checkpointing between them), not one held-open
// transaction — holding one open for the whole phase would lose the checkpoint on a mid-run crash
// too, defeating the whole point of checkpointing.
import type postgres from 'postgres';
import { withScopedTx } from '../../db/client.ts';
import type { OperationContext } from '../context.ts';
import { BudgetMeter, type ActualUsage, type BudgetCheckResult, type SubmitEstimate } from './budget-meter.ts';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from './checkpoint.ts';
import { clearFailure, recordFailure } from './failure-ledger.ts';

export interface PhaseRunner {
  readonly ctx: OperationContext;
  readonly runId: string;
  readonly dryRun: boolean;

  /** Open one RLS-scoped transaction bound to ctx.workspaceId. Call this as many times as needed
   *  across a long walk — do NOT hold one transaction open for the whole phase. */
  withTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T>;

  /** Budget gate. Call before every LLM submit. Throws BudgetExhaustedError when denied. */
  checkBudget(estimate: SubmitEstimate): Promise<BudgetCheckResult>;

  /** Record actual usage after a call returns. May throw BudgetExhaustedError post-hoc. */
  recordSpend(actual: ActualUsage): Promise<void>;

  loadCheckpoint(fingerprint: string): Promise<string[]>;
  saveCheckpoint(fingerprint: string, completedKeys: string[]): Promise<void>;
  clearCheckpoint(fingerprint: string): Promise<void>;

  recordFailure(itemKey: string, error: unknown): Promise<{ attempts: number }>;
  clearFailure(itemKey: string): Promise<void>;
}

export function buildPhaseRunner(
  ctx: OperationContext,
  opts: { runId: string; dryRun: boolean; op: string; budgetUsd: number },
): PhaseRunner {
  const meter = new BudgetMeter(ctx, { workspaceId: ctx.workspaceId, op: opts.op, runId: opts.runId, budgetUsd: opts.budgetUsd });

  return {
    ctx,
    runId: opts.runId,
    dryRun: opts.dryRun,
    withTx: (fn) => withScopedTx(ctx, fn),
    checkBudget: (estimate) => meter.check(estimate),
    recordSpend: (actual) => meter.record(actual),
    loadCheckpoint: (fingerprint) => loadCheckpoint(ctx, { op: opts.op, fingerprint }),
    saveCheckpoint: (fingerprint, completedKeys) => saveCheckpoint(ctx, { op: opts.op, fingerprint }, completedKeys),
    clearCheckpoint: (fingerprint) => clearCheckpoint(ctx, { op: opts.op, fingerprint }),
    recordFailure: (itemKey, error) => recordFailure(ctx, { op: opts.op, itemKey, error }),
    clearFailure: (itemKey) => clearFailure(ctx, { op: opts.op, itemKey }),
  };
}
