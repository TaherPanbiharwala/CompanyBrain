import { useCallback, useEffect, useState } from 'react';
import { ApiError, TransportError, callOp, type WhoAmI, type Workspace } from './lib/api';
import { ErrorPanel } from './components/ErrorPanel';
import { SignIn } from './screens/SignIn';
import { CreateWorkspace } from './screens/CreateWorkspace';
import { AcceptInvite } from './screens/AcceptInvite';
import { Home } from './screens/Home';

/**
 * Session state, derived from the server rather than guessed at.
 *
 * There is no client-readable session cookie to inspect — it is httpOnly, which is the point — so
 * the only honest way to know where the user stands is to call whoami and read the outcome:
 *
 *   200                  -> signed in, in a workspace
 *   401 unauthenticated  -> not signed in
 *   400 no_workspace     -> signed in, nowhere to act yet (an ONBOARDING state, not an error)
 */
type Session =
  | { state: 'loading' }
  | { state: 'anon' }
  | { state: 'no-workspace' }
  | { state: 'ready'; who: WhoAmI; workspace: Workspace }
  | { state: 'error'; error: unknown };

/** Tiny path switch. react-router would be a fourth dependency tree for four routes; when the route
 *  table grows past this, add it deliberately rather than by default.
 *
 *  Returns a `navigate` alongside the path because `history.pushState`/`replaceState` DO NOT fire
 *  `popstate` — that event is for back/forward only. Without this, code that changed the URL
 *  programmatically left the router showing the previous screen: after accepting an invite the URL
 *  read `/` while the invite screen was still mounted. */
function useRoute(): [string, (to: string, opts?: { replace?: boolean }) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  // The MODE is a parameter, because replaceState is right for exactly one caller and wrong as a
  // default. Post-accept must replace (Back must not return to a consumed invite); anything else
  // added later wants a real history entry, and inheriting replace semantics silently is how a
  // router acquires behaviour nobody chose.
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
    setPath(to);
  }, []);
  return [path, navigate];
}

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [path, navigate] = useRoute();

  const load = useCallback(async () => {
    setSession({ state: 'loading' });
    try {
      // Promise.all, not two awaits. Neither call's params derive from the other's result, so the
      // sequential form serialised two full round trips behind the "Loading…" screen — and each is
      // not cheap server-side: resolveSessionContext does a lookup, then dispatchOp opens a scoped
      // transaction (BEGIN + set_config + query + COMMIT). ~10 database round trips before first
      // paint instead of ~5, on the first thing every visitor sees.
      //
      // Promise.all rejects with the FIRST rejection, which is the same ApiError the catch below
      // already keys on, so the unauthenticated and no_workspace lanes are unchanged.
      const [who, workspace] = await Promise.all([
        callOp<WhoAmI>('whoami'),
        callOp<Workspace>('get_workspace'),
      ]);
      setSession({ state: 'ready', who, workspace });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthenticated') {
        setSession({ state: 'anon' });
        return;
      }
      if (err instanceof ApiError && err.code === 'no_workspace') {
        setSession({ state: 'no-workspace' });
        return;
      }
      setSession({ state: 'error', error: err });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The invite route is handled before the session gate: a recipient who is not signed in still
  // needs this screen, because it is what stashes the fragment token before sending them to Google.
  if (path === '/invites/accept') {
    return (
      <AcceptInvite
        // null while loading — NOT false. A boolean here reads as "not signed in" during the very
        // first render, and AcceptInvite acts on it once and never revisits, stranding a signed-in
        // user on the sign-in prompt with a single-use token.
        signedIn={
          session.state === 'loading'
            ? null
            : session.state === 'ready' || session.state === 'no-workspace'
        }
        // The workspace accepting will REPLACE as active. Named on the confirm screen and used for
        // the switch-back, so an unintended accept is recoverable without signing out.
        currentWorkspace={
          session.state === 'ready'
            ? { id: session.workspace.id, name: session.workspace.name }
            : null
        }
        onAccepted={() => {
          // navigate(), not a bare replaceState: that changes the URL without telling the router,
          // so the invite screen stayed mounted over a workspace the user had just joined.
          // replace: the invite token is consumed, so Back must not return to this screen.
          navigate('/', { replace: true });
          void load();
        }}
      />
    );
  }

  switch (session.state) {
    case 'loading':
      return (
        <main className="flex min-h-full items-center justify-center">
          <p className="text-ink-faint">Loading…</p>
        </main>
      );

    case 'anon':
      // dev-login is loopback-gated server-side; showing the form off-loopback would advertise a
      // route that returns 404 there.
      return <SignIn devLoginAvailable={isLoopback()} onSignedIn={load} />;

    case 'no-workspace':
      return <CreateWorkspace onReady={load} />;

    case 'ready':
      return <Home who={session.who} workspace={session.workspace} onSignedOut={load} />;

    case 'error':
      return (
        <main className="mx-auto max-w-md px-6 py-16">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <div className="mt-6">
            <ErrorPanel
              error={session.error}
              onRetry={load}
              showSignIn
            />
          </div>
          {session.error instanceof TransportError && (
            <p className="mt-4 text-sm text-ink-muted">
              If you are running this locally, the API may not be up.
            </p>
          )}
        </main>
      );
  }
}

function isLoopback(): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
}
