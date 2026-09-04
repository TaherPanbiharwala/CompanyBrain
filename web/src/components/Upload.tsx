import { useRef, useState } from 'react';
// The server's list, not a second copy — the hand-written one had already dropped .tsv and
// .markdown, hiding files the server accepts from the picker entirely.
import { ACCEPTED_EXTENSIONS } from '../../../src/ingest/extract/detect';
import { callOp, type IngestResult, type IngestFileResult, type Workspace } from '../lib/api';
import { ErrorPanel } from './ErrorPanel';
import { BatchUpload } from './BatchUpload';

/** Mirrors MAX_BODY_CHARS in src/api/operations.ts. The transport can now actually carry this — the
 *  app-wide 100kb cap made it unsatisfiable until the paste routes got their own parser. */
const MAX_BODY_CHARS = 200_000;
/** Mirrors MAX_FILE_BYTES in src/ingest/file.ts (on the DECODED bytes). Exported so BatchUpload.tsx
 *  can apply the same per-file check rather than holding a third hand-copied literal. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * base64 a File, off the main thread.
 *
 * The previous version read the whole file into an ArrayBuffer, then built a binary string with a
 * chunked `String.fromCharCode(...)` loop, then `btoa`'d it. Measured on a 5 MiB input: **106 ms of
 * uninterrupted synchronous work** (100 ms of it in the fromCharCode loop — spreading a Uint8Array
 * subarray is iterator-based, which is where nearly all of it went) and a peak of **~90 MiB above
 * baseline**, about 18x the file, mostly rope garbage from 160 `bin +=` iterations.
 *
 * `setBusy(true)` does paint first, because `await file.arrayBuffer()` yields — so the user saw
 * "Adding…" and then a frozen tab, which is worse than a dead button. FileReader encodes natively and
 * asynchronously: no main-thread block, and no intermediate binary string at all.
 *
 * readAsDataURL yields `data:<mime>;base64,<payload>`; the server wants only the payload.
 *
 * Exported: BatchUpload.tsx needs the exact same encoding for every file in a batch, and this is
 * already safe for concurrent/repeated use — it opens a fresh FileReader per call.
 */
export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      // No comma means this is not a data: URL, which should be impossible from readAsDataURL — but
      // slicing at -1+1 = 0 would silently send the whole "data:...;base64," prefix as content.
      if (comma < 0) {
        reject(new Error(`unexpected FileReader output for ${file.name}`));
        return;
      }
      resolve(url.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export type Scope = 'workspace' | 'private';

/** Slug rules from the op's own zod regex: lowercase, starts alphanumeric, then [a-z0-9._-]. Derived
 *  client-side purely to pre-fill the field — the server is what validates. Exported for the same
 *  reason toBase64 is: BatchUpload.tsx derives a default per-file slug from each filename. */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 200);
}

/** Chromium-family only (webkitdirectory has no standard equivalent elsewhere). Feature-detected
 *  rather than assumed, so the folder-picker button simply does not render where it would silently
 *  do nothing. */
const SUPPORTS_FOLDER_PICKER =
  typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input');

/** A UX cap on the whole SELECTION, distinct from MAX_BATCH_FILES (src/ingest/batch.ts, =10, which
 *  bounds one HTTP call — BatchUpload already respects it by submitting in chunks). Nothing bounds how
 *  many files a folder picker or a large drag-and-drop can hand back in one go: a folder with
 *  thousands of entries would otherwise render one full DOM row per file with no virtualization,
 *  visibly freezing the tab on selection alone, well before any network request is sent. This is a
 *  client-side courtesy limit, not a server contract. */
const MAX_FILE_SELECTION = 200;

