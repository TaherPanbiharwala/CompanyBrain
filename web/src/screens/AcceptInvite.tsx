import { useEffect, useRef, useState } from 'react';
import { callAuth } from '../lib/api';
import { ErrorPanel } from '../components/ErrorPanel';

/**
 * `/invites/accept#token=…`
 *
 * The token arrives in the URL FRAGMENT, which is a deliberate server-side choice: a fragment is
 * never sent to a server, so the token stays out of access logs, proxy logs, browser history sent
 * upstream, and the Referer header of anything the page later loads. src/auth/invites.ts builds the
 * URL that way on purpose, and this screen is the other half of that decision.
 *
 * THE BUG THIS SCREEN EXISTS TO NOT HAVE: the recipient of an invite is, in the normal case, not
 * signed in yet. Reading the fragment and then redirecting to /auth/google drops it — fragments do
 * not survive that navigation — and the invite is unrecoverable because the token was shown exactly
 * once. So the token is stashed BEFORE any redirect and re-read after the round trip.
 *
 * sessionStorage, not localStorage: it should not outlive the tab. It is cleared the moment it has
 * been used or has failed.
 */
const STASH_KEY = 'cb.invite.token';

function readTokenFromHash(): string | null {
  // location.hash is '#token=abc'. Parse it as URL params rather than splitting on '=' so a token
  // containing '=' (base64url does not produce one, but the parser should not care) survives.
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const token = new URLSearchParams(raw).get('token');
  return token && token.length > 0 ? token : null;
}

export function AcceptInvite({
  signedIn,
  onAccepted,
}: {
  signedIn: boolean;
  onAccepted: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<'working' | 'need-signin' | 'done'>('working');
  // Effects run twice under React StrictMode in dev. Accepting an invite is single-use, so the
  // second run would consume the already-consumed token and render a spurious "invite_invalid".
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const fromHash = readTokenFromHash();
    if (fromHash) {
      sessionStorage.setItem(STASH_KEY, fromHash);
      // Get it out of the address bar immediately. Once stashed, leaving it in location.href means
      // any error reporter, analytics call or console.log of the URL captures a live credential.
      history.replaceState(null, '', location.pathname);
    }
    const token = fromHash ?? sessionStorage.getItem(STASH_KEY);

    if (!token) {
      setError(new Error('This invite link is missing its token. Ask for a fresh invite.'));
      setStatus('done');
      return;
    }
    if (!signedIn) {
      // Stashed above, so it survives the trip through Google and back.
      setStatus('need-signin');
      return;
    }

    void (async () => {
      try {
        await callAuth('/auth/invites/accept', { token });
        sessionStorage.removeItem(STASH_KEY);
        setStatus('done');
        onAccepted();
      } catch (err) {
        // Clear on failure too. The token is single-use and a wrong/expired/consumed one will never
        // start working, so keeping it would retry a dead credential on every future page load.
        sessionStorage.removeItem(STASH_KEY);
        setError(err);
        setStatus('done');
      }
    })();
  }, [signedIn, onAccepted]);

  if (status === 'need-signin') {
    return (
      <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
        <h1 className="text-xl font-semibold tracking-tight">You&rsquo;ve been invited</h1>
        <p className="mt-2 text-ink-muted">
          Sign in to accept. We&rsquo;ll hold onto the invite while you do.
        </p>
        <a
          href={`/auth/google?return_to=${encodeURIComponent('/invites/accept')}`}
          className="mt-8 flex items-center justify-center rounded-md bg-brand px-4 py-3 font-medium text-paper hover:bg-brand-hover"
        >
          Continue with Google
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">Accepting your invite…</h1>
      {error != null && (
        <div className="mt-6">
          <ErrorPanel error={error} />
          <p className="mt-4 text-sm text-ink-muted">
            Invite links are single-use and expire. If this one has been used or has run out, ask
            whoever invited you to send a new one.
          </p>
          <a href="/" className="mt-4 inline-block text-brand underline">
            Go to the app
          </a>
        </div>
      )}
    </main>
  );
}
