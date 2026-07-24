// The Express error backstop: malformed / oversized JSON bodies throw inside express.json BEFORE the
// route runs, so they must be mapped to the closed {ok:false, reqId, error} envelope — never leak a
// stack trace or break the contract. No DB needed (parse errors fire before auth/dispatch), so this
// runs unconditionally. Booting `app` also exercises the module-top-level assertDevAuthSafe (a no-op
// with DEV_AUTH unset).
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/index.ts';

describe('api error backstop — malformed / oversized body', () => {
  let server: Server;
  let base = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readJson = (res: Response): Promise<any> => res.json();

  beforeAll(() => {
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.close();
  });

  it('malformed JSON → 400 invalid_params envelope with a reqId, no stack leak', async () => {
    const res = await fetch(`${base}/api/whoami`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    });
    expect(res.status).toBe(400);
    const j = await readJson(res);
    expect(j.ok).toBe(false);
    expect(j.error.code).toBe('invalid_params');
    expect(j.reqId).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBeTruthy();
    // no internal detail leaked to the caller
    const body = JSON.stringify(j);
    expect(body).not.toContain('SyntaxError');
    expect(body).not.toContain('/src/');
  });

  it('oversized body → 413 payload_too_large envelope', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(200 * 1024) }); // > 100kb json limit
    const res = await fetch(`${base}/api/whoami`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    expect(res.status).toBe(413);
    const j = await readJson(res);
    expect(j.ok).toBe(false);
    expect(j.error.code).toBe('payload_too_large');
    expect(j.reqId).toBeTruthy();
  });

  it('a wrong content-type (no body parse) still reaches auth → 401, not a 400', async () => {
    // Not a parse error: express.json ignores non-json content-type, req.body is undefined, dispatch
    // sees {} — but with no dev-auth headers the request is unauthenticated first.
    const res = await fetch(`${base}/api/whoami`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
    expect(res.status).toBe(401);
  });
});
