// DOCX -> Block[], via mammoth's HTML and the shared converter.
//
// mammoth's whole job is mapping Word's style model onto semantic HTML, which is exactly the mapping
// blocks need — Heading 1 becomes <h1>, a list item becomes <li>, a table row becomes <tr>. Going
// through HTML is not an extra hop; it is the hop that already knows Word's semantics.
import mammoth from 'mammoth';
import type { Extracted } from '../blocks.ts';
import { htmlToBlocks } from './html.ts';

export async function extractDocx(bytes: Uint8Array): Promise<Extracted> {
  let html: string;
  try {
    // mammoth wants a Node Buffer; Buffer.from over the same memory avoids a copy.
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await mammoth.convertToHtml({ buffer });
    html = result.value;
  } catch (err) {
    throw new Error(`DOCX_UNREADABLE: ${(err as Error)?.message?.slice(0, 200) ?? ''}`);
  }

  const blocks = htmlToBlocks(html);
  // A docx is one unit: either it produced prose or it did not. Per-paragraph skip counting would be
  // noise — an empty paragraph in Word is formatting, not a failure.
  return {
    format: 'docx',
    blocks,
    meta: {},
    unitsExtracted: blocks.length > 0 ? 1 : 0,
    unitsSkipped: blocks.length > 0 ? 0 : 1,
  };
}
