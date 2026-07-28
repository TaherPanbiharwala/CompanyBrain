// HTML -> Block[]. Used by BOTH the .html extractor and the .docx extractor.
//
// mammoth converts a Word document to HTML, so docx and html arrive at the same structure by
// different routes. An earlier design had docx->blocks and html->markdown->blocks as two separate
// paths, which is two implementations of one problem: heading levels, list flattening and table
// handling would drift between them, and a bug fixed in one would survive in the other. One
// converter, two callers.
//
// Deliberately a small hand-written parser rather than a DOM library: the input here is either
// mammoth's own narrow output or a saved web page, we need six element kinds, and adding a DOM
// dependency to reach them would be the largest new attack surface in the ingest path for the least
// benefit. Anything it cannot classify degrades to a paragraph, which is the safe direction.
import type { Block } from '../blocks.ts';

// `div` is deliberately ABSENT. Including it looked like it handled wrappers, but the regex consumes
// the whole `<div>…</div>` span on the match, so skipping the wrapper skipped its children too — a
// `<div><p>one</p><p>two</p></div>` collapsed to a single untagged block and lost the paragraph
// structure entirely. Matching only leaf-ish block elements lets the children match on their own.
const BLOCK_RE = /<(h[1-6]|p|li|pre|code|tr|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;

/** Entity decode limited to what actually appears in mammoth output and saved pages. A general
 *  decoder would be a liability here — `&#x...;` forms are an obfuscation channel and we have no
 *  reason to honour them in text destined for an embedding. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A table row becomes ONE block with cells joined by a separator, so a row is never split across
 *  chunks and a cell keeps its neighbours for context. */
function rowText(inner: string): string {
  const cells = [...inner.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripTags(m[1] ?? ''));
  return cells.length > 0 ? cells.filter(Boolean).join(' | ') : stripTags(inner);
}

export function htmlToBlocks(html: string): Block[] {
  // Script and style contents are not prose and must never reach an embedding.
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const blocks: Block[] = [];
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;

  while ((m = BLOCK_RE.exec(cleaned)) !== null) {
    const tag = (m[1] ?? '').toLowerCase();
    const inner = m[2] ?? '';

    if (tag === 'tr') {
      const text = rowText(inner);
      if (text) blocks.push({ text, kind: 'row' });
      continue;
    }

    const text = stripTags(inner);
    if (!text) continue;

    if (/^h[1-6]$/.test(tag)) {
      blocks.push({ text, kind: 'heading', level: Number(tag[1]) });
    } else if (tag === 'li') {
      blocks.push({ text, kind: 'list' });
    } else if (tag === 'pre' || tag === 'code') {
      blocks.push({ text, kind: 'code' });
    } else {
      blocks.push({ text, kind: 'paragraph' });
    }
  }

  // Nothing matched — a fragment with no block elements at all. Better one paragraph than nothing.
  if (blocks.length === 0) {
    const text = stripTags(cleaned);
    if (text) blocks.push({ text, kind: 'paragraph' });
  }
  return blocks;
}

/** `<title>` when present. Used as the page title only when the caller supplied none. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? stripTags(m[1] ?? '') : '';
  return t || undefined;
}
