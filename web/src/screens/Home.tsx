import { useCallback, useEffect, useState } from 'react';
import {
  callAuth,
  callOp,
  type AskResult,
  type ListPagesResult,
  type WhoAmI,
  type Workspace,
} from '../lib/api';
import { ErrorPanel } from '../components/ErrorPanel';
// The SERVER's role model, not a second opinion. `role === 'admin' || role === 'owner'` re-expressed
// the owner ⊃ admin ⊃ member hierarchy that src/api/roles.ts owns — the same class as the grant-tag
// regex this repo pins across three files. Add a fourth role, or change which role may invite, and a
// hand-written check fails by silently showing or hiding a tab rather than by throwing.
import { hasRole } from '../../../src/api/roles';
import { AnswerView } from '../components/AnswerView';
import { Upload } from '../components/Upload';
import { PageList } from '../components/PageList';
import { Invite } from '../components/Invite';

type Tab = 'ask' | 'add' | 'pages' | 'invite';

export function Home({
  who,
  workspace,
  onSignedOut,
}: {
  who: WhoAmI;
  workspace: Workspace;
  onSignedOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>('ask');
  // Bumped after an upload so the page list refetches rather than showing a stale count.
  const [reloadKey, setReloadKey] = useState(0);
  // null = not yet known. Drives the cold start, so it must not guess "empty" before asking.
  const [isEmpty, setIsEmpty] = useState<boolean | null>(null);

  const checkEmpty = useCallback(async () => {
    try {
      const r = await callOp<ListPagesResult>('list_pages', { limit: 1 });
      setIsEmpty(r.pages.length === 0);
    } catch {
      // A failure here is not worth surfacing — it only decides which empty state to show, and the
      // real error will surface on the next real action.
      setIsEmpty(false);
    }
  }, []);

  // Mount only. reloadKey is bumped by Upload's onDone, which now sets isEmpty directly — see there.
  useEffect(() => {
    void checkEmpty();
  }, [checkEmpty]);

  return (
    <div className="min-h-full">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-3">
          <span className="font-semibold tracking-tight">company-brain</span>
          <span className="text-ink-faint">/</span>
          <span className="truncate text-ink-muted">{workspace.name}</span>
          <button
            type="button"
            onClick={async () => {
              await callAuth('/auth/logout').catch(() => undefined);
              onSignedOut();
            }}
            className="ml-auto shrink-0 text-sm text-ink-muted underline hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <nav className="flex gap-1 rounded-md bg-surface-sunk p-1 text-sm" role="tablist">
          {(
            [
              ['ask', 'Ask'],
              ['add', 'Add a document'],
              ['pages', 'Everything you can see'],
              // Admin-only. HIDDEN for members rather than shown and 403'd — create_invite is
              // requiredRole:'admin', and advertising a control the caller cannot use teaches people
              // to distrust the rest of the interface.
              ...(hasRole(who.role, 'admin')
                ? ([['invite', 'Invite someone']] as const)
                : ([] as const)),
            ] as ReadonlyArray<readonly [Tab, string]>
          ).map(([v, label]) => (
            <button
              key={v}
              role="tab"
              aria-selected={tab === v}
              onClick={() => setTab(v)}
              className={
                tab === v
                  ? 'rounded-sm bg-paper px-3 py-1.5 font-medium'
                  : 'rounded-sm px-3 py-1.5 text-ink-muted hover:text-ink'
              }
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-6">
          {tab === 'ask' &&
            (isEmpty ? (
              <ColdStart onAdd={() => setTab('add')} />
            ) : (
              <Ask workspace={workspace} grants={who.grants} />
            ))}
          {tab === 'add' && (
            <Upload
              workspace={workspace}
              onDone={() => {
                // An upload proves the corpus is non-empty, so checkEmpty() can no longer return
                // true — asking again is a round trip whose answer is already known.
                setIsEmpty(false);
                setReloadKey((k) => k + 1);
              }}
            />
          )}
          {/* HIDDEN, not unmounted. `{tab === 'pages' && <PageList/>}` destroyed all of PageList's
            * accumulated state on every tab switch: a user who clicked "Load more" four times (100
            * pages, 4 requests) and glanced at Ask lost all of it and paid the round trip again on
            * return. The list is cheap to keep mounted and expensive to rebuild. */}
          <div className={tab === 'pages' ? '' : 'hidden'}>
            <PageList reloadKey={reloadKey} />
          </div>
          {tab === 'invite' && <Invite workspace={workspace} />}
        </div>
      </main>
    </div>
  );
}

/**
 * The empty brain.
 *
 * A DROP ZONE, not sample questions. Suggesting questions against an empty corpus guarantees that
 * the very first interaction with the product is a failed search — the opposite of the intended
 * aha. Sample questions belong after the first document exists, generated from it, so the first
 * question is guaranteed to have an answer.
 */
function ColdStart({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface p-10 text-center">
      <h2 className="font-medium">Your brain is empty</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
        Add a document first — a policy, a spec, a set of meeting notes. Then you can ask questions
        about it and every answer will cite the exact passage it came from.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-5 rounded-md bg-brand px-4 py-2.5 font-medium text-paper hover:bg-brand-hover"
      >
        Add your first document
      </button>
    </div>
  );
}

function Ask({ workspace, grants }: { workspace: Workspace; grants: string[] }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<AskResult | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await callOp<AskResult>('ask', { question: question.trim() }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={ask}>
        <label htmlFor="q" className="sr-only">
          Your question
        </label>
        <textarea
          id="q"
          rows={3}
          maxLength={2000}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits, Shift+Enter is a newline — the convention for a chat-shaped input.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(e as unknown as React.FormEvent);
            }
          }}
          placeholder="What does our refund policy say about partial months?"
          className="w-full rounded-md border border-line bg-paper px-3 py-2"
        />
        <ScopeLine workspace={workspace} grants={grants} />
        <button
          type="submit"
          disabled={busy || question.trim().length === 0}
          className="mt-3 rounded-md bg-brand px-4 py-2.5 font-medium text-paper hover:bg-brand-hover disabled:opacity-50"
        >
          {busy ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {error != null && (
        <div className="mt-4">
          <ErrorPanel error={error} onRetry={() => setError(null)} showSignIn />
        </div>
      )}

      {result && <AnswerView result={result} />}
    </div>
  );
}

/**
 * The permanent scope line — see docs/screens.md.
 *
 * Replaces the "N results hidden from you" banner that could not be built (no endpoint returns a
 * filtered count) and should not be (a count of what you cannot see leaks the volume of private
 * content). Declarative, always true, and it grows to "… + Engineering, Sales" when team scope
 * lands without a redesign.
 *
 * Derived from the real keyring, so it cannot claim access the request context does not carry.
 */
function ScopeLine({ workspace, grants }: { workspace: Workspace; grants: string[] }) {
  const teams = grants.filter((g) => g.startsWith('team:'));
  return (
    <p className="mt-2 text-xs text-ink-faint">
      Searching everything you can see: your private pages + everyone at {workspace.name}
      {teams.length > 0 && (
        <>
          {' '}
          + {teams.length} team{teams.length === 1 ? '' : 's'}
        </>
      )}
      .
    </p>
  );
}
