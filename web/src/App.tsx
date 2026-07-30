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
 *  table grows past this, add it deliberately rather than by default. */
function useRoute(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const path = useRoute();

  const load = useCallback(async () => {
    setSession({ state: 'loading' });
    try {
      const who = await callOp<WhoAmI>('whoami');
      const workspace = await callOp<Workspace>('get_workspace');
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
        signedIn={session.state === 'ready' || session.state === 'no-workspace'}
        onAccepted={() => {
          history.replaceState(null, '', '/');
          void load();
        }}
      />
    );
  }

  switch (session.state) {
    case 'loading':
      return (
        <main className="flex min-h-full items-center justify-center">
          <p className="text-[--color-ink-faint]">Loading…</p>
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
          <h1 className="text-[--text-xl] font-semibold">Something went wrong</h1>
          <div className="mt-6">
            <ErrorPanel
              error={session.error}
              onRetry={load}
              onSignIn={session.error instanceof ApiError ? () => undefined : undefined}
            />
          </div>
          {session.error instanceof TransportError && (
            <p className="mt-4 text-[--text-sm] text-[--color-ink-muted]">
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
