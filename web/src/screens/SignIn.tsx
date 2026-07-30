import { useState } from 'react';
import { callAuth, ApiError } from '../lib/api';
import { ErrorPanel } from '../components/ErrorPanel';

/**
 * The unauthenticated landing surface.
 *
 * Google is the only way in on a deployed instance — dev-login is gated to loopback by five separate
 * checks in src/api/dev-auth.ts, so it cannot be reached in production even if the env said
 * otherwise. The dev-login form below therefore renders only when the server told us it is
 * available, rather than being conditioned on anything this bundle can decide for itself.
 */
export function SignIn({ devLoginAvailable, onSignedIn }: { devLoginAvailable: boolean; onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function devLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callAuth('/auth/dev-login', { email });
      onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  // Round-trips through the server so the session is established before the SPA loads. `return_to`
  // must be root-relative — safeReturnTo in src/auth/google.ts rejects anything else, which is what
  // stops this being an open redirect.
  const googleHref = `/auth/google?return_to=${encodeURIComponent(location.pathname + location.search)}`;

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-[--text-2xl] font-semibold tracking-tight">company-brain</h1>
      <p className="mt-2 text-[--color-ink-muted]">
        Ask your company&rsquo;s documents a question. Every answer cites its sources, and you only
        ever see what you are allowed to see.
      </p>

      <a
        href={googleHref}
        className="mt-8 flex items-center justify-center rounded-[--radius-md] bg-[--color-brand] px-4 py-3 font-medium text-[--color-paper] hover:bg-[--color-brand-hover]"
      >
        Continue with Google
      </a>

      {devLoginAvailable && (
        <form onSubmit={devLogin} className="mt-8 border-t border-[--color-line] pt-6">
          <label htmlFor="dev-email" className="block text-[--text-sm] font-medium">
            Local development sign-in
          </label>
          <p className="mt-1 text-[--text-xs] text-[--color-ink-faint]">
            Loopback only. This form is not reachable on a deployed instance.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              id="dev-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="flex-1 rounded-[--radius-sm] border border-[--color-line] bg-[--color-paper] px-3 py-2"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-[--radius-sm] border border-[--color-line] px-3 py-2 hover:bg-[--color-surface] disabled:opacity-50"
            >
              {busy ? '…' : 'Sign in'}
            </button>
          </div>
        </form>
      )}

      {error != null && (
        <div className="mt-6">
          <ErrorPanel
            error={error}
            onRetry={
              error instanceof ApiError && error.code === 'rate_limited' ? undefined : () => setError(null)
            }
          />
        </div>
      )}
    </main>
  );
}
