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
import { apiLimiter, type FixedWindowLimiter } from '../auth/ratelimit.ts';

export type DispatchResult =
  | { ok: true; reqId: string; data: unknown }
  | {
      ok: false;
      reqId: string;
      status: number;
      error: WireError;
      /** Seconds until the caller's budget resets. Present ONLY on `rate_limited`, and read from the
       *  same limiter instance that just refused the call — so the retry-after header a transport
       *  sends and the decision that produced it cannot disagree. A transport re-deriving the number
       *  from its own limiter would be re-asking a question that has already been answered. */
      retryAfter?: number;
    };

export interface DispatchOpts {
  reqId?: string; // correlation id (propagate inbound x-request-id, else generated)
  idempotencyKey?: string; // reserved seam — unused until M3 mutating ops (AM6)
  logSink?: LogSink; // injectable for tests (the value-in-log negative test)
  errorSink?: (reqId: string, op: string, err: unknown) => void; // full detail — NEVER the request log
  /** The per-principal budget. Defaults to the shared `apiLimiter`, which is the whole point: a
   *  transport added later is metered BY OMISSION rather than by someone remembering to wire it up.
   *  That is the failure direction that matters — until M4 this limiter fired at exactly one site
   *  (the Express route), so MCP and the CLI reached `ask`, `search` and `ingest_file` — every one a
   *  paid provider call — with no meter at all. */
  limiter?: FixedWindowLimiter;
  /** Opt OUT of the budget, and say why. A string rather than a boolean for the same reason the
   *  rls-exempt markers carry one: an exemption whose reason is unwritten is indistinguishable from
   *  an oversight six months later.
   *
   *  Reachable only from in-process TypeScript — `DispatchOpts` is never constructed from a request
   *  body — so no wire caller can set it. Legitimate uses are a local seeding/eval script whose
   *  entire job is a burst, and a test driving the limiter itself.
   *
   *  NOT `ctx.remote`, which was considered and rejected (D94): `auth/resolver.ts:123` sets
   *  `remote:false` for a REAL browser session and `api/dev-auth.ts:99` sets `remote:true` for the
   *  local header stub, so `remote` splits traffic in precisely the wrong place — exempting
   *  `!remote` would unmeter every production request. `OperationContext.remote` in core/context.ts also says outright that
   *  it is "NOT a scope switch". */
  unmetered?: string;
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

  const finish = (
    outcome: string,
    result: DispatchResult,
    dims?: RequestLogEntry['dims'],
    // Skip the param summary entirely. Used ONLY by the rung-0 shed below: summarizeParams calls
    // approxBytes, which JSON.stringify()s the whole raw body to bucket its size — up to the raised
    // upload limit — so measuring a request we are refusing turns the throttle into a CPU amplifier
    // under exactly the flood it exists to absorb. Before M4 a shed request cost O(1) and never
    // reached this function at all.
    skipParams = false,
  ): DispatchResult => {
    const entry: RequestLogEntry = {
      ts: new Date().toISOString(),
      reqId,
      op: name,
      workspace: ctx.workspaceId,
      principal: ctx.principal,
      role: ctx.role,
      remote: ctx.remote,
      params: skipParams ? null : summarizeParams(op, rawParams),
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

  // 0. budget — ahead of lookup, and ahead of every transport.
  //
  // This is the rung that makes the meter universal. `apiLimiter` used to fire at src/api/server.ts
  // only, so the Express route was metered while src/api/mcp.ts and src/api/call.ts called this
  // function bare. Since M3 that path carries `ask`, `search` and `ingest_file` — all paid provider
  // calls — which made the AGENT lane the one expensive surface with no meter on it
  // (the REQUIRED_LIVE_SUITES doc-comment in test/live-gate.test.ts recorded the hole in prose for a whole milestone).
  //
  // Charging BEFORE op lookup is deliberate on two counts. It preserves the REST behaviour exactly —
  // server.ts shed before dispatch ever ran, so an unknown op still costs a token and the existing
  // 121-request ladder in test/api.test.ts counts identically — and an agent spraying op names it
  // does not have is precisely the loop this exists to bound.
  //
  // This is a RATE meter, not a spend cap. There is no ledger, no per-workspace quota and no usage
  // accounting anywhere in src/; D18 puts that at M5. What this bounds is calls per minute per
  // principal, which bounds the blast radius of a loop without pretending to price it.
  //
  // AND IT DOES NOT COVER THE CLI, despite reaching it. FixedWindowLimiter's buckets are a
  // per-process Map and src/api/call.ts is one-shot — it dispatches once and exits — so every
  // invocation starts with an empty bucket and `while true; do bun run call ask …; done` is metered
  // at 1 per process, forever. REST and MCP are long-lived and genuinely covered. Stated here rather
  // than papered over: the CLI runs on a developer's own machine against their own principal, so the
  // gap is accepted, not fixed. A shared store is the real answer and belongs with the M5 ledger.
  if (!opts.unmetered) {
    const limiter = opts.limiter ?? apiLimiter;
    if (limiter.hit(ctx.principal)) {
      return finish('rate_limited', {
        ok: false,
        reqId,
        status: statusFor('rate_limited'),
        retryAfter: limiter.retryAfterSeconds(ctx.principal),
        error: {
          code: 'rate_limited',
          message: 'too many requests',
          // "this workspace" is what the Express version said, and it was wrong: the bucket is keyed
          // on ctx.principal (see apiLimiter in src/auth/ratelimit.ts), so one member hitting the
          // ceiling never throttled their colleagues. Corrected while moving it rather than carried
          // over. It also does not claim the CLI: see the note on `unmetered` above.
          suggestion: 'Slow down — you have hit your per-minute operation budget. Applies to REST and MCP alike.',
        },
      }, undefined, true); // skipParams — see finish(); do not measure a body we are refusing
    }
  }

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
      //
      // retryAfter rides through when the THROWER set it. Until now only rung 0 (the per-principal
      // budget) could produce a retry-after, so the extraction admission gate's 429s — the ones a
      // bulk client actually hits first — arrived with nothing to back off against, and
      // docs/screens.md's promised "countdown from retry-after" was unreachable for them.
      return finish(err.code, {
        ok: false,
        reqId,
        status: err.status,
        error: err.toWire(),
        ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
      });
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
