import { useCallback, useEffect, useState } from 'react';
import { callOp, type BatchPageOutcome, type ListPagesResult, type PageSummary } from '../lib/api';
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
  // Selection, and the two things you can do with it. Until this existed the app had NO delete
  // affordance at all — recovering from a bad upload meant one curl per page — and scope was fixed
  // at ingest forever, because replace_page refuses any page created from a file.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [acting, setActing] = useState(false);
  const [report, setReport] = useState<BatchPageOutcome[] | null>(null);

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

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /** Runs a batch op and keeps only the outcomes worth reading. A partial-success envelope is the
   *  point of these ops: 3 pages you did not author must not stop the other 247, and burying that in
   *  a generic error would send the user back to retry the whole thing. */
  async function runBatch(op: 'delete' | 'private' | 'workspace') {
    const pageIds = [...selected];
    if (op === 'delete') {
      // Irreversible, no trash, and the stored original file is the last copy. A confirm is the
      // cheapest thing standing between a misclick and unrecoverable loss.
      const n = pageIds.length;
      if (!confirm(`Delete ${n} page${n === 1 ? '' : 's'} permanently? This cannot be undone.`)) return;
    }
    setActing(true);
    setError(null);
    setReport(null);
    try {
      const r =
        op === 'delete'
          ? await callOp<{ outcomes: BatchPageOutcome[] }>('delete_page', { pageIds })
          : await callOp<{ outcomes: BatchPageOutcome[] }>('rescope_pages', { pageIds, scope: op });
      setSelected(new Set());
      setReport(r.outcomes.filter((o) => !o.ok));
      await load(0);
    } catch (err) {
      setError(err);
    } finally {
      setActing(false);
    }
  }

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
      {/* The selection bar only exists while something is selected. A permanently-visible row of
          destructive buttons over a document list is how people delete things they meant to keep. */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-sm border border-line bg-surface px-3 py-2 text-sm">
          <span className="font-medium">
            {selected.size} selected
          </span>
          <span className="flex-1" />
          <button
            type="button"
            disabled={acting}
            onClick={() => void runBatch('private')}
            className="rounded-sm border border-line px-2 py-1 text-xs hover:bg-paper disabled:opacity-50"
          >
            Make private
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={() => void runBatch('workspace')}
            className="rounded-sm border border-line px-2 py-1 text-xs hover:bg-paper disabled:opacity-50"
          >
            Share with workspace
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={() => void runBatch('delete')}
            className="rounded-sm border border-danger px-2 py-1 text-xs text-danger hover:bg-paper disabled:opacity-50"
          >
            {acting ? 'Working…' : 'Delete'}
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={() => setSelected(new Set())}
            className="px-2 py-1 text-xs text-ink-faint hover:underline disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      )}

      {/* Only the REFUSALS. Listing every success would bury the three lines that need reading. */}
      {report != null && report.length > 0 && (
        <div className="mb-3 rounded-sm border border-line bg-surface px-3 py-2 text-sm">
          <p className="font-medium">
            {report.length} page{report.length === 1 ? ' was' : 's were'} left alone:
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-faint">
            {report.map((o) => (
              <li key={o.pageId}>
                <span className="font-mono">{o.slug ?? o.pageId}</span> — {o.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="divide-y divide-line rounded-lg border border-line bg-paper">
        {pages.map((p) => (
          <li key={p.id} className="flex items-start gap-3 p-3">
            <input
              type="checkbox"
              checked={selected.has(p.id)}
              onChange={() => toggle(p.id)}
              aria-label={`Select ${p.title ?? p.slug}`}
              className="mt-1 shrink-0"
            />
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
