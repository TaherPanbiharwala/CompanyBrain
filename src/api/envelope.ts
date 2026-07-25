// The two response shapes every surface writes, written once.
//
// Both of these existed in hand-copied versions across server.ts, routes.ts and csrf.ts. That is the
// same shape as the `reqId` cap finding (P0-3): a property is documented on one copy, the other
// copies drift, and nothing tells you which copy the request actually took. The error envelope is a
// *contract* — `{ok:false, reqId, error}` on every failure path — so it should have exactly one
// writer.
//
// It now does, for FAILURES. An adversarial review of the commit that introduced this file caught it
// claiming "exactly one writer" while six hand-written copies survived, five of them in server.ts —
// the first file this header names. They are now routed through sendError with real OperationErrors,
// including the terminal error middleware's parse/too-large/500 paths. The one shape deliberately
// NOT here is the SUCCESS envelope (`{ok:true, reqId, data}`), which server.ts writes directly
// because the data payload differs per surface and there is nothing to keep in sync.
import type { Response } from 'express';
import { OperationError } from './errors.ts';
import type { FixedWindowLimiter } from '../auth/ratelimit.ts';

/** The one closed error envelope. Always carries `reqId` so a 500 can be traced to its log line. */
export function sendError(res: Response, reqId: string, err: OperationError): void {
  res.status(err.status).json({ ok: false, reqId, error: err.toWire() });
}

/** Charge one request against `limiter`. Returns true when the caller was SHED — the response has
 *  already been written and the caller must return immediately.
 *
 *  `retry-after` comes from the same limiter instance that just rejected the request, so the header
 *  and the decision cannot disagree. (The three call sites this replaced already did that correctly
 *  — the duplication was the problem, not a bug in any one copy.) */
export function shedIfLimited(
  limiter: FixedWindowLimiter,
  key: string,
  res: Response,
  reqId: string,
  suggestion: string,
): boolean {
  if (!limiter.hit(key)) return false;
  res.setHeader('retry-after', String(limiter.retryAfterSeconds(key)));
  sendError(res, reqId, new OperationError('rate_limited', 'too many requests', suggestion));
  return true;
}
