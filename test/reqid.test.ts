// The request-id derivation. One implementation, one cap.
//
// The M1+M2 review found this hand-rolled in FIVE places with THREE behaviours, and the 200-char cap
// — along with the comment explaining why it was necessary — in exactly one of them. The copy
// missing it was POST /api/:op, whose dispatch log embeds reqId in EVERY entry. These tests pin the
// property so a sixth copy cannot quietly reintroduce the gap.
import { describe, it, expect } from 'bun:test';
import type { Request, Response } from 'express';
import { requestId, MAX_REQUEST_ID_LENGTH } from '../src/api/reqid.ts';

/** Minimal stand-ins: requestId reads one header and reads/writes one response header. */
function pair(suppliedId?: string) {
  const headers: Record<string, unknown> = {};
  const req = { header: (n: string) => (n.toLowerCase() === 'x-request-id' ? suppliedId : undefined) } as unknown as Request;
  const res = {
    getHeader: (n: string) => headers[n.toLowerCase()],
    setHeader: (n: string, v: unknown) => { headers[n.toLowerCase()] = v; },
  } as unknown as Response;
  return { req, res, headers };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('requestId', () => {
  it('generates a uuid when the caller supplies nothing', () => {
    const { req, res, headers } = pair();
    const id = requestId(req, res);
    expect(id).toMatch(UUID_RE);
    expect(headers['x-request-id']).toBe(id); // …and publishes it for correlation
  });

  it('honours a reasonable client-supplied id (that is the point of the header)', () => {
    const { req, res } = pair('trace-abc-123');
    expect(requestId(req, res)).toBe('trace-abc-123');
  });

  it('accepts exactly the cap, and REJECTS one character past it', () => {
    const atCap = pair('x'.repeat(MAX_REQUEST_ID_LENGTH));
    expect(requestId(atCap.req, atCap.res)).toBe('x'.repeat(MAX_REQUEST_ID_LENGTH));

    const overCap = pair('x'.repeat(MAX_REQUEST_ID_LENGTH + 1));
    const id = requestId(overCap.req, overCap.res);
    expect(id).not.toContain('x');
    expect(id).toMatch(UUID_RE); // falls back to a generated id rather than truncating
  });

  it('a megabyte of attacker-controlled text never reaches the log or the header', () => {
    // This is the whole reason the cap exists: reqId is echoed into a response header AND embedded
    // in every structured log line for the request.
    const { req, res, headers } = pair('A'.repeat(1_000_000));
    const id = requestId(req, res);
    expect(id.length).toBeLessThanOrEqual(MAX_REQUEST_ID_LENGTH);
    expect(String(headers['x-request-id']).length).toBeLessThanOrEqual(MAX_REQUEST_ID_LENGTH);
  });

  it('is idempotent per response — middleware and handler cannot disagree about the id', () => {
    const { req, res } = pair();
    const first = requestId(req, res);
    expect(requestId(req, res)).toBe(first);
    expect(requestId(req, res)).toBe(first);
  });

  it('an empty supplied id is treated as absent, not as an empty id', () => {
    const { req, res } = pair('');
    expect(requestId(req, res)).toMatch(UUID_RE);
  });
});
