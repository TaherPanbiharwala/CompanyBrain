import { ApiError, TransportError } from '../lib/api';

/**
 * Validate the server-supplied docs URL before it becomes an href.
 *
 * `docs` is declared on the wire and currently populated by nothing, which is exactly the shape that
 * becomes a hole quietly: the day something derives it from an op name, a slug, or a model-influenced
 * string, an unvalidated URL flows straight into href. On a cookie-authenticated origin with no CSRF
 * token and `create_invite` in the op set, a `javascript:` href would inherit full workspace
 * authority. React rejects javascript: URLs, but relying on framework behaviour for a security
 * property is the assumption the rest of this codebase deliberately refuses to make.
 */
/** Hosts a `docs` link may point at. Empty today because nothing populates `docs` yet; add a host
 *  here deliberately rather than widening the check below. */
const DOCS_HOSTS = new Set<string>([]);

function safeDocsHref(docs: string | undefined): string | null {
  if (!docs) return null;
  try {
    const u = new URL(docs, location.origin);
    // ALLOW-LIST, not `protocol === 'https:'`. The scheme check blocked javascript: and stopped
    // there, which left every https origin acceptable — so the day something derives `docs` from an
    // op name, a slug, or a model-influenced string (the scenario this function's docstring is
    // written about), `https://evil.example/reset` renders as a "Learn more" link inside the trusted
    // app shell. That is the phishing half of the same threat, not a different one.
    if (u.origin === location.origin) return u.href;
    if (u.protocol === 'https:' && DOCS_HOSTS.has(u.host)) return u.href;
    return null;
  } catch {
    return null;
  }
}

/**
 * The one error surface. Every failure in the app renders through this.
 *
 * It shows the SERVER's message and suggestion verbatim rather than mapping codes to UI copy. The
 * backend already writes remediation text for most codes, and a parallel table here would drift
 * from it without anything failing. `code` is used only to decide the affordance — which button to
 * offer — which is a UI concern the server has no opinion about.
 *
 * reqId is always visible and always copyable, including for transport failures where no server
 * response existed. That is the id the server log is keyed on.
 */
export function ErrorPanel({
  error,
  onRetry,
  showSignIn,
}: {
  error: unknown;
  onRetry?: () => void;
  /** Render the "Sign in again" link when the error is a 401.
   *
   *  A BOOLEAN, not a callback. It was typed `onSignIn?: () => void` and never invoked — the sign-in
   *  affordance is a plain <a href="/auth/google">, so the prop was only ever read for truthiness.
   *  Its one caller passed `() => undefined` on a branch where the code cannot be 'unauthenticated'
   *  (App routes that to `{state:'anon'}` before the error state is reachable), so it was a no-op
   *  callback gating an unreachable branch. Now it says what it does. */
  showSignIn?: boolean;
}) {
  const isApi = error instanceof ApiError;
  const isTransport = error instanceof TransportError;
  const message = isApi || isTransport ? error.message : String(error);
  const reqId = isApi || isTransport ? error.reqId : undefined;
  const suggestion = isApi ? error.suggestion : undefined;
  const docs = isApi ? error.docs : undefined;
  const code = isApi ? error.code : isTransport ? 'transport' : 'unknown';
  // ONCE. It was called twice — the second behind a non-null assertion that only held because the
  // first had just returned truthy. Cheap either way, but two calls to a validator is two chances
  // for them to disagree.
  const docsHref = safeDocsHref(docs);

  return (
    <div
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-faint p-4 text-sm"
    >
      <p className="font-medium text-ink">{message}</p>
      {suggestion && <p className="mt-1 text-ink-muted">{suggestion}</p>}
      {isTransport && (
        <p className="mt-1 text-ink-muted">
          The server did not respond. If you are running locally, check that <code>bun run dev</code>{' '}
          is still up.
        </p>
      )}
      {isApi && error.retryAfter !== undefined && (
        <p className="mt-1 text-ink-muted">Try again in {error.retryAfter}s.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {showSignIn && code === 'unauthenticated' && (
          <a
            href="/auth/google"
            className="rounded-sm bg-brand px-3 py-1.5 text-paper hover:bg-brand-hover"
          >
            Sign in again
          </a>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm border border-line px-3 py-1.5 hover:bg-surface"
          >
            Try again
          </button>
        )}
        {docsHref && (
          <a href={docsHref} className="text-brand underline">
            Learn more
          </a>
        )}
        {reqId && (
          <span className="ml-auto font-mono text-xs text-ink-faint">
            <span className="select-none">ref </span>
            <span className="select-all">{reqId}</span>
          </span>
        )}
      </div>
    </div>
  );
}
