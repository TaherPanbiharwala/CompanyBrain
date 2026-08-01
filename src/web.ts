// The web UI's server-side half: security headers, static assets, and the SPA fallback.
//
// M5 Phase 0. Before this file the repo served no HTML at all — every route returned JSON — so this
// is the first code that hands a browser something it will EXECUTE. That is the entire reason
// securityHeaders() lives here and runs whether or not a UI is built: the moment ingested document
// text and model output reach a DOM, this app's threat model changes shape.
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import { config, isDevEnv, type Config } from './config.ts';

/** Built SPA lives here. Gitignored (`.gitignore`'s bare `dist/` covers it), so it is absent in dev
 *  and in any deploy whose build step did not run — see assertWebBuildPresent(). */
export const WEB_DIST = resolve(import.meta.dir, '../web/dist');
const INDEX_HTML = join(WEB_DIST, 'index.html');

/** Prefixes the SPA must never answer for.
 *
 *  The fallback is registered after every /api route, so a MATCHED api route never reaches it. But
 *  an unmatched one does — `app.post('/api/:op')` does not match `GET /api/whoami`, and without
 *  this guard that request would fall through and receive index.html with a 200. A client that
 *  JSON.parse()s the body then gets a syntax error instead of the closed {ok:false,...} envelope
 *  this API promises everywhere.
 *
 *  This is the one place the server's prefixes are duplicated, so it is pinned by
 *  test/web-mount.test.ts rather than left to drift. Lowercased because EXPRESS ROUTES
 *  CASE-INSENSITIVELY by default and index.ts never enables `case sensitive routing` — the same
 *  bypass csrf.ts:128-133 documents and works around. */
const SERVER_PREFIXES = ['/api', '/auth', '/health'] as const;

/** Set ONLY by createViteDev(), which only runs under `bun run dev` on a genuine dev environment
 *  with no build present. Read by securityHeaders() to relax script-src for Vite's inline Fast
 *  Refresh preamble. A process that never calls createViteDev keeps the strict policy, which is why
 *  this is a runtime flag rather than an env check. */
let viteDevActive = false;

/** True when this process is serving through Vite's dev middleware. Exported for tests. */
export function isViteDevActive(): boolean {
  return viteDevActive;
}

function isServerPath(path: string): boolean {
  const p = path.toLowerCase();
  // `p === prefix || startsWith(prefix + '/')`, NOT a bare startsWith. Bare prefixes were missing
  // before: GET /auth (no trailing slash) matched no route — mountAuth registers app.use('/auth',
  // limiter) which calls next() — and fell through to the SPA, returning index.html with a 200
  // instead of the JSON 404 this guard promises. Verified live. The '/' suffix also keeps a future
  // SPA route like /authors from being swallowed, which a bare startsWith('/auth') would eat.
  return SERVER_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

/**
 * Security headers for a cookie-authenticated, same-origin app that has NO CSRF token by design.
 *
 * That combination is why these are not optional. Auth is a session cookie; csrf.ts is an
 * origin-signal guard with no token; and the op set includes create_invite (mints a membership),
 * delete_page and replace_page. So any script executing on this origin has full authority over every
 * mutating operation — meaning stored XSS here is workspace takeover, not defacement.
 *
 * The injection path is real and already acknowledged elsewhere in this repo: uploaded documents
 * become chunks, `ask` retrieves them, and the model quotes them back (prompt.ts exists because
 * untrusted page content actively tries to steer the model). Rendering that in a DOM is the last
 * link. `script-src 'self'` means even a successful injection cannot execute.
 *
 * Applied to EVERY response, including JSON, so a route added later inherits it — the same reasoning
 * index.ts gives for mounting csrfGuard app-wide rather than inside a router.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Vite's PRODUCTION build emits no inline scripts, so this needs no 'unsafe-inline'. If a
      // future build tool does, fix the build — do not widen this.
      //
      // DEV IS DIFFERENT, and only dev: @vitejs/plugin-react injects an inline
      // `<script type="module">` carrying the React Fast Refresh preamble, which `script-src 'self'`
      // blocks outright. Left strict, HMR silently dies — the single feature that justified choosing
      // Vite over a plain bundler. Found by serving the dev HTML and reading it, not by reasoning.
      //
      // Gated on viteDevActive rather than isDevEnv, deliberately. NODE_ENV=test is a dev env by
      // config.ts's allowlist and CI sets it explicitly, so an isDevEnv gate would relax the policy
      // inside the very suite that asserts it is strict — a guard that stops guarding exactly where
      // it is checked. This flag is set only by createViteDev(), so the relaxation cannot exist in a
      // process that is not literally running Vite in middleware mode.
      viteDevActive ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
      // 'unsafe-inline' for styles only. React sets element.style for layout, and style injection
      // cannot execute script under this policy. Revisit if the UI stops needing inline styles.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      // No external network from the page: same-origin XHR/fetch only. Combined with the absence of
      // CORS on this server, that means the SPA can talk to this app and nothing else.
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      // Clickjacking. delete_page and create_invite are one click each on a cookie-authed origin
      // with no CSRF token, so framing this app is a real attack, not a theoretical one.
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  // Belt to frame-ancestors for anything that does not implement CSP framing directives.
  res.setHeader('X-Frame-Options', 'DENY');
  // Stops a browser MIME-sniffing a JSON error body as script — which is exactly what the flood
  // shed returns for an /assets/*.js request when it fires.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // HSTS only when this deployment is actually https. Gated on the SAME predicate session.ts uses
  // for the Secure attribute and the __Host- cookie prefix, so "this deployment is https" has one
  // answer rather than two that can disagree. Without it, a bookmarked or first-contact http:// URL
  // is downgradeable by a network attacker, who then controls an origin the user trusts — the
  // Secure cookie stops session theft there, but not the served-script surface.
  if (config.appBaseIsHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * The SPA fallback. Pass to mountApi({ webFallback }) — never mount it directly in index.ts; see
 * MountApiOptions for why that breaks sign-in.
 *
 * Deliberately narrow. It answers ONLY a GET/HEAD, for a non-server path, from a client that asked
 * for HTML, with no file extension. Everything else falls through to the API's JSON 404, which is
 * the behaviour every non-browser client already depends on.
 */
export function spaFallback(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isServerPath(req.path)) return next();

    // An asset request that reached here means the file is MISSING (express.static already ran and
    // declined it). Serving index.html for it would return HTML with a 200 for `main-a1b2.js`, and
    // the browser reports a MIME/parse error rather than a 404 — the deploy-race failure mode where
    // a cached index.html references chunks that no longer exist. Let it 404 honestly.
    if (/\.[a-z0-9]+$/i.test(req.path)) return next();

    // A client that did not ask for HTML (curl, fetch with Accept: application/json, an agent) gets
    // the JSON 404 it expects instead of a page it cannot parse.
    if (!req.accepts('html')) return next();

    if (!existsSync(INDEX_HTML)) return next();
    // `root` + a relative filename, NOT sendFile(absolutePath). `send` defaults to
    // dotfiles:'ignore' and applies that check to the whole path when no root is given — so any
    // deploy or worktree living under a dot-directory (this repo's own git worktrees live under
    // .claude/) 404s on a file that demonstrably exists. Scoping to root means the checked portion
    // is just 'index.html'. It is also the stronger form: nothing outside WEB_DIST is reachable.
    res.sendFile('index.html', { root: WEB_DIST }, (err) => {
      if (err) next(err);
    });
  };
}

