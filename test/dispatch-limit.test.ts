// The per-principal budget lives at dispatchOp rung 0, so every transport is metered (D94).
//
// Offline by design: `whoami` touches no database, so the budget can be exercised without a live
// gate. What this file pins is not really the arithmetic — FixedWindowLimiter already has unit
// coverage in test/csrf-ratelimit.test.ts — it is the REACH. Until M4 `apiLimiter` fired at exactly
// one site (the Express route at src/api/server.ts) while src/api/mcp.ts and src/api/call.ts called
// dispatchOp bare, and since M3 that path carries `ask`, `search` and `ingest_file`, all of which
// spend money with a provider. The last test here is the one that stops that from coming back.
import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchOp } from '../src/api/dispatch.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { FixedWindowLimiter, apiLimiter } from '../src/auth/ratelimit.ts';

const SRC = join(new URL('.', import.meta.url).pathname, '..', 'src', 'api');
const WS = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';

const ctxFor = (principal: string): OperationContext =>
  buildContext({ principal, workspaceId: WS, role: 'owner', grants: resolveGrants(principal, WS), remote: false });

// Silence the request log: dispatchOp logs every outcome, including the new rate_limited one.
const quiet = { logSink: () => {} };

describe('the per-principal budget fires at dispatch, on every transport', () => {
  beforeEach(() => apiLimiter.reset());

  it('positive control: calls under the ceiling succeed', async () => {
    // Without this the refusal below could be any failure at all — a bad op name, a role check, a
    // validation error — and the test would report a working limiter either way.
    const limiter = new FixedWindowLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await dispatchOp(ctxFor(P1), 'whoami', {}, { ...quiet, limiter });
      expect(r.ok, `call ${i + 1} of 3 was refused below the ceiling`).toBe(true);
    }
  });

  it('over the ceiling: 429, rate_limited, and a retry-after the caller can use', async () => {
    const limiter = new FixedWindowLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) await dispatchOp(ctxFor(P1), 'whoami', {}, { ...quiet, limiter });

    const r = await dispatchOp(ctxFor(P1), 'whoami', {}, { ...quiet, limiter });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(429);
    expect(r.error.code).toBe('rate_limited');
    expect(r.retryAfter, 'no retry-after, so a caller cannot know when to come back').toBeGreaterThan(0);
  });

  it('keyed on the PRINCIPAL, not globally — one member cannot throttle their colleagues', async () => {
    // The assertion that catches a limiter keyed on a constant. src/auth/ratelimit.ts:79-84 chose the
    // principal over the IP precisely so one office behind NAT is not one bucket; a global key would
    // undo that and still pass every test above.
    const limiter = new FixedWindowLimiter({ windowMs: 60_000, max: 2 });
    for (let i = 0; i < 3; i++) await dispatchOp(ctxFor(P1), 'whoami', {}, { ...quiet, limiter });

    const other = await dispatchOp(ctxFor(P2), 'whoami', {}, { ...quiet, limiter });
    expect(other.ok, 'a second principal was throttled by the first principal\'s usage').toBe(true);
  });

  it('unmetered opts out, and is not accidentally always-on', async () => {
    const limiter = new FixedWindowLimiter({ windowMs: 60_000, max: 1 });
    for (let i = 0; i < 10; i++) {
      const r = await dispatchOp(ctxFor(P1), 'whoami', {}, { ...quiet, limiter, unmetered: 'test' });
      expect(r.ok, `unmetered call ${i + 1} was refused`).toBe(true);
    }
    // …and the same limiter is still live for a METERED caller, so the ten successes above are the
    // opt-out working and not a limiter that stopped counting. The FIRST metered call must also
    // succeed: `hit()` refuses at count > max, so a fresh bucket allows one — and that is itself the
    // proof that ten unmetered calls consumed no budget.
    const first = await dispatchOp(ctxFor(P1), 'whoami', {}, { ...quiet, limiter });
    expect(first.ok, 'the unmetered calls consumed budget — they should not touch the limiter at all').toBe(true);
    const second = await dispatchOp(ctxFor(P1), 'whoami', {}, { ...quiet, limiter });
    expect(second.ok, 'the limiter is inert — the unmetered test above proved nothing').toBe(false);
  });

  // ── THE REACH ────────────────────────────────────────────────────────────
  // Source-scanned, in the shape of test/scoped-tx-guard.test.ts, because this is a property of WHERE
  // the meter sits and no amount of black-box calling can observe it.
  it('no transport opts itself out, and the Express route no longer owns the meter', () => {
    for (const f of ['mcp.ts', 'call.ts']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, `src/api/${f} calls dispatchOp with unmetered — the agent/CLI lane is the one that ` +
        `most needs a meter, and this is exactly the hole M4 closed`).not.toContain('unmetered');
    }

    const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
    expect(server, 'src/api/server.ts imports apiLimiter again. If the budget is shed at the route, ' +
      'it protects REST and nothing else — MCP and the CLI reach dispatchOp directly (D94).')
      .not.toContain('apiLimiter');

    // …and dispatch.ts really is where it lives now, so this test cannot pass by everyone having
    // dropped the limiter entirely.
    const dispatch = readFileSync(join(SRC, 'dispatch.ts'), 'utf8');
    expect(dispatch, 'dispatch.ts no longer references apiLimiter — the meter has gone missing').toContain('apiLimiter');
  });

  it('every unmetered exemption in the tree states a reason', () => {
    // Same discipline as `// rls-exempt:`: an exemption whose justification is unwritten is
    // indistinguishable from an oversight. Matches `unmetered:` followed by a non-empty string.
    const root = join(new URL('.', import.meta.url).pathname, '..');
    const files = [...new Bun.Glob('{src,scripts}/**/*.ts').scanSync(root)];
    const bare: string[] = [];
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8');
      for (const m of src.matchAll(/unmetered:\s*(.)/g)) {
        // A quote starts a reason; `true`/`false`/an identifier does not.
        if (m[1] !== "'" && m[1] !== '"' && m[1] !== '`') bare.push(rel);
      }
    }
    expect(bare, `these opt out of the budget without stating why: ${bare.join(', ')}`).toEqual([]);
  });
});
