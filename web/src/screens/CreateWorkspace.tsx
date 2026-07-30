import { useState } from 'react';
import { callAuth } from '../lib/api';
import { ErrorPanel } from '../components/ErrorPanel';

/**
 * The `no_workspace` surface.
 *
 * This is an ONBOARDING STATE, not an error, and getting that wrong is the most likely way to make
 * a first sign-in feel broken. The server is explicit about it: a valid session with no active
 * workspace returns 400 `no_workspace` from /api/:op — deliberately not a 401 — because the session
 * is fine and the user simply has nowhere to act yet. A fresh principal lands here BY DESIGN.
 *
 * Two ways out, and both are real: create a workspace, or accept an invite someone sent you. The
 * invite path is not a footnote — for everyone except the first person at a company it is the
 * normal one.
 */
export function CreateWorkspace({ onReady }: { onReady: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // `domain` is deliberately NOT sent. Claiming a domain requires a verified Google `hd` on
      // this very session, and dev-login has none — sending it would 400 domain_not_verified on the
      // most common local path. Domain claiming belongs in workspace settings, with the check
      // explained, not silently attached to workspace creation.
      await callAuth('/auth/workspaces', { name: name.trim() });
      onReady();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-[--text-xl] font-semibold tracking-tight">Name your workspace</h1>
      <p className="mt-2 text-[--color-ink-muted]">
        A workspace holds your documents and the people who can read them. You can invite colleagues
        once it exists.
      </p>

      <form onSubmit={create} className="mt-8">
        <label htmlFor="ws-name" className="block text-[--text-sm] font-medium">
          Workspace name
        </label>
        <input
          id="ws-name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme"
          className="mt-2 w-full rounded-[--radius-sm] border border-[--color-line] bg-[--color-paper] px-3 py-2"
        />
        <button
          type="submit"
          disabled={busy || name.trim().length === 0}
          className="mt-4 w-full rounded-[--radius-md] bg-[--color-brand] px-4 py-3 font-medium text-[--color-paper] hover:bg-[--color-brand-hover] disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </form>

      <p className="mt-6 text-[--text-sm] text-[--color-ink-muted]">
        Been invited to one instead? Open the invite link you were sent — it will add you to that
        workspace.
      </p>

      {error != null && (
        <div className="mt-6">
          <ErrorPanel error={error} onRetry={() => setError(null)} />
        </div>
      )}
    </main>
  );
}
