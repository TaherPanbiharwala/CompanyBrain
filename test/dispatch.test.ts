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
