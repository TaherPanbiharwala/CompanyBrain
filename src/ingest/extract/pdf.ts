// PDF -> Block[], one block per page, so a citation can name the page.
//
// unpdf wraps a serverless build of pdf.js and runs under Bun without native dependencies (verified
// against a hand-built PDF before this file existed).
import { extractText, getDocumentProxy } from 'unpdf';
import type { Block, Extracted } from '../blocks.ts';

/** Below this many characters, a page has no usable text layer.
 *
 *  Not zero: a scanned page frequently yields a handful of stray glyphs from a header stamp or a page
 *  number, which is indistinguishable from "a page with almost nothing on it" and equally useless to
 *  retrieve. 40 characters is roughly "a short sentence" — below it there is nothing to embed. */
const MIN_PAGE_CHARS = 40;

export async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(bytes);
  } catch (err) {
    // Encrypted PDFs are their own failure and deserve their own message — "extraction failed" would
    // send someone looking for a corrupt file when the fix is to remove the password.
    const msg = (err as Error)?.message ?? '';
    if (/password|encrypt/i.test(msg)) {
      throw new Error('PASSWORD_PROTECTED');
    }
    throw new Error(`PDF_UNREADABLE: ${msg.slice(0, 200)}`);
  }

  const { text } = await extractText(doc, { mergePages: false });
  const pages: string[] = Array.isArray(text) ? text : [String(text)];

  const blocks: Block[] = [];
  let extracted = 0;
  let skipped = 0;

  pages.forEach((raw, i) => {
    const pageNo = i + 1;
    // pdf.js emits soft hyphens and runs of spaces from glyph positioning; both survive into
    // embeddings as noise if left alone.
    const clean = raw.replace(/­/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    if (clean.length < MIN_PAGE_CHARS) {
      skipped++;
      return;
    }
    extracted++;
    // Paragraph splitting inside a page: pdf.js gives newline-separated lines, and a blank line is
    // the only reliable paragraph signal available without layout analysis.
    for (const para of clean.split(/\n{2,}/)) {
      const t = para.replace(/\n/g, ' ').trim();
      if (t) blocks.push({ text: t, kind: 'paragraph', locator: { kind: 'page', from: pageNo, to: pageNo } });
    }
  });

  return {
    format: 'pdf',
    blocks,
    meta: { pageCount: pages.length },
    unitsExtracted: extracted,
    unitsSkipped: skipped,
  };
}
