// BaseCyclePhase's run() envelope — fully offline via a stub PhaseRunner (the interface has no
// required DB behavior, so a fake satisfying its shape never touches a connection).
import { describe, it, expect } from 'bun:test';
import { BaseCyclePhase } from '../src/core/cycle/base-phase.ts';
import { BudgetExhaustedError } from '../src/core/cycle/budget-meter.ts';
import type { PhaseRunner } from '../src/core/cycle/runner-context.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';

const ctx = buildContext({
  principal: '00000000-0000-0000-0000-000000000000',
  workspaceId: '11111111-1111-1111-1111-111111111111',
  role: 'system',
  grants: resolveGrants('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111'),
  remote: false,
});

function stubRunner(overrides: Partial<PhaseRunner> = {}): PhaseRunner {
  return {
    ctx,
    runId: 'run-1',
    dryRun: false,
    withTx: async (fn) => fn({} as never),
    checkBudget: async () => ({ allowed: true, estimatedCostUsd: 0, cumulativeCostUsd: 0, budgetUsd: 1 }),
    recordSpend: async () => {},
    loadCheckpoint: async () => [],
    saveCheckpoint: async () => {},
    clearCheckpoint: async () => {},
    recordFailure: async () => ({ attempts: 1 }),
    clearFailure: async () => {},
    ...overrides,
  };
}

class OkPhase extends BaseCyclePhase {
  readonly name = 'ok-phase';
  protected readonly budgetUsdDefault = 0.5;
  protected async process() {
    return { summary: 'did the thing', details: { n: 3 } };
  }
}

class WarnPhase extends BaseCyclePhase {
  readonly name = 'warn-phase';
  protected readonly budgetUsdDefault = 0.5;
  protected async process() {
    return { summary: 'partially did the thing', details: {}, status: 'warn' as const };
  }
}

class ThrowingPhase extends BaseCyclePhase {
  readonly name = 'throwing-phase';
  protected readonly budgetUsdDefault = 0.5;
  protected async process(): Promise<never> {
    throw new Error('boom');
  }
  protected mapErrorCode(): string {
    return 'BOOM';
  }
}

class BudgetBlownPhase extends BaseCyclePhase {
  readonly name = 'budget-blown-phase';
  protected readonly budgetUsdDefault = 0.5;
  protected async process(runner: PhaseRunner): Promise<never> {
    await runner.checkBudget({ modelId: 'x', estimatedInputTokens: 0, maxOutputTokens: 0, kind: 'chat' });
    throw new Error('unreachable');
  }
}

describe('BaseCyclePhase.run', () => {
  it('maps a successful process() to status ok with the returned summary/details', async () => {
    const result = await new OkPhase().run(stubRunner(), { runId: 'run-1', dryRun: false });
    expect(result.status).toBe('ok');
    expect(result.phase).toBe('ok-phase');
    expect(result.summary).toBe('did the thing');
    expect(result.details).toEqual({ n: 3 });
    expect(result.error).toBeUndefined();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('passes through an explicit non-ok status', async () => {
    const result = await new WarnPhase().run(stubRunner(), { runId: 'run-1', dryRun: false });
    expect(result.status).toBe('warn');
  });

  it('catches a thrown error and maps it to status fail with the phase\'s error code', async () => {
    const result = await new ThrowingPhase().run(stubRunner(), { runId: 'run-1', dryRun: false });
    expect(result.status).toBe('fail');
    expect(result.error?.class).toBe('InternalError');
    expect(result.error?.code).toBe('BOOM');
    expect(result.error?.message).toBe('boom');
    expect(result.summary).toContain('throwing-phase failed');
  });

  it('classifies a BudgetExhaustedError distinctly from a generic failure', async () => {
    const runner = stubRunner({
      checkBudget: async () => {
        throw new BudgetExhaustedError('over cap', 2, 1, 'x');
      },
    });
    const result = await new BudgetBlownPhase().run(runner, { runId: 'run-1', dryRun: false });
    expect(result.status).toBe('fail');
    expect(result.error?.class).toBe('BudgetExhausted');
    expect(result.error?.code).toBe('BUDGET_EXHAUSTED');
  });

  it('exposes the phase\'s budget ceiling via the budgetUsd getter', () => {
    expect(new OkPhase().budgetUsd).toBe(0.5);
  });
});