/**
 * Mount static assets. No-op when there is no build: in dev Vite serves instead, and in production
 * assertWebBuildPresent has already refused to boot.
 */
export function mountWebStatic(app: Express): void {
  if (!existsSync(WEB_DIST)) return;
  app.use(
    express.static(WEB_DIST, {
      // index:false because express.static would otherwise answer `GET /` itself, silently deciding
      // who owns the root depending on mount order. spaFallback owns it, explicitly.
      index: false,
      setHeaders: (res, filePath) => {
        // Vite emits content-hashed filenames under /assets, so those are immutable and should never
        // be revalidated. This is also the mitigation for the flood shed: preAuthGuard exempts only
        // /health (csrf.ts:85), so every asset request spends one of 300/min/IP. A code-split first
  // Cache-Control: immutable on content-hashed files. Correct, but NOT for the reason the previous
  // comment gave — it claimed this mitigated the flood shed, and caching removes zero requests from a
  // COLD first load, which is the only load a first-time demo visitor performs.
  //
  // The shed arithmetic here was also wrong, and measured rather than reasoned: the build emits ONE
  // JS chunk and ONE CSS file (`grep -rn 'import(' web/src/` finds no dynamic imports), so a cold
  // load is 3 static requests plus 3 boot API calls, ~7 against preAuthGuard's 300/min/IP — about 42
  // cold loads per minute per IP, not the "~20 people behind one NAT" the plan asserted from a
  // code-split first load that does not exist.
  //
  // Worth knowing if it ever DOES fire on the JS request: the 429 is application/json with nosniff,
  // and index.html's body is only <div id="root">, so the user gets a permanently blank page with no
  // message and no retry. That is an argument for exempting /assets/ from the shed, not for the
  // caching header.
        if (filePath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          // index.html must never be cached or a deploy strands clients on old chunk names.
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );
}

/**
 * Refuse to start a non-loopback deployment with no UI build.
 *
 * Without this, a deploy whose build step did not run boots green — /health is a pure in-memory
 * response — while every page load 404s or 500s. boot.ts exists for exactly this class:
 * "configurations that are silently wrong rather than obviously off".
 *
 * Loopback is exempt because `bun run dev` legitimately has no dist (Vite serves from memory) and
 * an API-only local run is a normal thing to want.
 */
export function assertWebBuildPresent(
  // Takes a config the way assertDevAuthSafe(cfg) does, and for the same reason: with a hard
  // dependency on the module singleton the throw branch is unreachable from a test suite that runs
  // on loopback, so the gate shipped with zero coverage. CONTEXT.md 6.1 records assertDeploymentSafe
  // doing exactly this and calls it the reason a critical bug survived.
  cfg: Pick<Config, 'appBaseIsLoopback'> = config,
  // The PATH is injectable for the SAME reason, and injecting only the config was not enough —
  // that was the bug review found. With `existsSync(INDEX_HTML)` hard-wired, the throw still could
  // not be reached from a tree that has a build, so the test opened with `if (hasBuild) { return; }`
  // and asserted the inverse of its own name. Adding `bun run build:web` to the offline CI job, in
  // the same change, made a build always present there — so the branch became permanently dead.
  // Measured: replacing this function's body with `return;` left test/web-mount.test.ts green at
  // 19 pass / 0 fail. Not a second source of truth — index.ts passes neither argument.
  indexHtml: string = INDEX_HTML,
): void {
  if (cfg.appBaseIsLoopback) return;
  if (existsSync(indexHtml)) return;
  throw new Error(
    `No web build at ${WEB_DIST} (looked for index.html), and APP_BASE_URL is not loopback.\n` +
      'A deploy that skipped the UI build would boot green and 404 every page. Run `bun run build:web` ' +
      'in the build step, or set APP_BASE_URL to a loopback host for an API-only run.',
  );
}

/** True when Vite should run in-process: a genuine dev environment with no build to serve instead.
 *  Gated on isDevEnv — never a bare NODE_ENV check, per config.ts's warning that an absent NODE_ENV
 *  arrives as the string 'development' and sails through the naive form. */
export function shouldUseViteDevServer(): boolean {
  return isDevEnv(config) && !existsSync(INDEX_HTML);
}

export interface ViteDev {
  /** Vite's own middleware stack: /@vite/client, HMR, module transforms. Mount EARLY (with the
   *  static assets), because mountApi's catch-all 404 would otherwise answer these first. */
  assets: RequestHandler;
  /** Transformed index.html. Pass as mountApi's webFallback, replacing spaFallback(). */
  html: RequestHandler;
}

/**
 * Vite in MIDDLEWARE MODE, inside this Express process.
 *
 * Deliberately NOT a second server on :5173 with a proxy. APP_BASE_URL is the single source of truth
 * for four separate things — the OIDC redirect URI (config.ts derives it), the post-callback
 * redirect (routes.ts, relative), the invite acceptUrl (invites.ts:90), and csrf.ts's Origin
 * fallback — and on a second port all four still resolve to :3000. Google sign-in would land the
 * developer on the wrong port, and invite links generated in dev would point at a route that exists
 * only on the other one. Both are steps in the M5 gate, and a dev-login smoke test would catch
 * neither, because dev-login touches none of the four.
 *
 * One process, one port, one origin: `bun run dev` stays a single command and dev matches prod.
 *
 * Returns null when vite is not installed, so the API still boots for an API-only checkout.
 */
export async function createViteDev(httpServer: HttpServer): Promise<ViteDev | null> {
  let createServer: typeof import('vite').createServer;
  try {
    ({ createServer } = await import('vite'));
  } catch {
    console.warn('[web] vite is not installed — running API-only. Run `bun install` for the UI.');
    return null;
  }
  const webRoot = resolve(import.meta.dir, '../web');
  const vite = await createServer({
    root: webRoot,
    server: {
      middlewareMode: true,
      // Ride the EXISTING http server for the HMR websocket. Without this, middleware mode opens a
      // second ws server on its own port — which is a different origin, so `connect-src 'self'`
      // blocks it and HMR silently never connects. Symptom: repeated "[vite] connecting..." in the
      // console, edits never applying, and a full manual reload needed for every change. That is
      // the one capability Vite was chosen FOR, so losing it silently would have made the whole
      // middleware-mode decision pointless. Caught by editing a component and watching the page not
      // change, not by reading the config.
      hmr: { server: httpServer },
    },
    // 'custom' because Express owns routing; Vite must not install its own SPA fallback, which
    // would answer /api/* before our routes ever ran.
    appType: 'custom',
  });
  // Set before returning, so the very first response this process serves already carries the
  // dev-relaxed policy. securityHeaders is mounted app-wide and reads this per request.
  viteDevActive = true;
  return {
    assets: vite.middlewares,
    html: async (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (isServerPath(req.path)) return next();
      // Same extension guard spaFallback carries. Without it a MISSING asset in dev is answered
      // with index.html and a 200, so the browser reports a MIME/parse error rather than a 404 —
      // the exact failure spaFallback's own comment says it exists to prevent, reintroduced in the
      // half of the pair nobody reads.
      if (/\.[a-z0-9]+$/i.test(req.path)) return next();
      if (!req.accepts('html')) return next();
      try {
        const template = readFileSync(join(webRoot, 'index.html'), 'utf8');
        res
          .status(200)
          .set({ 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
          .end(await vite.transformIndexHtml(req.originalUrl, template));
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    },
  };
}
