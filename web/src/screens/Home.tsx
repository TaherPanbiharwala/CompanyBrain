import { callAuth, type WhoAmI, type Workspace } from '../lib/api';

/**
 * The signed-in shell. Phase 0 ships the frame and the scope line; Phase 1 fills the body with the
 * ask/upload/pages loop.
 */
export function Home({
  who,
  workspace,
  onSignedOut,
}: {
  who: WhoAmI;
  workspace: Workspace;
  onSignedOut: () => void;
}) {
  return (
    <div className="min-h-full">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-3">
          <span className="font-semibold tracking-tight">company-brain</span>
          <span className="text-ink-faint">/</span>
          <span className="text-ink-muted">{workspace.name}</span>
          <button
            type="button"
            onClick={async () => {
              await callAuth('/auth/logout').catch(() => undefined);
              onSignedOut();
            }}
            className="ml-auto text-sm text-ink-muted underline hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">
          Ask {workspace.name} a question
        </h1>

        <ScopeLine workspace={workspace} grants={who.grants} />

        <div className="mt-8 rounded-lg border border-dashed border-line bg-surface p-10 text-center">
          <p className="text-ink-muted">
            The ask and upload surfaces land in the next phase.
          </p>
          <p className="mt-2 text-sm text-ink-faint">
            Signed in as <span className="font-mono">{who.principal.slice(0, 8)}</span> &middot;{' '}
            {who.role}
          </p>
        </div>
      </main>
    </div>
  );
}

/**
 * The permanent scope line.
 *
 * This replaces the "N results hidden from you" banner the design amendments originally asked for.
 * That banner could not be built — no endpoint returns a filtered count, and `list_pages` documents
 * that an empty result means "no more from here", not "the workspace is empty" — and it should not
 * be built, because a count of what you cannot see leaks the existence and volume of private
 * content.
 *
 * Stating the boundary declaratively instead is always true, leaks nothing, and turns an occasional
 * alarm into a fact the user learns once. It is also the control that grows: when team scope lands,
 * this becomes "… + Engineering, Sales" with no redesign, which is what amendment A4 asked for when
 * it said the scope menu has to grow to teams.
 *
 * Derived from the real keyring (`whoami.grants`) rather than assumed, so it cannot claim access the
 * request context does not actually carry.
 */
function ScopeLine({ workspace, grants }: { workspace: Workspace; grants: string[] }) {
  const teams = grants.filter((g) => g.startsWith('team:'));
  return (
    <p className="mt-2 text-sm text-ink-muted">
      Searching everything you can see: your private pages + everyone at {workspace.name}
      {teams.length > 0 && <> + {teams.length} team{teams.length === 1 ? '' : 's'}</>}.
    </p>
  );
}
