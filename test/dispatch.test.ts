import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { z } from 'zod';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { operationsByName, defineOp } from '../src/api/operations.ts';
import { dispatchOp } from '../src/api/dispatch.ts';
import type { RequestLogEntry } from '../src/api/redact.ts';

const P = crypto.randomUUID();
const W = crypto.randomUUID();
const ctxMember = buildContext({ principal: P, workspaceId: W, role: 'member', grants: resolveGrants(P, W), remote: false });
const ctxOwner = buildContext({ principal: P, workspaceId: W, role: 'owner', grants: resolveGrants(P, W), remote: false });

const SECRET = 'topsecret-value-8f31';

// Inject two test-only ops into the registry lookup (cleaned up afterAll).
beforeAll(() => {
  operationsByName._boom = defineOp({
    name: '_boom',
    description: 'test: throws a generic error containing a secret',
    params: z.object({}),
    handler: async () => {
      throw new Error(`boom leaked ${SECRET}`);
    },
  });
  operationsByName._adminparam = defineOp({
    name: '_adminparam',
    description: 'test: admin-only op with a required param',
    params: z.object({ x: z.string() }),
    requiredRole: 'admin',
    handler: async (_ctx, params) => ({ x: params.x }),
  });
});
afterAll(() => {
  delete operationsByName._boom;
  delete operationsByName._adminparam;
});

describe('dispatchOp — the ladder', () => {
  it('unknown op → not-found envelope (unknown_op/404)', async () => {
    const r = await dispatchOp(ctxOwner, 'does_not_exist', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('unknown_op');
      expect(r.status).toBe(404);
    }
  });

  it('success → {ok:true,data} with a reqId', async () => {
    const r = await dispatchOp(ctxOwner, 'whoami', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { role: string }).role).toBe('owner');
    expect(r.reqId).toBeTruthy();
  });

  it('bad params → invalid_params/400', async () => {
    const r = await dispatchOp(ctxOwner, 'echo', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_params');
      expect(r.status).toBe(400);
    }
  });

  it('member on admin op → insufficient_role/403', async () => {
    const r = await dispatchOp(ctxMember, 'list_members', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('insufficient_role');
  });

  it('role is checked BEFORE validation (precedence)', async () => {
    // member calls an admin op with MISSING required param → role wins, not invalid_params.
    const r = await dispatchOp(ctxMember, '_adminparam', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('insufficient_role');
  });

  it('passes through an explicit reqId', async () => {
    const r = await dispatchOp(ctxOwner, 'whoami', {}, { reqId: 'fixed-req-123' });
    expect(r.reqId).toBe('fixed-req-123');
  });
});

describe('dispatchOp — prototype-chain names do not crash or bypass the log', () => {
  it('an op name that is an Object.prototype key → unknown_op/404 AND a log line is still written', async () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const logs: RequestLogEntry[] = [];
      const r = await dispatchOp(ctxOwner, name, {}, { logSink: (e) => logs.push(e) });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('unknown_op');
        expect(r.status).toBe(404);
      }
      // the sacred audit invariant: the request is logged, not silently dropped by a crash
      expect(logs).toHaveLength(1);
      expect(logs[0]!.outcome).toBe('unknown_op');
    }
  });

  it('a caller role that is an Object.prototype key → insufficient_role/403, never a throw', async () => {
    const ctxWeird = buildContext({ principal: P, workspaceId: W, role: 'constructor', grants: resolveGrants(P, W), remote: false });
    const logs: RequestLogEntry[] = [];
    const r = await dispatchOp(ctxWeird, 'whoami', {}, { logSink: (e) => logs.push(e) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('insufficient_role');
    expect(logs[0]!.outcome).toBe('insufficient_role');
  });
});

