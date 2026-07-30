// The single door to the server. Every request the UI makes goes through here.
//
// Same-origin only, and that is load-bearing rather than incidental: the server has NO CORS
// middleware at all, and csrfGuard rejects any mutation whose Sec-Fetch-Site is not 'same-origin'.
// A browser sets that header itself and page script cannot forge it, which is exactly why this app
// needs no CSRF token — there isn't one, by design. Do not add an X-CSRF-Token header; nothing
// reads it.

/** Error codes the server can return. Mirrors OpErrorCode in src/api/errors.ts. */
export type ErrorCode =
  | 'unauthenticated'
  | 'no_workspace'
  | 'no_grant'
  | 'bad_principal'
  | 'bad_workspace'
  | 'bad_grant'
  | 'invalid_params'
  | 'domain_not_verified'
  | 'insufficient_role'
  | 'permission_denied'
  | 'unknown_op'
  | 'not_found'
  | 'invite_invalid'
  | 'account_conflict'
  | 'already_exists'
  | 'payload_too_large'
  | 'unsupported_format'
  | 'extraction_failed'
  | 'rate_limited'
  | 'internal_error';

export interface WireError {
  code: ErrorCode;
  message: string;
  /** The server's own remediation text. RENDER THIS — do not write per-code copy in the UI. The
   *  backend already ships a suggestion on most errors (contextSuggestion in errors.ts,
   *  sanitySuggestion in sanity.ts); duplicating it here would create a second source of truth that
   *  drifts silently. Key on `code` for AFFORDANCE (where a button goes), never for wording. */
  suggestion?: string;
  /** Declared on the wire and currently unpopulated by the server. Rendered anyway so that the day
   *  a docs URL is attached to a code, it appears without a UI change. */
  docs?: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reqId: string,
    readonly status: number,
    readonly suggestion?: string,
    readonly docs?: string,
    /** Seconds, from the `retry-after` header on a 429. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A failure with no HTTP response at all — dev server down, network dropped, platform 502 before
 *  Express saw it. These have no server-generated reqId, which is the whole reason we mint one
 *  client-side below. */
export class TransportError extends Error {
  constructor(message: string, readonly reqId: string) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * Mint a request id and send it.
 *
 * src/api/reqid.ts already honours an inbound `x-request-id` and echoes it back, and nothing was
 * using that. It matters most in exactly the case a server-generated id cannot cover: when there is
 * no response body to read an id out of. With this, every failure the user can see has an id that
 * also appears in the server log.
 */
function newReqId(): string {
  return crypto.randomUUID();
}

async function request<T>(path: string, init: RequestInit & { reqId?: string } = {}): Promise<T> {
  const reqId = init.reqId ?? newReqId();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-request-id': reqId,
        ...(init.headers ?? {}),
      },
      // Explicit rather than relying on the default, because the session cookie is httpOnly and
      // this is the only thing that carries it.
      credentials: 'same-origin',
    });
  } catch (err) {
    throw new TransportError(err instanceof Error ? err.message : 'network request failed', reqId);
  }

  // The catch-all 404 and the terminal error middleware both return the closed envelope, so a JSON
  // parse failure here means something upstream of Express answered — a proxy, a platform error
  // page, or a misrouted SPA fallback serving HTML. Say so rather than surfacing "Unexpected token <".
  let body: unknown;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new TransportError(
      `expected JSON from ${path} but got ${res.headers.get('content-type') ?? 'no content-type'} ` +
        `(HTTP ${res.status}). Something other than the API answered this request.`,
      res.headers.get('x-request-id') ?? reqId,
    );
  }

  const env = body as { ok?: boolean; reqId?: string; data?: T; error?: WireError };
  if (!res.ok || env.ok === false) {
    const e = env.error;
    const retryAfterHeader = res.headers.get('retry-after');
    throw new ApiError(
      e?.code ?? 'internal_error',
      e?.message ?? `HTTP ${res.status}`,
      env.reqId ?? reqId,
      res.status,
      e?.suggestion,
      e?.docs,
      retryAfterHeader ? Number(retryAfterHeader) : undefined,
    );
  }
  return env.data as T;
}

/** Call an operation. `POST /api/:op` with the params as the body — not wrapped in anything. */
export function callOp<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
  return request<T>(`/api/${op}`, { method: 'POST', body: JSON.stringify(params) });
}

/**
 * Auth routes return TWO different envelope shapes: most are flat
 * ({ok, reqId, workspace_id, role}) while logout/logout-all use {ok, reqId, data:{…}}. Normalising
 * that on the server is a ~6-line change and worth doing before more clients exist, but until then
 * this returns the whole body and each caller reads what it needs — better than pretending one
 * shape and silently getting undefined.
 */
export async function callAuth<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const reqId = newReqId();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': reqId },
    credentials: 'same-origin',
    body: JSON.stringify(params ?? {}),
  }).catch((err: unknown) => {
    throw new TransportError(err instanceof Error ? err.message : 'network request failed', reqId);
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    reqId?: string;
    error?: WireError;
  };
  if (!res.ok || body.ok === false) {
    const e = body.error;
    throw new ApiError(
      e?.code ?? 'internal_error',
      e?.message ?? `HTTP ${res.status}`,
      body.reqId ?? reqId,
      res.status,
      e?.suggestion,
      e?.docs,
    );
  }
  return body as T;
}

export interface WhoAmI {
  principal: string;
  workspaceId: string;
  role: 'member' | 'admin' | 'owner';
  grants: string[];
  remote: boolean;
}

export interface Workspace {
  id: string;
  name: string;
}
