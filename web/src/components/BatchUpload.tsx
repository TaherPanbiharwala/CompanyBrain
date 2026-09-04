import { useEffect, useRef, useState } from 'react';
import { callOp, ApiError, type BatchFileOutcome, type IngestFilesResult } from '../lib/api';
import { ErrorPanel } from './ErrorPanel';
import { MAX_FILE_BYTES, toBase64, slugFromTitle, type Scope } from './Upload';

/** Matches BATCH_INGEST_CONCURRENCY server-side (src/ingest/batch.ts). The client submits
 *  `ingest_files` calls in chunks of this size, ONE chunk-request in flight at a time — never two
 *  concurrently. Two reasons, not one: `apiLimiter` (src/auth/ratelimit.ts) charges one hit per
 *  dispatchOp call regardless of how many files it carries, so a chunk of 3 costs 1 hit against the
 *  same 120/min budget every other op shares, where 3 individual ingest_file calls would cost 3 — a
 *  straight 3x reduction with no responsiveness cost, since server-side concurrency for one chunk
 *  already matches what 3 concurrent individual calls would achieve. And one chunk-request at a time
 *  means this client never asks the shared, process-global extraction admission gate
 *  (src/ingest/extract/index.ts, MAX_CONCURRENT=6) for more than 3 of its 6 slots at once — leaving
 *  room for every other concurrent user, the same principle the server's own concurrency cap exists
 *  to hold. */
const CHUNK_SIZE = 3;

type RowStatus =
  | { state: 'queued' }
  | { state: 'skipped' }
  | { state: 'uploading' }
  | { state: 'done'; outcome: BatchFileOutcome }
  | { state: 'error'; outcome: BatchFileOutcome };

interface FileRow {
  id: string;
  file: File;
  title: string;
  slug: string;
  status: RowStatus;
}

function makeRow(file: File): FileRow {
  return { id: crypto.randomUUID(), file, title: file.name, slug: slugFromTitle(file.name), status: { state: 'queued' } };
}

/** A row that failed before ever reaching the server (oversized, or a whole-chunk network/transport
 *  failure) — same shape as a server-reported BatchFileOutcome so the row rendering never has to
 *  branch on where a failure came from. */
function clientOutcome(row: FileRow, reason: string): BatchFileOutcome {
  return { filename: row.file.name, slug: row.slug, ok: false, reason };
}

