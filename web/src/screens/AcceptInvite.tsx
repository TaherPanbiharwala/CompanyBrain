import { useCallback, useEffect, useRef, useState } from 'react';
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
  currentWorkspace,
  onAccepted,
}: {
  /** null while the session is still being resolved. NOT a boolean, deliberately — see below. */
  signedIn: boolean | null;
  /** The workspace the user is in RIGHT NOW, if any. Accepting replaces it as active, so this screen
   *  has to name it — and it is the only thing that makes the switch back below possible without a
   *  workspace-listing endpoint (deferred to M5b: enumerating a principal's other memberships needs
   *  a SECURITY DEFINER, which is the same security question as the team keyring). */
  currentWorkspace: { id: string; name: string } | null;
  onAccepted: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [switchedBack, setSwitchedBack] = useState(false);
  const [status, setStatus] = useState<'working' | 'need-signin' | 'confirm' | 'done'>('working');
  // Accepting is single-use, so it must happen at most once. Separate from the stash effect below,
  // which is idempotent and must run immediately.
  const accepting = useRef(false);

  // STASH FIRST, on mount, before anything else can navigate. Idempotent, so StrictMode's double
  // invoke is harmless. This half must not wait for the session: if the token is still in the
  // address bar when a redirect happens, it is gone for good.
  useEffect(() => {
    const fromHash = readTokenFromHash();
    if (fromHash) {
      sessionStorage.setItem(STASH_KEY, fromHash);
      // Out of the address bar immediately. Once stashed, leaving it in location.href means any
      // error reporter, analytics call or console.log of the URL captures a live credential.
      history.replaceState(null, '', location.pathname);
    }
  }, []);

  // THEN decide, but only once the session is actually KNOWN.
  //
  // This is where the first version was wrong, and it was wrong in a way no test caught and only
  // walking the flow revealed: `signedIn` was a boolean derived from a session that starts in a
  // 'loading' state, so on first render it was false. The effect ran, concluded "not signed in",
  // and its one-shot guard stopped it ever re-running — leaving an ALREADY SIGNED IN user staring
  // at "Sign in to accept" forever, on the one screen where the credential is single-use.
  // `null` means unknown, and unknown means do nothing yet.
  useEffect(() => {
    if (signedIn === null) return;

    // ORDER MATTERS, and getting it wrong produced a bug that looked like a failure on a SUCCESS.
    // The accept deliberately clears the stashed token when it succeeds. So on the re-render that
    // success itself triggers, a token check placed before this guard finds nothing and reports
    // "this invite link is missing its token" — over the top of a membership that was just granted.
    // Once an accept has been started, this effect has nothing left to decide.
    if (accepting.current) return;

    // Not-signed-in must NOT set the guard: signedIn flips to true after the Google round trip, and
    // this effect has to be able to act on that.
    if (!signedIn) {
      // Stashed above, so it survives the trip through Google and back.
      setStatus('need-signin');
      return;
    }

    const token = sessionStorage.getItem(STASH_KEY);
    if (!token) {
      setError(new Error('This invite link is missing its token. Ask for a fresh invite.'));
      setStatus('done');
      return;
    }
    // ASK, do not act. This effect used to POST the accept right here, and that made joining a
    // workspace a zero-click consequence of opening a URL.
    //
    // Why that matters more than it looks: acceptByToken sets `active_workspace_id`, so the link did
    // not merely add a membership — it MOVED the signed-in user's active tenant. workspaces.ts names
    // this exact harm as the reason invites are token-only ("your first upload would land in their
    // tenant"), and the safeguard it describes is that the invitee must deliberately present the
    // token. Rendering the accept as an effect reduced "deliberately present" to "clicked a link".
    //
    // The full chain was real: anyone signed in can self-serve a workspace via POST /auth/workspaces,
    // name it after the target's employer, invite their address, and send the link. csrfGuard offers
    // nothing here — the POST is same-origin, issued by our own page.
    setStatus('confirm');
  }, [signedIn]);

  /** The accept itself, now reachable only from the button below. */
  const accept = useCallback(() => {
    const token = sessionStorage.getItem(STASH_KEY);
    if (!token) {
      setError(new Error('This invite link is missing its token. Ask for a fresh invite.'));
      setStatus('done');
      return;
    }
    if (accepting.current) return;
    accepting.current = true;
    setStatus('working');

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
  }, [onAccepted]);

  /** Undo. Puts the user back where they were, using the activate route that already exists.
   *
   *  This is the second half of the zero-click fix and it matters as much as the confirm step: a
   *  membership cannot be un-granted from the UI, but the thing an attacker actually gains is the
   *  ACTIVE workspace — that is what makes the next upload land in their tenant. Before this, there
   *  was no way back at all: nothing in web/ called /auth/workspaces/:id/activate, so recovery meant
   *  signing out and hoping. */
  const switchBack = useCallback(() => {
    if (!currentWorkspace) return;
    void (async () => {
      try {
        await callAuth(`/auth/workspaces/${currentWorkspace.id}/activate`);
        setSwitchedBack(true);
        location.assign('/');
      } catch (err) {
        setError(err);
      }
    })();
  }, [currentWorkspace]);

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

  if (status === 'confirm') {
    return (
      <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
        <h1 className="text-xl font-semibold tracking-tight">Join this workspace?</h1>
        <p className="mt-2 text-ink-muted">
          Someone invited you. Accepting adds you as a member and makes it your active workspace, so
          anything you upload next goes here.
        </p>
        {currentWorkspace && (
          <p className="mt-3 rounded-md border border-warn/40 bg-warn-faint p-3 text-sm">
            You are currently in <span className="font-medium">{currentWorkspace.name}</span>.
            Accepting switches you out of it.
          </p>
        )}
        <p className="mt-3 text-sm text-ink-faint">
          {/* No workspace NAME shown on purpose. Reading the invite before it is redeemed would turn
            * this screen into an oracle: anyone could probe a token and learn whether it is live and
            * which workspace it belongs to. The invite is single-use, so the honest thing to say is
            * what accepting DOES, not whose it is. */}
          Only accept if you were expecting this. If you do not recognise it, close this page — the
          invite stays unused.
        </p>
        <div className="mt-8 flex gap-3">
          <button
            type="button"
            onClick={accept}
            className="flex-1 rounded-md bg-brand px-4 py-3 font-medium text-paper hover:bg-brand-hover"
          >
            Join workspace
          </button>
          <a
            href="/"
            className="flex-1 rounded-md border border-line px-4 py-3 text-center font-medium hover:bg-surface"
          >
            Not now
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">
        {status === 'done' && error == null ? 'You\u2019ve joined' : 'Accepting your invite\u2026'}
      </h1>
      {status === 'done' && error == null && currentWorkspace && !switchedBack && (
        <div className="mt-4">
          <p className="text-ink-muted">
            This is now your active workspace. Didn&rsquo;t mean to switch?
          </p>
          <button
            type="button"
            onClick={switchBack}
            className="mt-3 rounded-md border border-line px-4 py-2 font-medium hover:bg-surface"
          >
            Switch back to {currentWorkspace.name}
          </button>
        </div>
      )}
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
