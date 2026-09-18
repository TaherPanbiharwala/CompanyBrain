// Pure link-extraction algorithm (M9). No DB, no I/O — deliberately, so it's unit-testable directly
// and reusable from both the synchronous ingest hook and the backfill cycle phase (reconcile.ts
// wraps this with the DB side). Two ordered passes, matching migration 0021's `link_kind` CHECK:
//
//  1. Markdown links `[text](href)` — company-brain content has no canonical-URL column on `pages`
//     (checked before writing this), so an external URL can never be resolved to a page identity.
//     Only an href that normalizes to another page's slug in the same workspace becomes an edge.
//  2. Title/slug mention — company-brain has no wikilink convention (`[[...]]`) anywhere in this
//     product, unlike gbrain. Real content here is business documents that reference each other by
//     name, so a case-insensitive, word-boundary scan for another page's title (falling back to its
//     slug) is the primary mechanism, not a secondary one.
import { normalizeExactQuery } from '../../search/retrieval-knobs.ts';

export interface LinkCandidate {
  id: string;
  slug: string;
  title: string | null;
}

export type LinkKind = 'mention' | 'markdown';

export interface ExtractedLink {
  toPageId: string;
  linkKind: LinkKind;
  linkSource: string;
  context: string;
}

/** Below this length, a title/slug is too generic to mention-match safely ("Q3", "Notes", "Home"
 *  would otherwise match constantly across unrelated pages). */
export const MIN_MENTION_LENGTH = 6;
/** Characters of surrounding text captured on each side of a match, for links.context — a future
 *  compiled_truth synthesis milestone is expected to read this column for grounding excerpts. */
export const CONTEXT_WINDOW_CHARS = 80;
/** Caps per-page fan-out. Longest linkSource wins when a page mentions more than this many things —
 *  the most specific matches are kept over generic ones. */
export const MAX_LINKS_PER_PAGE = 50;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildContext(text: string, matchStart: number, matchEnd: number): string {
  const start = Math.max(0, matchStart - CONTEXT_WINDOW_CHARS);
  const end = Math.min(text.length, matchEnd + CONTEXT_WINDOW_CHARS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

/** Strips a leading `/` or `page/` and any `#fragment`/`?query` suffix, so an href written as
 *  `/page/some-slug#section` or `page/some-slug` or bare `some-slug` all normalize to the same
 *  candidate-slug comparison. */
function normalizeHref(href: string): string {
  return href.replace(/^\/?(page\/)?/, '').split(/[#?]/, 1)[0] ?? '';
}

export function extractLinks(sourceText: string, candidates: readonly LinkCandidate[]): ExtractedLink[] {
  const found = new Map<string, ExtractedLink>(); // key: `${toPageId}|${linkKind}|${linkSource}`

  // Pass 1: markdown links. Masks each matched `[text](href)` span (full syntax, not just the href)
  // in a scratch copy of the text — otherwise pass 2's mention scan re-matches a candidate's own
  // slug/title where it appears literally inside the href text, producing a redundant second edge
  // for the exact same reference. Ported technique from gbrain's own multi-pass extractor, which
  // masks between passes for the same reason. Context excerpts still slice from the ORIGINAL
  // sourceText, never the masked copy, so masking never shows up in what a reader sees.
  const slugToCandidate = new Map(candidates.map((c) => [c.slug, c] as const));
  const mdLinkRe = /\[[^\]]+\]\(([^)\s]+)\)/g;
  const maskedChars = [...sourceText];
  for (const m of sourceText.matchAll(mdLinkRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    for (let i = start; i < end; i++) maskedChars[i] = ' ';

    const href = normalizeHref(m[1] ?? '');
    const candidate = href ? slugToCandidate.get(href) : undefined;
    if (!candidate) continue;
    const key = `${candidate.id}|markdown|${href}`;
    if (found.has(key)) continue;
    found.set(key, {
      toPageId: candidate.id,
      linkKind: 'markdown',
      linkSource: href,
      context: buildContext(sourceText, start, end),
    });
  }
  const maskedText = maskedChars.join('');

  // Pass 2: title/slug mention — scanned against the masked text so a slug/title inside already-
  // matched markdown syntax can't double-count; context excerpts still use the original sourceText.
  for (const candidate of candidates) {
    const raw = (candidate.title?.trim() || candidate.slug).trim();
    if (raw.length < MIN_MENTION_LENGTH) continue;
    const normalized = normalizeExactQuery(raw).normalized;
    const re = new RegExp(`\\b${escapeRegExp(normalized)}\\b`, 'i');
    const match = re.exec(maskedText);
    if (!match) continue;
    const key = `${candidate.id}|mention|${normalized}`;
    if (found.has(key)) continue;
    found.set(key, {
      toPageId: candidate.id,
      linkKind: 'mention',
      linkSource: normalized,
      context: buildContext(sourceText, match.index, match.index + match[0].length),
    });
  }

  const links = [...found.values()];
  if (links.length <= MAX_LINKS_PER_PAGE) return links;
  return links.sort((a, b) => b.linkSource.length - a.linkSource.length).slice(0, MAX_LINKS_PER_PAGE);
}
