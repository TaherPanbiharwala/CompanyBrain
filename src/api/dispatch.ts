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

  const finish = (outcome: string, result: DispatchResult, dims?: RequestLogEntry['dims']): DispatchResult => {
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
      ...(dims ? { dims } : {}),
    };
    logSink(entry);
    return result;
  };

  /** The closed set from detect.ts. An allow-list rather than "whatever the handler returned",
   *  because this value goes into a log line and the handler's return type cannot promise it stayed
   *  inside the union — a future op returning `format: <user text>` would otherwise inject it. */
  const KNOWN_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'csv', 'json', 'html', 'markdown', 'text']);
  const dimsOf = (data: unknown): RequestLogEntry['dims'] | undefined => {
    const f = (data as { format?: unknown } | null)?.format;
    return typeof f === 'string' && KNOWN_FORMATS.has(f) ? { format: f } : undefined;
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
    // `ok_degraded`, not `ok`, when the handler says the result rests on less than it should.
    //
    // This is deliberately read off the RESULT rather than plumbed through a side channel: any op
    // whose success can be partial should be able to say so by returning `degraded`, and one that
    // never degrades needs no code here at all. Still a code/enum, never a message (D28), and still
    // a success — the caller got an answer.
    //
    // Without this, an embedding outage is invisible in the logs: every request reads `ok`, latency
    // barely moves (keyword-only is FASTER), and the only symptom is that answers quietly get worse.
    // Both shapes count. `search`/`ask` report a STRING naming which arm was lost; `ingest_file`
    // reports a BOOLEAN meaning the extraction was partial (a 40-page PDF where 37 pages were scans).
    // Different causes, same operational fact — the request succeeded and the result is worth less
    // than it looks — so they share one outcome code rather than one being silently logged as clean.
    const degraded = (data as { degraded?: unknown } | null)?.degraded;
    const isDegraded = degraded === true || (typeof degraded === 'string' && degraded !== '');
    return finish(isDegraded ? 'ok_degraded' : 'ok', { ok: true, reqId, data }, dimsOf(data));
  } catch (err) {
    if (err instanceof OperationError) {
      // Op-declared error: message is intended for the caller (no secret values by construction).
      return finish(err.code, { ok: false, reqId, status: err.status, error: err.toWire() });
    }
    // A policy/privilege denial is not an internal error, and it is the one Postgres failure a
    // caller can act on. Without this branch every RLS-adjacent refusal reaches the caller as
    // `internal_error` + "Reference reqId … in server logs" — terminal for an MCP agent, which
    // cannot read server logs and cannot usefully retry. `permission_denied` has been declared in
    // errors.ts since M1 with the comment "acl && grants rows at M3" and was constructed nowhere;
    // M3 is when it becomes reachable. Detail still goes to the error sink, because the Postgres
    // message can echo a row value.
    if ((err as { code?: string } | null)?.code === '42501') {
      errorSink(reqId, name, err);
      return finish('permission_denied', {
        ok: false,
        reqId,
        status: 403,
        error: {
          code: 'permission_denied',
          message: 'the database denied this operation for the calling identity',
          suggestion:
            'A row is reachable only when its workspace matches your active workspace AND its acl ' +
            'overlaps your grants. Call whoami to see both.',
        },
      });
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
