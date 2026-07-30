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

  it('the DEFAULT limiter is the shared apiLimiter — metered by omission', async () => {
    // The property D94 is actually about, and the one every other test here misses: they all pass an
    // explicit `limiter`, so `opts.limiter ?? apiLimiter` was never executed. Swap the fallback for a
    // freshly-constructed limiter (a meter that can never fire, because each call gets a new bucket)
    // and every other test in this file stays green. This one does not.
    //
    // A dedicated principal so the shared singleton's bucket cannot be polluted by another suite in
    // the same bun process.
    const solo = '44444444-4444-4444-8444-444444444444';
    try {
      for (let i = 0; i < 120; i++) {
        const r = await dispatchOp(ctxFor(solo), 'whoami', {}, quiet); // NOTE: no limiter passed
        expect(r.ok, `call ${i + 1} was refused below the shared ceiling`).toBe(true);
      }
      const over = await dispatchOp(ctxFor(solo), 'whoami', {}, quiet);
      expect(over.ok, 'the 121st call was allowed — dispatchOp is not defaulting to apiLimiter').toBe(false);
      if (over.ok) throw new Error('unreachable');
      expect(over.error.code).toBe('rate_limited');
    } finally {
      apiLimiter.reset();
    }
  });

  // ── THE REACH ────────────────────────────────────────────────────────────
  // Source-scanned, in the shape of test/scoped-tx-guard.test.ts, because this is a property of WHERE
  // the meter sits and no amount of black-box calling can observe it.
  //
  // COMMENTS ARE STRIPPED FIRST, and that is the whole lesson of this block. The first version asserted
  // `dispatch.ts` still contains the string `apiLimiter` — which its own DOC COMMENTS satisfy, so
  // deleting both the import and the `?? apiLimiter` fallback left the test green. A scanner that
  // cannot tell code from prose about code will eventually certify the prose (D90 records the same
  // lesson for the live-gate and scoped-tx guards).
  const codeOf = (f: string): string =>
    readFileSync(join(SRC, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

  it('no transport opts itself out, and the Express route no longer owns the meter', () => {
    // server.ts included: the REST route can opt itself out just as easily as the other two, and the
    // first version of this loop never looked at it.
    for (const f of ['mcp.ts', 'call.ts', 'server.ts']) {
      const src = codeOf(f);
      expect(src, `src/api/${f} passes dispatchOp an opt-out (unmetered or a private limiter). The ` +
        `agent/CLI lane is the one that most needs a meter, and this is exactly the hole M4 closed`)
        .not.toMatch(/\b(?:unmetered|limiter)\s*:/);
      // …and it still reaches dispatchOp at all. Without this, a transport that stopped calling
      // dispatchOp entirely — the strongest possible opt-out — would pass the negative above.
      if (f !== 'server.ts') {
        expect(src, `src/api/${f} no longer calls dispatchOp, so it is metered by nothing`).toContain('dispatchOp(');
      }
    }

    expect(codeOf('server.ts'), 'src/api/server.ts imports apiLimiter again. If the budget is shed at ' +
      'the route, it protects REST and nothing else — MCP and the CLI reach dispatchOp directly (D94).')
      .not.toContain('apiLimiter');

    // …and dispatch.ts really is where it lives now, asserted on the EXECUTABLE form so this cannot
    // pass on a comment that merely mentions the name.
    expect(codeOf('dispatch.ts'), 'dispatch.ts no longer falls back to the shared apiLimiter — the ' +
      'meter has gone missing, or become opt-IN')
      .toMatch(/limiter\s*\?\?\s*apiLimiter/);
  });

  it('every budget exemption in the tree states a reason', () => {
    // Same discipline as the rls-exempt markers: an exemption whose justification is unwritten is
    // indistinguishable from an oversight six months later. Comments stripped for the same reason as
    // the reach test above.
    const root = join(new URL('.', import.meta.url).pathname, '..');
    const bare: string[] = [];
    let exemptions = 0;
    for (const rel of new Bun.Glob('{src,scripts}/**/*.ts').scanSync(root)) {
      const src = readFileSync(join(root, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      // Scanned INSIDE dispatchOp() call sites only. A bare file-wide search for `limiter:` also
      // matches TYPE ANNOTATIONS — `shedIfLimited(limiter: FixedWindowLimiter, …)` in
      // src/api/envelope.ts is a parameter declaration, not an opt-out — and reporting that as an
      // unjustified exemption is a false positive that would train the next reader to ignore this test.
      //
      // `limiter:` is included alongside `unmetered:` because it is the SECOND way to opt out: passing
      // a private limiter with an enormous max is fully unmetered and states no reason. The first
      // version of this scan was blind to it, so only one of the two escape hatches was governed.
      for (let at = src.indexOf('dispatchOp('); at !== -1; at = src.indexOf('dispatchOp(', at + 1)) {
        let depth = 0;
        let end = at + 'dispatchOp'.length;
        for (; end < src.length; end++) {
          const c = src[end];
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        for (const m of src.slice(at, end).matchAll(/\b(unmetered|limiter)\s*:\s*(.)/g)) {
          exemptions += 1;
          // A quote starts a reason; `true`/an identifier does not.
          if (m[2] !== "'" && m[2] !== '"' && m[2] !== '`') bare.push(`${rel} (${m[1]})`);
        }
      }
    }
    // Anti-vacuity floor: `bare` is empty both when every exemption is justified AND when the scan
    // matches nothing at all — delete the one real exemption and this test would otherwise still pass.
    expect(exemptions, 'the exemption scanner matched nothing — it has gone blind, or the one real ' +
      'exemption (scripts/load-a17-corpus.ts) was removed without updating this floor')
      .toBeGreaterThanOrEqual(1);
    expect(bare, `these opt out of the budget without stating why: ${bare.join(', ')}`).toEqual([]);
  });
});