describe('dispatchOp — the sacred invariant: shapes never values', () => {
  it('a param value never appears in the request log', async () => {
    const logs: RequestLogEntry[] = [];
    await dispatchOp(ctxOwner, 'echo', { message: 'SUPERSEEKRIT' }, { logSink: (e) => logs.push(e) });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.params).toMatchObject({ kind: 'object', declared_keys: ['message'] });
    expect(JSON.stringify(logs[0])).not.toContain('SUPERSEEKRIT');
  });

  it('a handler error message goes to the error sink, NOT the shape-only request log', async () => {
    const logs: RequestLogEntry[] = [];
    const errs: unknown[] = [];
    const r = await dispatchOp(ctxOwner, '_boom', {}, {
      logSink: (e) => logs.push(e),
      errorSink: (_id, _op, err) => errs.push(err),
    });
    // caller gets a generic internal_error, no secret
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('internal_error');
      expect(r.error.message).toBe('internal error');
      expect(JSON.stringify(r.error)).not.toContain(SECRET);
    }
    // request log records only the outcome code — no secret
    expect(logs[0]!.outcome).toBe('internal_error');
    expect(JSON.stringify(logs[0])).not.toContain(SECRET);
    // the secret detail is preserved on the SEPARATE error sink (not lost)
    expect(String((errs[0] as Error).message)).toContain(SECRET);
  });
});

// ── The role gate PREVENTS EXECUTION, it does not merely 403 ──────────────
// Every existing role test asserted the response code. That is consistent with a handler that ran
// and had its result discarded — and the ops behind this gate are `list_members` (reads every
// membership) and `create_invite` (mints workspace access, on a table where cb_app holds
// table-level INSERT so the database will NOT stop it). "Did it answer 403" and "did it not run"
// are different questions, and only the second one is the security property.
describe('dispatchOp — a denied role never RUNS the handler', () => {
  it('the handler has no side effect when the role check fails', async () => {
    let ran = 0;
    operationsByName._sideeffect = defineOp({
      name: '_sideeffect',
      description: 'test: admin-only op that records that it ran',
      params: z.object({}),
      requiredRole: 'admin',
      handler: async () => {
        ran++;
        return { ran };
      },
    });
    try {
      const denied = await dispatchOp(ctxMember, '_sideeffect', {});
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('insufficient_role');
      expect(ran).toBe(0); // no write, no invite row, no email

      // …and the op IS runnable, so `ran === 0` above was not vacuously true.
      expect((await dispatchOp(ctxOwner, '_sideeffect', {})).ok).toBe(true);
      expect(ran).toBe(1);
    } finally {
      delete operationsByName._sideeffect;
    }
  });

  it('EVERY admin/owner-gated op in the REAL registry denies a member', async () => {
    const { operations } = await import('../src/api/operations.ts');
    const gated = operations.filter((o) => o.requiredRole === 'admin' || o.requiredRole === 'owner');
    expect(gated.length).toBeGreaterThan(0); // non-vacuity: the loop must actually iterate

    for (const op of gated) {
      const r = await dispatchOp(ctxMember, op.name, {}, { errorSink: () => {} });
      expect(r.ok, `${op.name} did not deny a member`).toBe(false);
      // Must be the ROLE code. `invalid_params` would mean validation ran first (ladder inverted);
      // any DB error would mean the handler ran. Both are the bug this asserts against.
      if (!r.ok) expect(r.error.code, `${op.name} denied for the wrong reason`).toBe('insufficient_role');
    }
  });

  it('the DEFAULT requiredRole is member — an op declaring none runs for a member', async () => {
    expect(operationsByName.whoami!.requiredRole).toBeUndefined();
    expect((await dispatchOp(ctxMember, 'whoami', {})).ok).toBe(true);
  });

  it('unknown keys are REJECTED, matching the additionalProperties:false we publish', async () => {
    // z.object strips unknown keys silently; the published JSON Schema says they are invalid. The
    // registry applies .strict() so the runtime tells the truth.
    const r = await dispatchOp(ctxOwner, 'echo', { message: 'hi', tpyo: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_params');
  });
});
