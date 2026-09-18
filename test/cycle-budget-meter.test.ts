// Offline coverage of BudgetMeter's fail-closed contract. The actual check()/record() arithmetic
// against a real cycle_budget_ledger row lives in test/cycle.live.test.ts — both need a database
// transaction (withScopedTx), which a pure unit test cannot fake without duplicating the query.
import { describe, it, expect } from 'bun:test';
import { BudgetMeter, BudgetExhaustedError, UnknownModelPricingError } from '../src/core/cycle/budget-meter.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';

const ctx = buildContext({
  principal: '00000000-0000-0000-0000-000000000000',
  workspaceId: '11111111-1111-1111-1111-111111111111',
  role: 'system',
  grants: resolveGrants('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111'),
  remote: false,
});

describe('BudgetMeter — fail-closed construction', () => {
  it('rejects a zero budget — no gbrain-style "0 disables the gate" escape hatch', () => {
    expect(() => new BudgetMeter(ctx, { workspaceId: ctx.workspaceId, op: 'noop', runId: 'r1', budgetUsd: 0 })).toThrow(/positive budgetUsd/);
  });

  it('rejects a negative budget', () => {
    expect(() => new BudgetMeter(ctx, { workspaceId: ctx.workspaceId, op: 'noop', runId: 'r1', budgetUsd: -1 })).toThrow(/positive budgetUsd/);
  });

  it('accepts a positive budget', () => {
    expect(() => new BudgetMeter(ctx, { workspaceId: ctx.workspaceId, op: 'noop', runId: 'r1', budgetUsd: 0.01 })).not.toThrow();
  });
});

describe('BudgetExhaustedError', () => {
  it('carries the spend and cap it was constructed with', () => {
    const err = new BudgetExhaustedError('exceeded', 5, 1, 'openai:text-embedding-3-small');
    expect(err.spentUsd).toBe(5);
    expect(err.budgetUsd).toBe(1);
    expect(err.modelId).toBe('openai:text-embedding-3-small');
    expect(err.name).toBe('BudgetExhaustedError');
  });
});

describe('UnknownModelPricingError', () => {
  it('names the offending model in its message', () => {
    const err = new UnknownModelPricingError('some:unpriced-model');
    expect(err.modelId).toBe('some:unpriced-model');
    expect(err.message).toContain('some:unpriced-model');
  });
});
