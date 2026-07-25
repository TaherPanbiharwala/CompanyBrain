// The request id, derived in ONE place.
//
// `reqId` is echoed into the `x-request-id` response header AND embedded in every structured log
// line for the request (see redact.ts's RequestLogEntry and auth/log.ts's logAuth), so it must be
// bounded: it is client-supplied, and unbounded attacker-controlled text in structured logs is a
// log-volume and log-parsing problem even though Node rejects the control characters that would
// allow header splitting.
//
// The M1+M2 review found this derived by hand in five places, and the 200-char cap — along with the
// comment explaining why it was necessary — existed in exactly one of them. The place it was missing
// included POST /api/:op, whose dispatch log embeds reqId in every entry. A protection documented in
// one copy of five is not a protection.
import type { Request, Response } from 'express';

/** Long enough for any real correlation id (a uuid is 36, a W3C traceparent 55). */
export const MAX_REQUEST_ID_LENGTH = 200;

/**
 * The request's correlation id, generating one when the caller supplied nothing usable.
 *
 * Idempotent per response: once set on the response header, later calls return the same value, so
 * middleware and the route handler cannot disagree about which id this request has.
 */
export function requestId(req: Request, res: Response): string {
  const existing = res.getHeader('x-request-id');
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const supplied = req.header('x-request-id');
  const id = supplied && supplied.length <= MAX_REQUEST_ID_LENGTH ? supplied : crypto.randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}
