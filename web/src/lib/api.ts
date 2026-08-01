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
  // text()-then-parse, exactly like request(). `res.json().catch(() => ({}))` swallowed the one
  // failure test/web-mount.test.ts exists to prevent: the SPA fallback answering inside /auth/* with
  // HTML and a 200. That came back to the caller as a SUCCESSFUL call returning `{}` as T, while the
  // identical situation on an op route threw a TransportError naming the content-type. Two doors into
  // the same server should not disagree about what "the API did not answer this" looks like.
  let parsed: unknown;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new TransportError(
      `expected JSON from ${path} but got ${res.headers.get('content-type') ?? 'no content-type'} ` +
        `(HTTP ${res.status}). Something other than the API answered this request.`,
      res.headers.get('x-request-id') ?? reqId,
    );
  }

  const body = parsed as { ok?: boolean; reqId?: string; error?: WireError };
  if (!res.ok || body.ok === false) {
    const e = body.error;
    // mountAuth has its OWN rate limiter (30/5min), so /auth routes 429 on their own schedule —
    // including /auth/invites/accept. Dropping the header here made ErrorPanel's "Try again in {N}s"
    // structurally unreachable for every auth route, though docs/screens.md lists that countdown as
    // the treatment for the rate-limited state.
    const retryAfterHeader = res.headers.get('retry-after');
    throw new ApiError(
      e?.code ?? 'internal_error',
      e?.message ?? `HTTP ${res.status}`,
      body.reqId ?? reqId,
      res.status,
      e?.suggestion,
      e?.docs,
      retryAfterHeader ? Number(retryAfterHeader) : undefined,
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

/** A retrieved chunk. `scope` is the owning page's visibility LABEL — the acl is what actually
 *  enforced this hit being visible, so the label is for display only. */
export interface ChunkHit {
  chunkId: string;
  pageId: string;
  slug: string;
  title: string | null;
  ord: number;
  content: string;
  locator: unknown;
  /** Pre-rendered locator ("p. 4", "Sheet1!A1"), null for pasted text. */
  citation: string | null;
  scope: string;
  score: number;
}

export interface AskResult {
  answer: string;
  /** 1-BASED indices into `sources` — NOT into `cited`. `[2]` in the answer text is `sources[1]`.
   *  Index-parallel with `cited`, which answer.ts:130 derives as `citations.map(n => sources[n-1])`.
   *  This comment said "into `cited`" and the UI numbered its chips by array position because of
   *  it, so every inline marker pointed at the wrong source. Server-clamped, so they resolve. */
  citations: number[];
  /** The chunks the answer actually used. */
  cited: ChunkHit[];
  /** Everything retrieved, including what the answer did not use. */
  sources: ChunkHit[];
  /** 'keyword_only' when the embedder was unavailable — results are keyword-only and may be
   *  incomplete. Distinct from ingest's degraded flag, which is about extraction. */
  degraded?: string;
}

/** Pre-declared for the search surface that lands in M6 — nothing calls `search` from the UI today.
 *  Kept rather than deleted so the shape is written down once, in the same spirit as WireError.docs;
 *  the difference between dead and deliberate is this sentence. */
export interface SearchResult {
  degraded?: string;
  results: ChunkHit[];
}

export interface PageSummary {
  id: string;
  slug: string;
  title: string | null;
  kind: string;
  scope: string;
  tags: string[];
  sourceFormat: string | null;
  hasSource: boolean;
  /** 0 means the page exists but is UNRETRIEVABLE — an ingest wrote the row and failed before its
   *  chunks landed. Worth showing rather than hiding; the backend comment says so explicitly. */
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListPagesResult {
  pages: PageSummary[];
  /** No total count exists by design, so pagination is "load more", never numbered. */
  hasMore: boolean;
}

export interface IngestResult {
  pageId: string;
  chunkCount: number;
}

export interface IngestFileResult {
  pageId: string;
  slug: string;
  chunkCount: number;
  format: string;
  unitsExtracted: number;
  unitsSkipped: number;
  /** True when part of the document could not be extracted. A 40-page PDF where 37 pages were
   *  scans looks exactly like a clean 3-page ingest without this. */
  degraded: boolean;
  sha256: string;
}

/**
 * Confidence, derived from EVIDENCE rather than asked of the model.
 *
 * A model self-reporting confidence about its own retrieval-grounded answer is noise — it has no
 * access to whether retrieval worked. These three states are all derivable from the response shape
 * and cost nothing:
 *
 *   none        no sources retrieved at all
 *   unsupported sources exist but the answer cited none of them  <- the dangerous one
 *   grounded    the answer cites retrieved sources
 */
export type Confidence = 'none' | 'unsupported' | 'grounded';

export function confidenceOf(r: AskResult): Confidence {
  if (r.sources.length === 0) return 'none';
  if (r.citations.length === 0) return 'unsupported';
  return 'grounded';
}
