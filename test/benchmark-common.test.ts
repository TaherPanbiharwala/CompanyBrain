import { describe, expect, it } from 'bun:test';
import { campaignLedgerRunId } from '../scripts/benchmark-common.ts';

describe('benchmark ledger identity', () => {
  it('maps a readable campaign ID to a stable RFC-4122 UUID for the M8 ledger', () => {
    const campaignId = 'longmemeval-2026-09-20t17-02-57-358z-8ef57d79';
    const first = campaignLedgerRunId(campaignId);
    expect(first).toBe(campaignLedgerRunId(campaignId));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(campaignLedgerRunId(`${campaignId}-other`));
  });
});
