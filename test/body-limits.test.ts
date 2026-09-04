// The published schema and the transport that has to carry it must agree.
//
// They did not. `ingest.body` and `replace_page.body` advertise max 200,000 CHARACTERS in
// /api/_ops and in MCP tools/list, while every request was capped at 100kb by the app-wide parser.
// Worst-case UTF-8 is 4 bytes per character, so that schema was unsatisfiable by 2x-8x: pasting an
// ordinary business document returned `payload_too_large` naming "the 100kb limit" while the form
// said 200,000.
//
// It stayed invisible because the only clients were curl and agents sending small bodies. A web UI
// makes it routine -- "paste a document" is the simplest form of the upload step -- and a form
// generated from the published JSON-Schema would render maxLength=200000, validate client-side
// against it, and then 413.
//
// Offline: pure constant arithmetic plus a source scan. No database, no server.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index.ts';
import { MAX_FILE_BYTES } from '../src/ingest/file.ts';
import { MAX_BATCH_FILES, BATCH_INGEST_CONCURRENCY } from '../src/ingest/batch.ts';
import { MAX_BODY_CHARS } from '../src/api/operations.ts';
import {
  PASTE_PATHS,
  PASTE_BODY_LIMIT,
  UPLOAD_PATH,
  UPLOAD_BODY_LIMIT,
  BATCH_UPLOAD_PATH,
  INGEST_FILES_BODY_LIMIT,
  STANDARD_BODY_LIMIT,
  bodyLimitFor,
  parsesOwnBody,
} from '../src/api/server.ts';

/** '1mb' | '100kb' | '8mb' -> bytes. */
function toBytes(limit: string): number {
  const m = /^(\d+(?:\.\d+)?)(kb|mb)$/i.exec(limit);
  if (!m) throw new Error(`unparseable limit: ${limit}`);
  return Number(m[1]) * (m[2]!.toLowerCase() === 'mb' ? 1024 * 1024 : 1024);
}