export function BatchUpload({
  files,
  scope,
  onDone,
  onReset,
  onLockChange,
}: {
  files: File[];
  scope: Scope;
  /** Called once, the first time ANY file in the run succeeds — bumps the page list, same zero-arg
   *  contract the single-file path already has. Does not reset this view; the results stay visible
   *  until the user explicitly starts over via onReset. */
  onDone: () => void;
  /** Clears the parent's file selection, returning to the picker. Called from the "Add more" /
   *  "Start over" action once the user is done reviewing results. */
  onReset: () => void;
  /** Fires whenever this component moves into or out of an active run (runState !== 'idle'). The
   *  parent uses this to disable its own file picker/drop zone while a batch is in flight or showing
   *  results — see the comment on the resync effect below for why that matters, not just why it's
   *  convenient. */
  onLockChange?: (locked: boolean) => void;
}) {
  const [rows, setRows] = useState<FileRow[]>(() => files.map(makeRow));
  const [runState, setRunState] = useState<'idle' | 'running' | 'stopped' | 'done'>('idle');
  const [retryAfterMs, setRetryAfterMs] = useState<number | null>(null);
  const [canResume, setCanResume] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const cancelRef = useRef(false);
  const runningRef = useRef(false);
  const doneNotified = useRef(false);
  // The file SELECTION last reflected into `rows`, not merely "was runState idle last render". The
  // resync effect used to key off runState alone: `if (runState === 'idle') setRows(files.map(...))`
  // — which also fires on the transition INTO idle that cancel() itself produces, discarding the
  // done/error statuses cancel had just carefully preserved a moment earlier, on every single cancel.
  // Comparing against the actual `files` reference decouples "did the selection change" from "did
  // runState merely change for some other reason".
  const syncedFiles = useRef(files);

  useEffect(() => {
    if (syncedFiles.current === files) return;
    syncedFiles.current = files;
    if (runState === 'idle') setRows(files.map(makeRow));
    // A new selection arriving while a run is active/stopped/done is intentionally NOT reflected here
    // — the parent locks its own picker via onLockChange below specifically so this case cannot arise
    // from the shipped UI. If it ever does (a future caller that ignores the lock), the safer failure
    // is "the new files are invisible" rather than "silently merged into a batch already in flight".
  }, [files, runState]);

  useEffect(() => {
    onLockChange?.(runState !== 'idle');
  }, [runState, onLockChange]);

  useEffect(() => {
    if (retryAfterMs === null) return;
    setCanResume(false);
    const t = setTimeout(() => setCanResume(true), Math.max(0, retryAfterMs - Date.now()));
    return () => clearTimeout(t);
  }, [retryAfterMs]);

  async function run() {
    // Synchronous re-entrancy guard: setRunState('running') below doesn't take effect until the next
    // render, so a second click (a fast double-click, or a repeated key activation) arriving before
    // that paint would otherwise pass the same "idle" button-visibility check and start a second
    // overlapping submission of the same rows.
    if (runningRef.current) return;
    runningRef.current = true;
    cancelRef.current = false;
    setRunState('running');
    setRetryAfterMs(null);

    let working = rows.map((r): FileRow => (r.status.state === 'skipped' ? { ...r, status: { state: 'queued' } } : r));
    setRows(working);

    for (let i = 0; i < working.length; i += CHUNK_SIZE) {
      if (cancelRef.current) {
        working = working.map((r) => (r.status.state === 'queued' ? { ...r, status: { state: 'skipped' } } : r));
        setRows(working);
        setRunState('idle');
        runningRef.current = false;
        return;
      }

      const chunkIdx = working
        .slice(i, i + CHUNK_SIZE)
        .map((r, j) => (r.status.state === 'queued' ? i + j : -1))
        .filter((idx) => idx !== -1);
      if (chunkIdx.length === 0) continue;

      // Oversized files never leave the browser — same ordering reason the single-file path checks
      // file.size before reading it: a huge file base64-encoded first would OOM the tab before this
      // friendly message could render.
      const oversized = chunkIdx.filter((idx) => working[idx]!.file.size > MAX_FILE_BYTES);
      const toSend = chunkIdx.filter((idx) => !oversized.includes(idx));

      working = working.map((r, idx) =>
        oversized.includes(idx)
          ? {
              ...r,
              status: {
                state: 'error',
                outcome: clientOutcome(
                  r,
                  `${(r.file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
                ),
              },
            }
          : chunkIdx.includes(idx)
            ? { ...r, status: { state: 'uploading' } }
            : r,
      );
      setRows(working);

      if (toSend.length === 0) continue;

      try {
        const payload = await Promise.all(
          toSend.map(async (idx) => {
            const row = working[idx]!;
            return { filename: row.file.name, content_base64: await toBase64(row.file), slug: row.slug, title: row.title };
          }),
        );
        const r = await callOp<IngestFilesResult>('ingest_files', { files: payload, scope });
        working = working.map((row, idx) => {
          const pos = toSend.indexOf(idx);
          if (pos === -1) return row;
          const outcome = r.outcomes[pos]!;
          return { ...row, status: outcome.ok ? { state: 'done', outcome } : { state: 'error', outcome } };
        });
        setRows(working);
        if (r.succeeded > 0 && !doneNotified.current) {
          doneNotified.current = true;
          onDone();
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'rate_limited') {
          // Revert this chunk to queued — nothing in it was consumed server-side — and stop rather
          // than immediately retrying into the same wall. "Resume" re-enters run(), which re-derives
          // its chunk plan from the current rows, so it picks up exactly where this left off.
          working = working.map((row, idx) => (toSend.includes(idx) ? { ...row, status: { state: 'queued' } } : row));
          setRows(working);
          setRunState('stopped');
          setRetryAfterMs(Date.now() + (err.retryAfter ?? 5) * 1000);
          runningRef.current = false;
          return;
        }
        // Any other whole-chunk failure (a network blip, a transport error): this chunk failed, but
        // partition-not-abort applies client-side too — mark it and move on to the next chunk rather
        // than losing the rest of the folder over one transient hiccup.
        const message = err instanceof Error ? err.message : String(err);
        working = working.map((row, idx) =>
          toSend.includes(idx) ? { ...row, status: { state: 'error', outcome: clientOutcome(row, message) } } : row,
        );
        setRows(working);
      }
    }
    runningRef.current = false;
    setRunState('done');
  }

  function cancel() {
    cancelRef.current = true;
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const succeeded = rows.filter((r) => r.status.state === 'done').length;
  const failed = rows.filter((r) => r.status.state === 'error').length;
  const remaining = rows.filter((r) => r.status.state === 'queued' || r.status.state === 'uploading').length;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span>
          <span className="font-medium text-ok">{succeeded} indexed</span>
          {failed > 0 && <span className="text-danger">, {failed} failed</span>}
          {remaining > 0 && <span className="text-ink-muted">, {remaining} remaining</span>}
        </span>
      </div>

      <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-paper">
        {rows.map((row) => (
          <li key={row.id} className="p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                {runState === 'idle' ? (
                  <input
                    value={row.title}
                    maxLength={300}
                    aria-label={`Title for ${row.file.name}`}
                    onChange={(e) => {
                      const title = e.target.value;
                      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, title } : r)));
                    }}
                    className="w-full truncate rounded-sm border border-line bg-surface px-2 py-1 text-sm font-medium"
                  />
                ) : (
                  <span className="block truncate font-medium">{row.title}</span>
                )}
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                  <span className="font-mono">{row.file.name}</span>
                  <span>{(row.file.size / 1024).toFixed(0)} KB</span>
                </span>
              </div>
              <span
                className={
                  row.status.state === 'done'
                    ? 'shrink-0 text-sm font-medium text-ok'
                    : row.status.state === 'error'
                      ? 'shrink-0 text-sm font-medium text-danger'
                      : row.status.state === 'uploading'
                        ? 'shrink-0 text-sm text-brand'
                        : 'shrink-0 text-sm text-ink-faint'
                }
              >
                {row.status.state === 'queued' && 'Queued'}
                {row.status.state === 'skipped' && 'Skipped'}
                {row.status.state === 'uploading' && 'Uploading…'}
                {row.status.state === 'done' &&
                  `${row.status.outcome.chunkCount ?? 0} passage${row.status.outcome.chunkCount === 1 ? '' : 's'}`}
                {row.status.state === 'error' && 'Failed'}
              </span>
            </div>
            {row.status.state === 'done' && row.status.outcome.degraded && (
              <p className="mt-1 text-xs text-warn">Part of this document could not be read.</p>
            )}
            {row.status.state === 'error' && (
              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => toggleExpanded(row.id)}
                  aria-expanded={expanded.has(row.id)}
                  className="text-xs text-danger underline"
                >
                  {row.status.outcome.reason}
                </button>
                {expanded.has(row.id) && (
                  <div className="mt-2">
                    <ErrorPanel
                      error={new ApiError(row.status.outcome.code ?? 'internal_error', row.status.outcome.reason ?? 'failed', '', 0, row.status.outcome.suggestion)}
                    />
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {runState === 'idle' && (
          <button
            type="button"
            onClick={() => void run()}
            className="flex-1 rounded-md bg-brand px-4 py-3 font-medium text-paper hover:bg-brand-hover"
          >
            Add {rows.length} document{rows.length === 1 ? '' : 's'} to the brain
          </button>
        )}
        {runState === 'running' && (
          <button
            type="button"
            onClick={cancel}
            className="flex-1 rounded-md border border-line px-4 py-3 font-medium hover:bg-surface"
          >
            Cancel
          </button>
        )}
        {runState === 'stopped' && (
          <button
            type="button"
            disabled={!canResume}
            onClick={() => void run()}
            className="flex-1 rounded-md bg-brand px-4 py-3 font-medium text-paper hover:bg-brand-hover disabled:opacity-50"
          >
            {canResume ? 'Resume' : 'Waiting to retry…'}
          </button>
        )}
        {runState === 'done' && (
          <button
            type="button"
            onClick={onReset}
            className="flex-1 rounded-md border border-line px-4 py-3 font-medium hover:bg-surface"
          >
            Add more files
          </button>
        )}
      </div>
      {runState === 'stopped' && (
        <p className="mt-2 text-xs text-ink-faint">
          The server asked us to slow down — the remaining files are still queued and will resume automatically.
        </p>
      )}
    </div>
  );
}
