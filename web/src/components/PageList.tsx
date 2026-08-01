import { useCallback, useEffect, useState } from 'react';
import { callOp, type ListPagesResult, type PageSummary } from '../lib/api';
import { ErrorPanel } from './ErrorPanel';
import { ScopeBadge } from './ScopeBadge';

const PAGE_SIZE = 25;

/**
 * Everything you can see, which is not the same as everything there is.
 *
 * `list_pages` is scoped by RLS exactly as search is, so a colleague's private page is absent here
 * for the same reason it never appears in an answer. There is deliberately NO total count — the op
 * returns `hasMore` instead — so this is a "load more" list and can never be numbered pagination.
 */
export function PageList({ reloadKey }: { reloadKey: number }) {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (offset: number) => {
    setBusy(true);
    setError(null);
    try {
      const r = await callOp<ListPagesResult>('list_pages', { limit: PAGE_SIZE, offset });
      setPages((prev) => (offset === 0 ? r.pages : [...prev, ...r.pages]));
      setHasMore(r.hasMore);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load, reloadKey]);

  if (error != null) return <ErrorPanel error={error} onRetry={() => void load(0)} showSignIn />;
  if (busy && pages.length === 0) return <p className="text-sm text-ink-faint">Loading…</p>;
  if (pages.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        Nothing here yet — anything you add will show up in this list.
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-line rounded-lg border border-line bg-paper">
        {pages.map((p) => (
          <li key={p.id} className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <span className="block truncate font-medium">{p.title ?? p.slug}</span>
              <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                <ScopeBadge scope={p.scope} />
                <span className="font-mono">{p.slug}</span>
                {p.sourceFormat && <span>{p.sourceFormat.toUpperCase()}</span>}
                {/* chunkCount 0 means the page is UNRETRIEVABLE while looking fine — the backend
                    keeps the row visible for exactly this reason, so the UI must not hide it. */}
                {p.chunkCount === 0 ? (
                  <span className="font-medium text-danger">not indexed — unsearchable</span>
                ) : (
                  <span>
                    {p.chunkCount} passage{p.chunkCount === 1 ? '' : 's'}
                  </span>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(pages.length)}
          className="mt-3 w-full rounded-sm border border-line px-3 py-2 text-sm hover:bg-surface disabled:opacity-50"
        >
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
