// cycle_budget_ledger (migration 0020) — the transactional spend ledger docs/plan.md's
// Invariant 6 requires ("Spend caps (M8) fail closed; the ledger write is transactional —
// gbrain's fails open"). This is the repo's first real LLM usage/cost ledger; DECISIONS.md D104
// settled that spend accounting lives at M8, and D111 records why this diverges from gbrain's
// budget-meter.ts (best-effort JSONL, budget<=0 disables the gate — open by default).
//
// No disable path here: every phase declares a positive budgetUsdDefault (enforced by
// BaseCyclePhase), and check()/record() always write a committed row, win or deny.
import type postgres from 'postgres';
import { withScopedTx } from '../../db/client.ts';
import type { OperationContext } from '../context.ts';

type Tx = postgres.TransactionSql;

export type SpendKind = 'chat' | 'embed' | 'rerank';

export interface SubmitEstimate {
  modelId: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  kind: SpendKind;
  label?: string;
}

export interface ActualUsage {
  modelId: string;
  inputTokens: number;
  outputTokens?: number;
  kind: SpendKind;
}

export interface BudgetCheckResult {
  allowed: boolean;
  estimatedCostUsd: number;
  cumulativeCostUsd: number;
  budgetUsd: number;
}

export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    readonly spentUsd: number,
    readonly budgetUsd: number,
    readonly modelId?: string,
  ) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * PLACEHOLDER RATES, USD per 1M tokens — not yet verified against a live provider response (see
 * plan's flagged assumption). The no-op phase's own default budget ($0.01) and zero-token estimate
 * never actually exercise real spend through this path, so verifying is not blocking M8's exit
 * criteria — only a real M9+ phase's cap. Verify against OpenRouter's / OpenAI's current pricing
 * pages before trusting this for anything beyond noop. Keyed by the exact model id chat()/embed()
 * pass (config.CHAT_MODEL / config.EMBEDDING_MODEL, D12.1 / D13) — review this map whenever either
 * changes.
 */
const PLACEHOLDER_PRICING_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  'openrouter:deepseek/deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'openai:text-embedding-3-small': { input: 0.02, output: 0 },
  // The no-op phase's own sentinel model id — always 0 tokens, but still needs an entry or every
  // checkBudget() call throws UnknownModelPricingError before the multiplication (which would be
  // 0 either way) ever runs. Caught by the M8 review's adversarial pass: this was missing and made
  // the no-op phase fail on tick 1 of every single run.
  noop: { input: 0, output: 0 },
};

export class UnknownModelPricingError extends Error {
  constructor(readonly modelId: string) {
    super(`no pricing entry for model "${modelId}" — add one to PLACEHOLDER_PRICING_USD_PER_MILLION in budget-meter.ts before running a cycle phase against it`);
    this.name = 'UnknownModelPricingError';
  }
}

/** Shared by trusted evaluation preflight and the transactional ledger. Keeping the arithmetic in
 * one exported function means a campaign's "would exceed" estimate cannot drift from the check()
 * that gates the provider call. */
export function estimateModelCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const rate = PLACEHOLDER_PRICING_USD_PER_MILLION[modelId];
  if (!rate) throw new UnknownModelPricingError(modelId);
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export interface BudgetMeterOpts {
  workspaceId: string;
  op: string;
  runId: string;
  budgetUsd: number;
}

export class BudgetMeter {
  constructor(
    private readonly ctx: OperationContext,
    private readonly opts: BudgetMeterOpts,
  ) {
    if (!(opts.budgetUsd > 0)) {
      throw new Error(`BudgetMeter requires a positive budgetUsd, got ${opts.budgetUsd} — spend caps fail closed (docs/plan.md Invariant 6), there is no "disabled" value`);
    }
  }

  /** coalesce(actual_cost_usd, estimated_cost_usd): a row a prior check() inserted but no record()
   *  has resolved yet still has actual_cost_usd NULL — summing actual_cost_usd alone would ignore
   *  that pending spend, letting several checkBudget() calls in a row each pass independently even
   *  though their combined estimates exceed the cap. `allowed=true` excludes denied attempts, which
   *  never actually spent anything. Shared by check() and record() so the two can't drift apart. */
  private async sumSpent(tx: Tx): Promise<number> {
    const { workspaceId, op, runId } = this.opts;
    const [row] = await tx<{ spent: string | null }[]>`
      select sum(coalesce(actual_cost_usd, estimated_cost_usd)) as spent from cycle_budget_ledger
      where workspace_id = ${workspaceId} and op = ${op} and run_id = ${runId} and allowed = true`;
    return Number(row?.spent ?? 0);
  }

