// The contract every cycle phase implements. Mirrors gbrain's BaseCyclePhase — the base class wraps
// process() with timing and a uniform try/catch → PhaseResult envelope so no phase has to
// reimplement that plumbing.
import { BudgetExhaustedError } from './budget-meter.ts';
import type { PhaseRunner } from './runner-context.ts';
import type { PhaseResult, PhaseRunOpts, PhaseStatus } from './types.ts';

export abstract class BaseCyclePhase {
  /** Matches the phase registry key in cycle.ts and the `op` column everywhere. */
  abstract readonly name: string;

  /** Hard default budget ceiling in USD for one run of this phase, for one workspace. No
   *  "0/unset = uncapped" escape hatch — docs/plan.md Invariant 6 requires spend caps to fail
   *  CLOSED, so every phase must declare a positive default (runCycle asserts this). */
  protected abstract readonly budgetUsdDefault: number;

  protected abstract process(
    runner: PhaseRunner,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }>;

  /** Override to map a phase-specific error to a stable machine code for ingest_log/observability.
   *  Default is deliberately coarse — most phases don't need to override this. */
  protected mapErrorCode(_err: unknown): string {
    return 'UNKNOWN';
  }

  get budgetUsd(): number {
    return this.budgetUsdDefault;
  }

  async run(runner: PhaseRunner, _opts: PhaseRunOpts): Promise<PhaseResult> {
    const t0 = Date.now();
    try {
      const out = await this.process(runner);
      return {
        phase: this.name,
        status: out.status ?? 'ok',
        duration_ms: Date.now() - t0,
        summary: out.summary,
        details: out.details,
      };
    } catch (err) {
      const isBudget = err instanceof BudgetExhaustedError;
      const code = isBudget ? 'BUDGET_EXHAUSTED' : this.mapErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        phase: this.name,
        status: 'fail',
        duration_ms: Date.now() - t0,
        summary: `${this.name} failed: ${message}`,
        details: { error_code: code },
        error: { class: isBudget ? 'BudgetExhausted' : 'InternalError', code, message },
      };
    }
  }
}