describe('the paste transport limit can actually carry the published schema', () => {
  it('PASTE_BODY_LIMIT covers MAX_BODY_CHARS at worst-case UTF-8', () => {
    // 4 bytes per character is the real worst case for UTF-8 (astral-plane codepoints: emoji,
    // some CJK extensions). A body of 200k such characters is 800KB on the wire.
    const worstCaseBytes = MAX_BODY_CHARS * 4;
    expect(toBytes(PASTE_BODY_LIMIT)).toBeGreaterThanOrEqual(worstCaseBytes);
  });

  it('the app-wide limit CANNOT carry it — which is why these routes parse their own body', () => {
    // The control: if this stopped being true, the per-route parsers would be dead weight and
    // someone would rightly delete them. Documents WHY the exemption exists.
    expect(toBytes(STANDARD_BODY_LIMIT)).toBeLessThan(MAX_BODY_CHARS);
  });

  it('every paste route is exempt from the app-wide parser', () => {
    for (const p of PASTE_PATHS) {
      expect(parsesOwnBody(p)).toBe(true);
      expect(bodyLimitFor(p)).toBe(PASTE_BODY_LIMIT);
    }
    expect(parsesOwnBody(UPLOAD_PATH)).toBe(true);
    expect(bodyLimitFor(UPLOAD_PATH)).toBe(UPLOAD_BODY_LIMIT);
    // The batch counterpart — same wiring, wider body.
    expect(parsesOwnBody(BATCH_UPLOAD_PATH)).toBe(true);
    expect(bodyLimitFor(BATCH_UPLOAD_PATH)).toBe(INGEST_FILES_BODY_LIMIT);
    // Everything else keeps the small cap.
    expect(parsesOwnBody('/api/whoami')).toBe(false);
    expect(bodyLimitFor('/api/whoami')).toBe(STANDARD_BODY_LIMIT);
  });

  it('the limit lookup is case-insensitive, because Express routing is', () => {
    // Express routes case-insensitively by default and index.ts never enables `case sensitive
    // routing`, so POST /api/Ingest_File reaches the upload handler. An exact === compare handed
    // that request the 100kb parser instead of the 8mb one. Fails closed (a 413 rather than a
    // bypass), but it is two things that must agree disagreeing. Same bypass csrf.ts documents.
    expect(bodyLimitFor('/API/INGEST_FILE')).toBe(UPLOAD_BODY_LIMIT);
    expect(bodyLimitFor('/Api/Ingest')).toBe(PASTE_BODY_LIMIT);
    expect(bodyLimitFor('/API/INGEST_FILES')).toBe(INGEST_FILES_BODY_LIMIT);
    // ...and non-STRICTLY. This half was missed and three reviewers measured it independently:
    // /api/ingest/ reaches the same mount but got the 100kb parser, and /api/ingest_file/ with no
    // cookie 413'd before requireValidSession could 401 it.
    expect(bodyLimitFor('/api/ingest/')).toBe(PASTE_BODY_LIMIT);
    expect(bodyLimitFor('/api/replace_page/')).toBe(PASTE_BODY_LIMIT);
    expect(bodyLimitFor('/API/INGEST_FILE/')).toBe(UPLOAD_BODY_LIMIT);
    expect(bodyLimitFor('/api/ingest_files/')).toBe(INGEST_FILES_BODY_LIMIT);
    expect(parsesOwnBody('/api/ingest/')).toBe(true);
    // The control: a normaliser that strips too eagerly would claim '/' too.
    expect(bodyLimitFor('/')).toBe(STANDARD_BODY_LIMIT);
    expect(bodyLimitFor('/api/whoami/')).toBe(STANDARD_BODY_LIMIT);
  });

  it('every op that PUBLISHES a wide body is on a raised-limit route — the REVERSE check', async () => {
    // The forward check below proves each PASTE_PATHS entry is real. Nothing proved the converse,
    // so DROPPING an entry silently restored the exact 200,000-char-schema-over-100kb-transport
    // defect this file exists to prevent. Measured: removing '/api/replace_page' from PASTE_PATHS
    // left the FULL suite at 491 pass / 0 fail while replace_page kept advertising maxLength 200000
    // in /api/_ops and MCP tools/list.
    //
    // Derived from the published contract rather than restated, so the two cannot disagree.
    const { buildToolDefs } = await import('../src/api/tool-defs.ts');
    const { operations } = await import('../src/api/operations.ts');
    const wide = buildToolDefs(operations.filter((o) => !o.hidden))
      .filter((d) => {
        const props = (d.inputSchema as { properties?: Record<string, { maxLength?: number }> }).properties;
        return props?.body?.maxLength === MAX_BODY_CHARS;
      })
      .map((d) => d.name);
    // Floor: an empty `wide` satisfies the loop trivially, which looks exactly like compliance.
    expect(wide.length, `no op publishes maxLength=${MAX_BODY_CHARS} — this scan has gone blind`).toBeGreaterThanOrEqual(2);
    for (const name of wide) {
      expect(
        parsesOwnBody(`/api/${name}`),
        `${name} advertises a ${MAX_BODY_CHARS}-character body but is capped at ${STANDARD_BODY_LIMIT} — ` +
          `the schema it publishes is unsatisfiable. Add /api/${name} to PASTE_PATHS.`,
      ).toBe(true);
      expect(bodyLimitFor(`/api/${name}`)).toBe(PASTE_BODY_LIMIT);
    }
  });

  it('every path named in PASTE_PATHS is a real op', async () => {
    // Anti-vacuity: a typo here ('/api/ingset') would silently mean the route never gets its parser
    // and the 100kb cap quietly comes back, with every assertion above still green.
    const { operations } = await import('../src/api/operations.ts');
    const names = new Set(operations.map((o) => o.name));
    for (const p of PASTE_PATHS) {
      expect(names.has(p.replace('/api/', ''))).toBe(true);
    }
    expect(names.has(UPLOAD_PATH.replace('/api/', ''))).toBe(true);
    expect(names.has(BATCH_UPLOAD_PATH.replace('/api/', ''))).toBe(true);
  });
});

