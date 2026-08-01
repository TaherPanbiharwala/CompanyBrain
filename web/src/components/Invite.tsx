import { useState } from 'react';
import { callOp, type Workspace } from '../lib/api';
import { ErrorPanel } from './ErrorPanel';

interface InviteCreated {
  inviteId: string;
  token: string;
  acceptUrl: string;
  expiresAt: string;
}

/**
 * Invite someone to this workspace.
 *
 * Admin-only, and the tab is hidden entirely for members rather than shown and 403'd — advertising
 * a control the caller cannot use is how a UI teaches people to distrust it.
 *
 * THE HARD PART IS THE HAND-OFF, not the form. `create_invite` returns the accept URL exactly once:
 * the token is stored only as a SHA-256 hash, so there is no "show it again" and no recovery. If the
 * admin navigates away before copying it, the invite is dead and has to be reissued. That moment is
 * the weakest step in the whole demo path, so it gets the most deliberate treatment on this screen.
 */
export function Invite({ workspace }: { workspace: Workspace }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<InviteCreated | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCreated(await callOp<InviteCreated>('create_invite', { email: email.trim(), role }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (created) return <InviteLink invite={created} email={email} onAnother={() => { setCreated(null); setEmail(''); }} />;

  return (
    <div>
      <DomainNote workspace={workspace} />

      <form onSubmit={submit} className="mt-4 rounded-lg border border-line bg-surface p-5">
        <h2 className="font-medium">Invite someone by email</h2>
        <p className="mt-1 text-sm text-ink-muted">
          For people outside your company domain — a contractor, an advisor, a design partner.
        </p>

        <label htmlFor="inv-email" className="mt-4 block text-sm font-medium">
          Their email
        </label>
        <input
          id="inv-email"
          type="email"
          required
          maxLength={320}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="someone@example.com"
          className="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2"
        />
        <p className="mt-1 text-xs text-ink-faint">
          The invite only works for this exact address — whoever opens the link has to sign in as
          them. That is what stops a forwarded link becoming a way in.
        </p>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Their role</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(
              [
                { v: 'member', label: 'Member', hint: 'Read and add documents' },
                { v: 'admin', label: 'Admin', hint: 'Also invites other people' },
              ] as const
            ).map((o) => (
              <button
                key={o.v}
                type="button"
                aria-pressed={role === o.v}
                onClick={() => setRole(o.v)}
                className={
                  role === o.v
                    ? 'rounded-md border-2 border-brand bg-brand-faint p-3 text-left'
                    : 'rounded-md border border-line bg-paper p-3 text-left hover:bg-surface'
                }
              >
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="mt-0.5 block text-xs text-ink-faint">{o.hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={busy || email.trim().length === 0}
          className="mt-4 w-full rounded-md bg-brand px-4 py-3 font-medium text-paper hover:bg-brand-hover disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create invite link'}
        </button>

        {error != null && (
          <div className="mt-4">
            <ErrorPanel error={error} onRetry={() => setError(null)} showSignIn />
          </div>
        )}
      </form>
    </div>
  );
}

/**
 * The easier path, surfaced BEFORE the form.
 *
 * If the workspace has claimed a company domain, colleagues need no invite at all — they sign in
 * with their work Google account and `resolveWorkspace` adds them on first login. Most admins will
 * not know that, and will send links one at a time forever. Saying it here is worth more than any
 * link-sharing feature.
 *
 * Deliberately not phrased as though the claim is guaranteed: claiming a domain requires a verified
 * Google Workspace `hd` on the session that created the workspace, and public domains like gmail.com
 * are blocked from claiming at all — otherwise the first Gmail user would auto-join every Gmail user
 * on the planet.
 */
function DomainNote({ workspace }: { workspace: Workspace }) {
  return (
    <div className="rounded-lg border border-line bg-brand-faint p-4">
      <h2 className="text-sm font-medium">Colleagues may not need an invite</h2>
      <p className="mt-1 text-sm text-ink-muted">
        If {workspace.name} has claimed your company&rsquo;s email domain, anyone signing in with a
        work Google account at that domain joins automatically — no link to send, and nothing that
        can be forwarded to the wrong person. Invites below are for everyone else.
      </p>
    </div>
  );
}

/**
 * The one-time link.
 *
 * Shown once because it can only be shown once — the server keeps a hash, not the token. So this
 * screen has to make the stakes obvious BEFORE the admin clicks away, not explain them afterwards.
 */
function InviteLink({
  invite,
  email,
  onAnother,
}: {
  invite: InviteCreated;
  email: string;
  onAnother: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    try {
      // Requires a secure context: fine on https and on localhost, and those are the only two
      // places this app runs. If it is ever blocked, the input below is still selectable — hence
      // the explicit fallback message rather than a silently dead button.
      await navigator.clipboard.writeText(invite.acceptUrl);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="rounded-lg border-2 border-brand bg-surface p-5">
      <h2 className="font-medium">Invite created for {email}</h2>

      <div
        role="alert"
        className="mt-3 rounded-md border border-warn/40 bg-warn-faint p-3 text-sm"
      >
        <span className="font-medium">Copy this link now — it is shown only once.</span> The server
        stores a hash of it, not the link itself, so it cannot be shown again. If you leave this
        screen without copying it, create a new invite instead.
      </div>

      <label htmlFor="inv-url" className="mt-4 block text-sm font-medium">
        Send them this link
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="inv-url"
          readOnly
          value={invite.acceptUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-sm border border-line bg-paper px-3 py-2 font-mono text-xs"
        />
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-sm bg-brand px-3 py-2 text-sm font-medium text-paper hover:bg-brand-hover"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copyFailed && (
        <p className="mt-1 text-xs text-danger">
          Could not reach the clipboard. Select the text above and copy it manually.
        </p>
      )}

      <p className="mt-3 text-sm text-ink-muted">
        Send it however you normally reach them — this app does not send email yet. It expires{' '}
        {new Date(invite.expiresAt).toLocaleDateString()}, works once, and only for {email}.
      </p>

      <button
        type="button"
        onClick={onAnother}
        className="mt-4 rounded-sm border border-line px-3 py-1.5 text-sm hover:bg-paper"
      >
        Invite someone else
      </button>
    </div>
  );
}
