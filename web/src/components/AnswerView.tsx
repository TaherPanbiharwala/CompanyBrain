import { useState } from 'react';
import { confidenceOf, type AskResult, type ChunkHit } from '../lib/api';
import { ScopeBadge } from './ScopeBadge';

/**
 * An answer, its citations, and the sources behind them.
 *
 * NOTHING HERE RENDERS HTML. Every string below reaches the DOM as a text child, never through
 * dangerouslySetInnerHTML. That is deliberate and load-bearing: the answer text is model output
 * derived from uploaded documents, so it is attacker-influenced twice over, and this app
 * authenticates with a cookie and has no CSRF token — script on this origin can call create_invite.
 * The CSP set in src/web.ts is the backstop; not building the hole is the control.
 */
export function AnswerView({ result }: { result: AskResult }) {
  const confidence = confidenceOf(result);

  return (
    <div className="mt-6">
      {result.degraded && <DegradedBanner reason={result.degraded} />}

      {confidence === 'grounded' ? (
        <div className="rounded-lg border border-line bg-surface p-5">
          <p className="whitespace-pre-wrap leading-relaxed">{result.answer}</p>
        </div>
      ) : (
        <UngroundedAnswer result={result} confidence={confidence} />
      )}

      {/* Gated on SOURCES, not on cited. The 'unsupported' state is defined as sources.length > 0
        * AND citations.length === 0, so `cited` is empty there and this panel vanished entirely —
        * the user was told "this answer cites none of the documents that were found" and then shown
        * nothing about the documents that were found. The "N more passages considered but not cited"
        * disclosure was reachable only when at least one citation existed, i.e. never in the case it
        * would matter most. */}
      {result.sources.length > 0 && (
        <Sources cited={result.cited} citations={result.citations} all={result.sources} />
      )}
    </div>
  );
}

/**
 * `degraded: 'keyword_only'` means the embedding provider was unavailable, so the vector arm did not
 * run and results are keyword-only.
 *
 * ABOVE the answer, not beside it: it changes how much the whole answer is worth, so it cannot be a
 * chip the eye skips. A short answer and a short answer from half a search look identical, which is
 * exactly why the backend bothers to return this field.
 */
function DegradedBanner({ reason }: { reason: string }) {
  return (
    <div role="status" className="mb-3 rounded-md border border-warn/40 bg-warn-faint p-3 text-sm">
      <span className="font-medium">Search was running at reduced quality.</span>{' '}
      {reason === 'keyword_only'
        ? 'Semantic search was unavailable, so this used keyword matching only and may have missed relevant documents.'
        : `Reason: ${reason}.`}
    </div>
  );
}

/**
 * The answer that cites nothing.
 *
 * A DISTINCT container, and this is the single most important visual decision in the surface. The
 * backend has a documented fallback where unparseable model output becomes the entire answer with
 * `citations: []`, and the marker scrubber then removes any visual trace — so without this the user
 * receives confident prose, no chips, in exactly the same box as a fully cited answer. That is the
 * product's core promise failing silently.
 *
 * Two different states, because the remedies differ: nothing was retrieved (ask something else, or
 * upload the document), versus something was retrieved and the answer used none of it (the model is
 * likely speaking from general knowledge).
 */
function UngroundedAnswer({ result, confidence }: { result: AskResult; confidence: 'none' | 'unsupported' }) {
  return (
    <div className="rounded-lg border border-dashed border-warn/50 bg-paper p-5">
      <p className="text-sm font-medium text-warn">
        {confidence === 'none'
          ? 'No sources matched — this is not grounded in your documents'
          : 'This answer cites none of the documents that were found'}
      </p>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed text-ink-muted">{result.answer}</p>
      <p className="mt-3 text-xs text-ink-faint">
        {confidence === 'none'
          ? 'Nothing in what you can see matched this question. It may be in a document nobody has uploaded yet, or in one you do not have access to.'
          : 'Treat this as the model’s general knowledge rather than as something your documents say.'}
      </p>
    </div>
  );
}

function Sources({
  cited,
  citations,
  all,
}: {
  cited: ChunkHit[];
  /** Index-parallel with `cited` (answer.ts derives one from the other), and these are the numbers
   *  the PROSE carries. They are NOT positions in `cited` — see the badge below. */
  citations: number[];
  all: ChunkHit[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  // `sources` is everything retrieved; `cited` is what the answer used. Showing all of them equally
  // would make eight things look equally authoritative when the answer leaned on two.
  const unused = all.filter((s) => !cited.some((c) => c.chunkId === s.chunkId));

  return (
    <div className="mt-5">
      <h2 className="text-sm font-medium text-ink-muted">
        {cited.length > 0 ? 'Sources' : 'Retrieved, but not cited'}
      </h2>
      <ol className="mt-2 space-y-2">
        {cited.map((hit, i) => (
          <li key={hit.chunkId}>
            <button
              type="button"
              onClick={() => setOpen(open === hit.chunkId ? null : hit.chunkId)}
              aria-expanded={open === hit.chunkId}
              className="flex w-full items-start gap-3 rounded-md border border-line bg-paper p-3 text-left hover:bg-surface"
            >
              {/* The citation number AS IT APPEARS IN THE PROSE, not this chip's position.
                *
                * `{i + 1}` was wrong and it broke the one promise this product makes. `citations`
                * are 1-based indices into `sources` (answer.ts:22), and scrubMarkers KEEPS every
                * in-range marker, so the answer text really does read "[2]" and "[5]" while this
                * list was numbering itself 1, 2. Every marker pointed at the wrong document.
                *
                * It coincides only when citations[i] === i + 1 — a single `[1]`, or the model
                * citing sources 1..k in order — which is why the live demo looked correct and why
                * test/answer-confidence.test.ts never caught it: every case is `citations: [1]`. */}
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm bg-brand-faint text-xs font-medium text-brand">
                {citations[i] ?? i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{hit.title ?? hit.slug}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                  <ScopeBadge scope={hit.scope} />
                  {hit.citation && <span>{hit.citation}</span>}
                  <span className="font-mono">{hit.slug}</span>
                </span>
              </span>
            </button>
            {open === hit.chunkId && (
              <p className="mt-1 whitespace-pre-wrap rounded-md bg-surface-sunk p-3 text-sm leading-relaxed text-ink-muted">
                {hit.content}
              </p>
            )}
          </li>
        ))}
      </ol>

      {unused.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-muted">
            {unused.length} more passage{unused.length === 1 ? '' : 's'} considered but not cited
          </summary>
          <ul className="mt-2 space-y-1">
            {unused.map((hit) => (
              <li key={hit.chunkId} className="flex items-center gap-2 text-xs text-ink-faint">
                <ScopeBadge scope={hit.scope} />
                <span className="truncate">{hit.title ?? hit.slug}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