let server: Server;
let base: string;
beforeAll(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

describe('the exemption is WIRED, not merely declared', () => {
  // Everything above this point is satisfied by bodyLimitFor() alone: delete the per-route parser
  // mounts from mountApi and every one of those assertions stays green while every oversized paste
  // behaves differently. These cases close that — but getting them to actually close it took two
  // tries, and the failed try is the more useful thing to record.
  //
  // THE TRAP: the obvious test — "POST 150KB to /api/ingest and assert it is not 413" — passes with
  // the parser mounts DELETED. Measured, not reasoned: with them gone, parsesOwnBody() still makes
  // index.ts skip the app-wide parser, so no parser runs, req.body is undefined, and the request
  // falls through to a 401. Not-413 either way. The assertion was reading the 401 the whole time.
  //
  // A guard only guards where the two wirings produce DIFFERENT output. Here that needs a body over
  // the RAISED limit, so a mounted parser rejects it (413) and an absent one cannot (401).
  const big = (n: number) => 'x'.repeat(n);
  // A junk cookie. It authenticates NOTHING and — since the review — no longer gets past the guard
  // either; that is exactly what the forged-cookie case below now asserts.
  const asSignedIn = {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin', // csrfGuard checks this once a session cookie is present.
    cookie: 'cb_session=not-a-real-session-this-authenticates-nothing',
  };

  it('a paste route has a parser whose limit is ABOVE the app-wide cap', async () => {
    // 150KB > STANDARD_BODY_LIMIT. A 413 here means index.ts ran the 100kb parser on a paste route
    // — the original defect. Weak on its own (see the trap above); it is the lower bracket.
    const res = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: asSignedIn,
      body: JSON.stringify({ slug: 'big', title: 'big', body: big(150_000) }),
    });
    expect(res.status, 'the 100kb parser ran on a paste route').not.toBe(413);
  });

  it('a FORGED session cookie is rejected BEFORE the parser, not after', async () => {
    // This case used to expect 413 — it drove an oversized body past the guard with a junk cookie to
    // prove the 1mb parser was mounted. The review showed that WAS the bug: requireSessionCookie
    // tested only that a cookie existed, so `cb_session=<anything>` unlocked the raised parser for a
    // caller authenticating nothing, and this test's own helper said so in a comment while asserting
    // the protection held. Measured before the fix: a junk cookie plus a 9 MB body returned 413,
    // meaning the parser had engaged.
    //
    // Now requireValidSession resolves the session for real, so the discriminating outcome inverts:
    // 401 = the guard ran first; 413 = the guard is gone and the parser buffered for a stranger.
    for (const path of PASTE_PATHS) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...asSignedIn, connection: 'close' },
        body: JSON.stringify({ slug: 'big', body: big(toBytes(PASTE_BODY_LIMIT) + 500_000) }),
      });
      expect(res.status, `${path} let a forged cookie reach the raised-limit parser`).toBe(401);
    }
  });

  it('a NON-paste route still has the small cap — the control', async () => {
    // `connection: close` because a Content-Length 413 is answered WITHOUT draining the request:
    // the 150KB body is still in flight, so the socket cannot be safely reused and a later request
    // that picks it up from the pool hangs until the test timeout. Discarding it here keeps the
    // failure mode out of unrelated cases.
    const res = await fetch(`${base}/api/whoami`, {
      method: 'POST',
      headers: { ...asSignedIn, connection: 'close' },
      body: JSON.stringify({ pad: big(150_000) }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('payload_too_large');
    // Asserted HERE rather than in a case of its own, because a Content-Length 413 is answered
    // without draining the request body — a second oversized POST in this file starves fetch's
    // connection pool and times out. This is the response that proves the hoist: a parser throw
    // calls next(err), skipping every remaining NON-error layer, so with securityHeaders mounted
    // below the parser this 413 shipped `content-security-policy: null`. Measured: reverting the
    // hoist left the full suite green, because every other header assertion targets /health or
    // /assets, neither of which reaches the parser.
    expect(res.headers.get('content-security-policy') ?? '', 'a 413 shipped with no CSP').toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('an anonymous caller is rejected before the multi-megabyte parser too', async () => {
    // csrfGuard cannot supply this: it waves through any cookieless non-/auth request by design, so
    // before requireSessionCookie a cross-site POST with no cookie was buffered and JSON.parse'd in
    // full before returning 401.
    //
    // The tell is again a body over the raised limit. 413 means the 8mb parser ran first and the
    // server did the buffering work for an anonymous caller; 401 means it never got that far.
    // Verified by removing requireSessionCookie from the UPLOAD_PATH mount: 401 -> 413.
    const res = await fetch(`${base}${UPLOAD_PATH}`, {
      method: 'POST',
      // connection:close for the same reason as the 413 above — an undrained oversized body makes
      // the socket unsafe to reuse, and the next case to pick it up from the pool hangs.
      headers: { 'content-type': 'application/json', connection: 'close' }, // deliberately NO cookie
      body: JSON.stringify({
        filename: 'a.txt',
        content_base64: big(toBytes(UPLOAD_BODY_LIMIT) + 1_000_000),
      }),
    });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status, 'the parser buffered an anonymous body before auth ran').toBe(401);
    expect(body.error.code).toBe('unauthenticated');
  });

  it('an anonymous caller is rejected before the batch parser too', async () => {
    // Same case as above, for BATCH_UPLOAD_PATH's own much larger limit — the mount order
    // (requireValidSession before express.json) is per-route, so this is not implied by the single-
    // file case above passing.
    const res = await fetch(`${base}${BATCH_UPLOAD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        files: [{ filename: 'a.txt', content_base64: big(toBytes(INGEST_FILES_BODY_LIMIT) + 1_000_000) }],
      }),
    });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status, 'the batch parser buffered an anonymous body before auth ran').toBe(401);
    expect(body.error.code).toBe('unauthenticated');
  });

  it('a MALFORMED body takes the parser error path and keeps the security headers', async () => {
    // The OTHER parser throw (entity.parse.failed). Same next(err) path as the 413 asserted in the
    // control above: it skips every remaining NON-error layer and lands on the terminal error
    // middleware, so anything mounted below the parser is skipped. The hoist that put
    // securityHeaders/preAuthGuard above it had ZERO coverage — measured: reverting the hoist left
    // the full suite at 491 pass / 0 fail, because every header assertion in the repo targets
    // /health or /assets, neither of which reaches the parser at all.
    //
    // A tiny body on purpose: a Content-Length 413 is answered without draining the request, so a
    // second oversized POST in this file starves fetch's connection pool and times out.
    const res = await fetch(`${base}/api/whoami`, { method: 'POST', headers: asSignedIn, body: '{not json' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get('content-security-policy') ?? '', 'an error-path response shipped with no CSP').toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('the base64 of a max-size file still fits UPLOAD_BODY_LIMIT', () => {
    // Upload.tsx btoa()s the raw bytes, inflating by 4/3 before JSON framing. Never asserted, though
    // it is the same schema-versus-transport question this file exists for.
    expect(toBytes(UPLOAD_BODY_LIMIT)).toBeGreaterThanOrEqual(Math.ceil(MAX_FILE_BYTES / 3) * 4);
  });

  it('INGEST_FILES_BODY_LIMIT covers MAX_BATCH_FILES max-size files at once', () => {
    // The batch counterpart to the case above: MAX_BATCH_FILES files, each independently at
    // UPLOAD_BODY_LIMIT's own worst case. Raising either constant without raising this fails here
    // instead of failing a legitimate batch upload with a bare 413.
    expect(toBytes(INGEST_FILES_BODY_LIMIT)).toBeGreaterThanOrEqual(
      MAX_BATCH_FILES * Math.ceil(MAX_FILE_BYTES / 3) * 4,
    );
  });
});

describe('the UI mirrors of the server limits cannot drift', () => {
  // Upload.tsx re-declares both bounds client-side. This repo pins that class of pair elsewhere
  // (GRANT_TAG_RE across three files, EXTRACTOR_VERSIONS against package.json); these were the
  // exception. Drift is silent in both directions: raise the server cap and the textarea keeps
  // truncating, lower it and the client accepts bodies the server 400s.
  const upload = () => Bun.file(new URL('../web/src/components/Upload.tsx', import.meta.url)).text();

  it('Upload.tsx MAX_BODY_CHARS equals the op schema bound', async () => {
    const m = /const MAX_BODY_CHARS = ([\d_]+);/.exec(await upload());
    expect(m, 'MAX_BODY_CHARS is no longer declared in Upload.tsx — this scan is vacuous').not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, ''))).toBe(MAX_BODY_CHARS);
  });

  it('Upload.tsx MAX_FILE_BYTES equals importFile\'s decoded-byte cap', async () => {
    const src = await upload();
    const m = /const MAX_FILE_BYTES = (\d+) \* (\d+) \* (\d+);/.exec(src);
    expect(m, 'MAX_FILE_BYTES is no longer declared in Upload.tsx').not.toBeNull();
    expect(Number(m![1]) * Number(m![2]) * Number(m![3])).toBe(MAX_FILE_BYTES);
    // The user-facing copy must be derived, not a third hardcoded copy of the number.
    expect(src).not.toMatch(/The limit is 5 MB/);
  });

  it('BatchUpload.tsx CHUNK_SIZE matches BATCH_INGEST_CONCURRENCY', async () => {
    // The two are independently declared literals a comment on each side says must match — one for
    // apiLimiter efficiency (fewer dispatchOp hits per file), one for not claiming more than half the
    // shared extraction admission gate. Raising either without the other silently breaks whichever
    // argument the matching value was chosen for.
    const src = await Bun.file(new URL('../web/src/components/BatchUpload.tsx', import.meta.url)).text();
    const m = /const CHUNK_SIZE = (\d+);/.exec(src);
    expect(m, 'CHUNK_SIZE is no longer declared in BatchUpload.tsx — this scan is vacuous').not.toBeNull();
    expect(Number(m![1])).toBe(BATCH_INGEST_CONCURRENCY);
  });
});

describe('the other UI mirrors, and the transport that carries them', () => {
  const read = (rel: string) => Bun.file(new URL(`../web/src/${rel}`, import.meta.url)).text();

  it('every maxLength in the UI matches its zod bound', async () => {
    // Four more client-side copies of a server bound sat unpinned next to the two this file already
    // guarded. Drift is silent in both directions: raise the server bound and the input keeps
    // truncating; lower it and the client accepts what the server 400s.
    // Read the published JSON-Schema rather than poking at zod internals — it is the contract the UI
    // is mirroring anyway, and it is what /api/_ops and MCP tools/list hand to every other client.
    const { operations } = await import('../src/api/operations.ts');
    const { buildToolDefs } = await import('../src/api/tool-defs.ts');
    const defs = buildToolDefs(operations.filter((o) => !o.hidden));
    const max = (op: string, field: string): number => {
      const d = defs.find((x) => x.name === op);
      expect(d, `op ${op} is not published — this scan is vacuous`).toBeDefined();
      const props = (d!.inputSchema as { properties: Record<string, { maxLength?: number }> }).properties;
      const n = props[field]?.maxLength;
      expect(n, `${op}.${field} publishes no maxLength`).toBeGreaterThan(0);
      return n!;
    };
    const cases: [string, string, string, string][] = [
      ['components/Upload.tsx', 'ingest', 'title', 'title'],
      ['components/Upload.tsx', 'ingest', 'slug', 'slug'],
      ['components/Invite.tsx', 'create_invite', 'email', 'email'],
      ['screens/Home.tsx', 'ask', 'question', 'question'],
    ];
    for (const [file, op, field] of cases) {
      const src = await read(file);
      const found = [...src.matchAll(/maxLength=\{(\d+)\}/g)].map((m) => Number(m[1]));
      expect(found.length, `${file} declares no maxLength — this scan reads nothing`).toBeGreaterThan(0);
      expect(
        found,
        `${file} has no input bounded at ${op}.${field}'s published max (${max(op, field)})`,
      ).toContain(max(op, field));
    }
  });

  it('the file picker offers exactly what the server accepts', async () => {
    // The hand-written accept string had already drifted: it hid .tsv and .markdown, both of which
    // detect.ts accepts. A hidden extension is not a rejection — it is a file the user cannot pick
    // even though the server would have taken it.
    const { ACCEPTED_EXTENSIONS } = await import('../src/ingest/extract/detect.ts');
    const src = await read('components/Upload.tsx');
    expect(ACCEPTED_EXTENSIONS.length).toBeGreaterThanOrEqual(9);
    expect(src, 'Upload.tsx hand-writes the accept list again').toContain('ACCEPTED_EXTENSIONS.join');
    expect(src).not.toMatch(/accept="\.[a-z]/);
  });

  it('responses are compressed — the build reports a 3x saving that was being discarded', async () => {
    // express.static never compresses and nothing set Content-Encoding anywhere in src/. Measured:
    // 233,738 bytes of JS+CSS shipped raw where gzip -9 gives 70,668.
    const pkg = JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text());
    expect(pkg.dependencies, 'the compression dependency is gone').toHaveProperty('compression');
    const idx = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
    expect(idx).toContain('compression()');
    // Must sit ABOVE the static mount, or hashed assets — the bulk of a cold load — go out raw.
    expect(idx.indexOf('compression()')).toBeLessThan(idx.indexOf('mountWebStatic(app)'));
  });
});