  /** Insert a provisional ledger row BEFORE the provider call. Computes cumulative spend as
   *  SUM(actual_cost_usd) for (workspace, op, run_id) in the same statement, so the check and the
   *  audit row land atomically — no separate read-then-decide race. Throws BudgetExhaustedError
   *  when the projected total would exceed the cap; the denied attempt is still committed as an
   *  `allowed:false` row, not silently dropped. */
  async check(estimate: SubmitEstimate): Promise<BudgetCheckResult> {
    const estimatedCostUsd = estimateModelCostUsd(estimate.modelId, estimate.estimatedInputTokens, estimate.maxOutputTokens);
    const { budgetUsd, workspaceId, op, runId } = this.opts;

    // The BudgetExhaustedError throw MUST happen after this transaction has committed, not inside
    // the withScopedTx callback — throwing from inside `.begin(fn)` rolls the transaction back
    // (postgres.js, and every SQL driver, does this unconditionally on a rejected callback), which
    // would silently discard the very `allowed:false` audit row this function exists to preserve.
    // Caught by the M8 review's adversarial pass.
    const result = await withScopedTx(this.ctx, async (tx) => {
      const priorSpent = await this.sumSpent(tx);
      const projected = priorSpent + estimatedCostUsd;
      const allowed = projected <= budgetUsd;

      await tx`
        insert into cycle_budget_ledger
          (workspace_id, op, run_id, model_id, kind, estimated_cost_usd, cumulative_cost_usd, budget_usd, allowed)
        values (${workspaceId}, ${op}, ${runId}, ${estimate.modelId}, ${estimate.kind},
                ${estimatedCostUsd}, ${projected}, ${budgetUsd}, ${allowed})`;

      return { allowed, estimatedCostUsd, cumulativeCostUsd: projected, budgetUsd };
    });

    if (!result.allowed) {
      throw new BudgetExhaustedError(
        `budget exceeded for op=${op}: projected $${result.cumulativeCostUsd.toFixed(4)} > cap $${budgetUsd.toFixed(4)}`,
        result.cumulativeCostUsd,
        budgetUsd,
        estimate.modelId,
      );
    }
    return result;
  }

  /** Update the most recent matching row with actual usage, once the provider call returns. May
   *  throw BudgetExhaustedError post-hoc if the actual usage (underestimated by the caller) blew
   *  the cap — mirrors gbrain's TX1 (an underestimated call can still exceed the ceiling after the
   *  fact). */
  async record(actual: ActualUsage): Promise<void> {
    const actualCostUsd = estimateModelCostUsd(actual.modelId, actual.inputTokens, actual.outputTokens ?? 0);
    const { budgetUsd, workspaceId, op, runId } = this.opts;

    // Same reasoning as check(): the post-hoc overspend throw happens AFTER this transaction
    // commits, not inside it — the actual_cost_usd this write is recording is money already spent
    // with the provider, and rolling it back would make it vanish from every future sum() in this
    // run, silently undercounting real spend on the exact call that tripped the cap.
    const spent = await withScopedTx(this.ctx, async (tx) => {
      const [row] = await tx<{ id: number }[]>`
        select id from cycle_budget_ledger
        where workspace_id = ${workspaceId} and op = ${op} and run_id = ${runId}
          and model_id = ${actual.modelId} and actual_cost_usd is null
        order by id desc limit 1`;
      if (!row) {
        // No matching provisional row (record() called without a preceding check()) — still write
        // an audit row rather than silently dropping the spend.
        await tx`
          insert into cycle_budget_ledger
            (workspace_id, op, run_id, model_id, kind, estimated_cost_usd, actual_cost_usd, cumulative_cost_usd, budget_usd, allowed)
          values (${workspaceId}, ${op}, ${runId}, ${actual.modelId}, ${actual.kind},
                  ${actualCostUsd}, ${actualCostUsd}, ${actualCostUsd}, ${budgetUsd}, true)`;
      } else {
        await tx`update cycle_budget_ledger set actual_cost_usd = ${actualCostUsd} where id = ${row.id}`;
      }

      return this.sumSpent(tx);
    });

    if (spent > budgetUsd) {
      throw new BudgetExhaustedError(
        `actual spend exceeded budget for op=${op}: $${spent.toFixed(4)} > cap $${budgetUsd.toFixed(4)}`,
        spent,
        budgetUsd,
        actual.modelId,
      );
    }
  }
}