export function Upload({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [title, setTitle] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slug, setSlug] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [scope, setScope] = useState<Scope>('workspace');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<IngestFileResult | IngestResult | null>(null);
  const [truncated, setTruncated] = useState(0);
  // True while BatchUpload has an active/finished run — the picker below is disabled for the
  // duration, rather than silently accepting a drop it cannot reflect. See BatchUpload's own comment
  // on its resync effect for the bug this closes: a selection change reaching BatchUpload while it
  // wasn't 'idle' used to be invisible until a full reset, discarding whatever was just added.
  const [batchLocked, setBatchLocked] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const effectiveSlug = slugTouched ? slug : slugFromTitle(title);
  // >1 file hands off to BatchUpload entirely, which owns its own per-file title/slug, its own
  // submit affordance, and its own progress/result view — this form's single title/slug pair and
  // single ingest_file call apply only to exactly one file, same as before this feature existed.
  const isBatch = mode === 'file' && files.length > 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (mode === 'paste') {
        const r = await callOp<IngestResult>('ingest', {
          slug: effectiveSlug,
          title,
          body,
          scope,
        });
        setDone(r);
      } else {
        const file = files[0];
        if (!file) throw new Error('Choose a file first.');
        // file.size BEFORE arrayBuffer(). Reading first meant a multi-gigabyte selection OOM'd the
        // tab before this friendly message could render — the one size guard in the upload path was
        // unreachable in exactly the case it exists for. size is free on the File object.
        if (file.size > MAX_FILE_BYTES) {
          throw new Error(
            `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
          );
        }
        const r = await callOp<IngestFileResult>('ingest_file', {
          filename: file.name,
          content_base64: await toBase64(file),
          slug: effectiveSlug || slugFromTitle(file.name),
          title: title || file.name,
          scope,
        });
        setDone(r);
      }
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <UploadResult result={done} onAgain={() => setDone(null)} />;

  function addFiles(list: FileList | null, mergeMode: 'replace' | 'append') {
    if (batchLocked) return; // a run is active or its results are showing — see the state's own doc.
    const picked = list ? Array.from(list) : [];
    if (picked.length === 0) return;
    setFiles((prev) => {
      const combined = mergeMode === 'replace' ? picked : [...prev, ...picked];
      const over = combined.length - MAX_FILE_SELECTION;
      setTruncated(over > 0 ? over : 0);
      return over > 0 ? combined.slice(0, MAX_FILE_SELECTION) : combined;
    });
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-line bg-surface p-5">
      <div className="flex gap-1 rounded-md bg-surface-sunk p-1 text-sm" role="tablist">
        {(['paste', 'file'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={
              mode === m
                ? 'flex-1 rounded-sm bg-paper px-3 py-1.5 font-medium'
                : 'flex-1 rounded-sm px-3 py-1.5 text-ink-muted hover:text-ink'
            }
          >
            {m === 'paste' ? 'Paste text' : 'Upload files'}
          </button>
        ))}
      </div>

      {/* Hidden for a batch: there is no single title/slug for N files — BatchUpload derives one
          per file from its filename instead, editable inline there. */}
      {!isBatch && (
        <>
          <label htmlFor="up-title" className="mt-4 block text-sm font-medium">
            Title
          </label>
          <input
            id="up-title"
            required
            maxLength={300}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Q3 pricing policy"
            className="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2"
          />

          <label htmlFor="up-slug" className="mt-3 block text-sm font-medium">
            Slug <span className="font-normal text-ink-faint">— its permanent identifier</span>
          </label>
          <input
            id="up-slug"
            required
            maxLength={200}
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            placeholder="q3-pricing-policy"
            className="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2 font-mono text-sm"
          />
        </>
      )}

      {mode === 'paste' ? (
        <>
          <label htmlFor="up-body" className="mt-3 block text-sm font-medium">
            Text
          </label>
          <textarea
            id="up-body"
            required
            rows={8}
            maxLength={MAX_BODY_CHARS}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Paste the document here…"
            className="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2"
          />
          <p className="mt-1 text-xs text-ink-faint">
            {body.length.toLocaleString()} / {MAX_BODY_CHARS.toLocaleString()} characters
          </p>
        </>
      ) : (
        <>
          <label className="mt-3 block text-sm font-medium">File{files.length > 1 ? 's' : ''}</label>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!batchLocked) setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              addFiles(e.dataTransfer.files, 'append');
            }}
            className={
              'mt-1 rounded-sm border border-dashed p-4 text-center transition-colors ' +
              (dragActive && !batchLocked ? 'border-brand bg-brand-faint' : 'border-line bg-paper') +
              (batchLocked ? ' opacity-50' : '')
            }
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={batchLocked}
              accept={ACCEPTED_EXTENSIONS.join(',')}
              onChange={(e) => addFiles(e.target.files, 'replace')}
              className="hidden"
            />
            {SUPPORTS_FOLDER_PICKER && (
              // webkitdirectory cannot be toggled on the file input above without recreating the
              // node, so this is a second input rather than a prop swap — both feed the same
              // addFiles handler. Still yields a flat FileList (webkitRelativePath is display
              // metadata only), so nothing downstream needs to branch on how a file arrived.
              <input
                ref={folderInputRef}
                type="file"
                multiple
                disabled={batchLocked}
                // @ts-expect-error -- non-standard, Chromium-family only; feature-detected above.
                webkitdirectory=""
                onChange={(e) => addFiles(e.target.files, 'replace')}
                className="hidden"
              />
            )}
            <p className="text-sm text-ink-muted">
              {batchLocked ? 'Finish or reset the current batch to change files.' : 'Drag files here, or'}
            </p>
            {!batchLocked && (
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-sm border border-line bg-paper px-3 py-1.5 text-sm hover:bg-surface"
                >
                  Choose files
                </button>
                {SUPPORTS_FOLDER_PICKER && (
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="rounded-sm border border-line bg-paper px-3 py-1.5 text-sm hover:bg-surface"
                  >
                    Choose a folder
                  </button>
                )}
              </div>
            )}
            {files.length > 0 && (
              <p className="mt-2 text-xs text-ink-faint">
                {files.length} file{files.length === 1 ? '' : 's'} selected
                {!batchLocked && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      onClick={() => {
                        setFiles([]);
                        setTruncated(0);
                      }}
                      className="underline hover:text-ink"
                    >
                      Clear
                    </button>
                  </>
                )}
              </p>
            )}
            {truncated > 0 && (
              <p className="mt-1 text-xs text-warn">
                Only the first {MAX_FILE_SELECTION} files were kept — {truncated} more were left out.
                Add the rest as a separate batch once this one finishes.
              </p>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            PDF, Word, Excel, CSV, JSON, HTML, Markdown or text. Up to {MAX_FILE_BYTES / 1024 / 1024} MB each.
          </p>
        </>
      )}

      <ScopePicker
        workspace={workspace}
        count={isBatch ? files.length : 1}
        scope={scope}
        onChange={setScope}
        disabled={isBatch && batchLocked}
      />

      {isBatch ? (
        <BatchUpload
          files={files}
          scope={scope}
          onDone={onDone}
          onReset={() => {
            setFiles([]);
            setTruncated(0);
          }}
          onLockChange={setBatchLocked}
        />
      ) : (
        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-md bg-brand px-4 py-3 font-medium text-paper hover:bg-brand-hover disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add to the brain'}
        </button>
      )}

      {error != null && (
        <div className="mt-4">
          <ErrorPanel error={error} onRetry={() => setError(null)} showSignIn />
        </div>
      )}
    </form>
  );
}

/**
 * Scope, per amendment A4.
 *
 * "Only me" / "Everyone at {Workspace}" rather than "Private | Everyone" — bare "Everyone" reads as
 * PUBLIC, which is exactly wrong for a product whose promise is that documents stay inside the
 * company. Naming the workspace makes the audience concrete.
 *
 * A segmented control, not a select, so both options and the resolved audience are visible without
 * an interaction. And it states the IRREVERSIBILITY inline: the op's own description says the scope
 * is fixed at ingest and there is no re-scope operation. A control that looks like a setting but is
 * permanent has to say so at the point of choice, not in a doc nobody reads.
 *
 * Shaped to grow: when team scope lands this becomes a third option in the same control rather than
 * a redesign.
 */
function ScopePicker({
  workspace,
  scope,
  onChange,
  count = 1,
  disabled = false,
}: {
  workspace: Workspace;
  scope: Scope;
  onChange: (s: Scope) => void;
  /** Files this choice applies to. >1 means a batch — one visibility decision for the whole
   *  submission, never per file: scope is irreversible, and offering N independent irreversible
   *  choices in a dense list is worse than deciding once, clearly, before the batch starts. Only
   *  changes the trailing copy below. */
  count?: number;
  /** True while a batch run is active or showing results (BatchUpload's onLockChange). scope is read
   *  fresh into every chunk-request BatchUpload sends, so changing it mid-run would silently split one
   *  "batch" across two visibilities — files already uploaded under the old scope, the rest under the
   *  new one — which contradicts the "one decision for the whole batch" promise the copy below makes. */
  disabled?: boolean;
}) {
  return (
    <fieldset className="mt-4" disabled={disabled}>
      <legend className="text-sm font-medium">
        Who can read {count > 1 ? `these ${count} documents` : 'this'}
      </legend>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(
          [
            { v: 'private', label: 'Only me', hint: 'Nobody else, including admins' },
            { v: 'workspace', label: `Everyone at ${workspace.name}`, hint: 'Every member of this workspace' },
          ] as const
        ).map((o) => (
          <button
            key={o.v}
            type="button"
            disabled={disabled}
            aria-pressed={scope === o.v}
            onClick={() => onChange(o.v)}
            className={
              scope === o.v
                ? 'rounded-md border-2 border-brand bg-brand-faint p-3 text-left disabled:opacity-50'
                : 'rounded-md border border-line bg-paper p-3 text-left hover:bg-surface disabled:opacity-50'
            }
          >
            <span className="block text-sm font-medium">{o.label}</span>
            <span className="mt-0.5 block text-xs text-ink-faint">{o.hint}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        {count > 1
          ? 'This cannot be changed later — you would have to delete each page and add it again.'
          : 'This cannot be changed later — you would have to delete the page and add it again.'}
      </p>
    </fieldset>
  );
}

/**
 * The post-upload state, and the reason it is not just "Done".
 *
 * `ingest_file` returns unitsExtracted/unitsSkipped and its own `degraded` flag, which is a
 * DIFFERENT signal from search's degraded: it means part of the document could not be read. The
 * backend's own comment gives the case — a 40-page PDF where 37 pages were scans looks exactly like
 * a clean 3-page ingest. Showing the real numbers is the only way the user learns their document is
 * mostly missing.
 */
function UploadResult({
  result,
  onAgain,
}: {
  result: IngestResult | IngestFileResult;
  onAgain: () => void;
}) {
  const file = 'unitsSkipped' in result ? result : null;
  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <p className="font-medium">Added to the brain.</p>
      <p className="mt-1 text-sm text-ink-muted">
        {result.chunkCount} passage{result.chunkCount === 1 ? '' : 's'} indexed
        {file ? ` from ${file.format.toUpperCase()}` : ''}.
      </p>

      {file?.degraded && (
        <div role="status" className="mt-3 rounded-md border border-warn/40 bg-warn-faint p-3 text-sm">
          <span className="font-medium">Part of this document could not be read.</span> Indexed{' '}
          {file.unitsExtracted} of {file.unitsExtracted + file.unitsSkipped} sections; {file.unitsSkipped}{' '}
          had no extractable text. Scanned pages and images need OCR, which is not supported yet — so
          questions about those sections will not find anything.
        </div>
      )}

      {result.chunkCount === 0 && (
        <div role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger-faint p-3 text-sm">
          <span className="font-medium">Nothing was indexed.</span> The page exists but has no
          searchable passages, so it will never appear in an answer.
        </div>
      )}

      <button
        type="button"
        onClick={onAgain}
        className="mt-4 rounded-sm border border-line px-3 py-1.5 text-sm hover:bg-paper"
      >
        Add another
      </button>
    </div>
  );
}
