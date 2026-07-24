// The single dispatch path: lookup → role-check → validate → run → redacted log.
// Ported from gbrain's dispatchToolCall (src/mcp/dispatch.ts) under MIT — see NOTICE. Adapted:
// company-brain tenant ctx, zod validation, and a NEUTRAL DispatchResult each transport formats
// (REST → JSON + status; MCP → ToolResult). A handler's error message NEVER reaches the shape-only
// request log — it goes to a separate error sink (review AM1). reqId threads log + envelope (AM6).
import type { OperationContext } from '../core/context.ts';
import { operationsByName, type Operation } from './operations.ts';
import { hasRole } from './roles.ts';
import { OperationError, statusFor, type OpErrorCode, type WireError } from './errors.ts';
import { summarizeParams, defaultLogSink, type LogSink, type RequestLogEntry } from './redact.ts';

export type DispatchResult =
  | { ok: true; reqId: string; data: unknown }
  | { ok: false; reqId: string; status: number; error: WireError };

export interface DispatchOpts {
  reqId?: string; // correlation id (propagate inbound x-request-id, else generated)
  idempotencyKey?: string; // reserved seam — unused until M3 mutating ops (AM6)
  logSink?: LogSink; // injectable for tests (the value-in-log negative test)
  errorSink?: (reqId: string, op: string, err: unknown) => void; // full detail — NEVER the request log
}

const defaultErrorSink = (reqId: string, op: string, err: unknown): void => {
  console.error(`[op_error] reqId=${reqId} op=${op}`, err);
};

export async function dispatchOp(
  ctx: OperationContext,
  name: string,
  rawParams: unknown,
  opts: DispatchOpts = {},
): Promise<DispatchResult> {
  const reqId = opts.reqId ?? crypto.randomUUID();
  const logSink = opts.logSink ?? defaultLogSink;
  const errorSink = opts.errorSink ?? defaultErrorSink;
  const started = performance.now();
  const op: Operation | undefined = operationsByName[name];

  const finish = (outcome: string, result: DispatchResult): DispatchResult => {
    const entry: RequestLogEntry = {
      ts: new Date().toISOString(),
      reqId,
      op: name,
      workspace: ctx.workspaceId,
      principal: ctx.principal,
      role: ctx.role,
      remote: ctx.remote,
      params: summarizeParams(op, rawParams),
      outcome, // code/enum ONLY — never a message
      ms: Math.round(performance.now() - started),
    };
    logSink(entry);
    return result;
  };

  const fail = (code: OpErrorCode, message: string, suggestion?: string): DispatchResult =>
    finish(code, { ok: false, reqId, status: statusFor(code), error: { code, message, suggestion } });

  // 1. lookup
  if (!op) {
    return fail('unknown_op', `no operation named "${name}"`, 'GET /api/_ops lists available operations.');
  }
  // 2. role-check — authz before validating attacker-chosen input (secure ladder; review C1)
  const required = op.requiredRole ?? 'member';
  if (!hasRole(ctx.role, required)) {
    return fail('insufficient_role', `operation "${name}" requires role "${required}"`, 'Ask a workspace admin or owner.');
  }
  // 3. validate (zod). Issue strings may echo the caller's own value — fine in the response, and the
  //    log records only the outcome CODE (never this message), so no value leaks to the log.
  const parsed = op.params.safeParse(rawParams ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return fail('invalid_params', msg || 'invalid parameters');
  }
  // 4. run — handlers open their own withScopedTx; any chat()/embed() stays OUTSIDE it (D6).
  try {
    const data = await op.handler(ctx, parsed.data);
    return finish('ok', { ok: true, reqId, data });
  } catch (err) {
    if (err instanceof OperationError) {
      // Op-declared error: message is intended for the caller (no secret values by construction).
      return finish(err.code, { ok: false, reqId, status: err.status, error: err.toWire() });
    }
    // Unexpected throw (e.g. a Postgres error echoing a value): full detail to the SEPARATE error
    // sink; the caller and the shape-only log get only the code + reqId.
    errorSink(reqId, name, err);
    return finish('internal_error', {
      ok: false,
      reqId,
      status: 500,
      error: { code: 'internal_error', message: 'internal error', suggestion: `Reference reqId ${reqId} in server logs.` },
    });
  }
}
