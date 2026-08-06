import { useState } from 'react';
// The server's list, not a second copy — the hand-written one had already dropped .tsv and
// .markdown, hiding files the server accepts from the picker entirely.
import { ACCEPTED_EXTENSIONS } from '../../../src/ingest/extract/detect';
import { callOp, type IngestResult, type IngestFileResult, type Workspace } from '../lib/api';
import { ErrorPanel } from './ErrorPanel';

/** Mirrors MAX_BODY_CHARS in src/api/operations.ts. The transport can now actually carry this — the
 *  app-wide 100kb cap made it unsatisfiable until the paste routes got their own parser. */
const MAX_BODY_CHARS = 200_000;
/** Mirrors MAX_FILE_BYTES in src/ingest/file.ts (on the DECODED bytes). */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
 */
function toBase64(file: File): Promise<string> {
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

type Scope = 'workspace' | 'private';

/** Slug rules from the op's own zod regex: lowercase, starts alphanumeric, then [a-z0-9._-]. Derived
 *  client-side purely to pre-fill the field — the server is what validates. */
function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 200);
}

export function Upload({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [title, setTitle] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slug, setSlug] = useState('');
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [scope, setScope] = useState<Scope>('workspace');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<IngestFileResult | IngestResult | null>(null);

  const effectiveSlug = slugTouched ? slug : slugFromTitle(title);

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
            {m === 'paste' ? 'Paste text' : 'Upload a file'}
          </button>
        ))}
      </div>

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
          <label htmlFor="up-file" className="mt-3 block text-sm font-medium">
            File
          </label>
          <input
            id="up-file"
            type="file"
            required
            accept={ACCEPTED_EXTENSIONS.join(',')}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-ink-faint">
            PDF, Word, Excel, CSV, JSON, HTML, Markdown or text. Up to {MAX_FILE_BYTES / 1024 / 1024} MB.
          </p>
        </>
      )}

      <ScopePicker workspace={workspace} scope={scope} onChange={setScope} />

      <button
        type="submit"
        disabled={busy}
        className="mt-4 w-full rounded-md bg-brand px-4 py-3 font-medium text-paper hover:bg-brand-hover disabled:opacity-50"
      >
        {busy ? 'Adding…' : 'Add to the brain'}
      </button>

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
}: {
  workspace: Workspace;
  scope: Scope;
  onChange: (s: Scope) => void;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="text-sm font-medium">Who can read this</legend>
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
            aria-pressed={scope === o.v}
            onClick={() => onChange(o.v)}
            className={
              scope === o.v
                ? 'rounded-md border-2 border-brand bg-brand-faint p-3 text-left'
                : 'rounded-md border border-line bg-paper p-3 text-left hover:bg-surface'
            }
          >
            <span className="block text-sm font-medium">{o.label}</span>
            <span className="mt-0.5 block text-xs text-ink-faint">{o.hint}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        This cannot be changed later — you would have to delete the page and add it again.
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
