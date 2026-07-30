import { ApiError, TransportError } from '../lib/api';

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
  onSignIn,
}: {
  error: unknown;
  onRetry?: () => void;
  onSignIn?: () => void;
}) {
  const isApi = error instanceof ApiError;
  const isTransport = error instanceof TransportError;
  const message = isApi || isTransport ? error.message : String(error);
  const reqId = isApi || isTransport ? error.reqId : undefined;
  const suggestion = isApi ? error.suggestion : undefined;
  const docs = isApi ? error.docs : undefined;
  const code = isApi ? error.code : isTransport ? 'transport' : 'unknown';

  return (
    <div
      role="alert"
      className="rounded-[--radius-md] border border-[--color-danger]/30 bg-[--color-danger-faint] p-4 text-[--text-sm]"
    >
      <p className="font-medium text-[--color-ink]">{message}</p>
      {suggestion && <p className="mt-1 text-[--color-ink-muted]">{suggestion}</p>}
      {isTransport && (
        <p className="mt-1 text-[--color-ink-muted]">
          The server did not respond. If you are running locally, check that <code>bun run dev</code>{' '}
          is still up.
        </p>
      )}
      {isApi && error.retryAfter !== undefined && (
        <p className="mt-1 text-[--color-ink-muted]">Try again in {error.retryAfter}s.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {onSignIn && code === 'unauthenticated' && (
          <a
            href="/auth/google"
            className="rounded-[--radius-sm] bg-[--color-brand] px-3 py-1.5 text-[--color-paper] hover:bg-[--color-brand-hover]"
          >
            Sign in again
          </a>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-[--radius-sm] border border-[--color-line] px-3 py-1.5 hover:bg-[--color-surface]"
          >
            Try again
          </button>
        )}
        {docs && (
          <a href={docs} className="text-[--color-brand] underline">
            Learn more
          </a>
        )}
        {reqId && (
          <span className="ml-auto font-mono text-[--text-xs] text-[--color-ink-faint]">
            <span className="select-none">ref </span>
            <span className="select-all">{reqId}</span>
          </span>
        )}
      </div>
    </div>
  );
}
