// Format detection, by MAGIC BYTES.
//
// The filename extension is a hint and nothing more. It is attacker-supplied on the HTTP surface and
// wrong-by-accident everywhere else (a `.txt` that is really a PDF, a `.csv` someone saved from Excel
// as a real workbook). Chunking a PDF as prose because it was named `.txt` produces a page of binary
// noise embedded at real cost, so the bytes decide.
//
// Runs in the PARENT process, not the extraction worker. Two reasons: an unsupported format can be
// rejected without paying to spawn anything, and if both sides sniffed independently they could
// disagree — a silent fork in behaviour that would be miserable to debug.
import type { ExtractFormat } from '../blocks.ts';

export type DetectedFormat = ExtractFormat | 'unsupported';

export interface Detection {
  format: DetectedFormat;
  /** Only set when `format` is 'unsupported' — names what it looks like so the error can name the fix. */
  looksLike?: string;
}

const startsWith = (b: Uint8Array, sig: number[]): boolean =>
  sig.length <= b.length && sig.every((v, i) => b[i] === v);

/** OOXML and legacy-OLE both matter here, and they are opposite answers. */
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 — docx/xlsx/pptx/odt are all zips
const OLE = [0xd0, 0xcf, 0x11, 0xe0]; // legacy .doc/.xls/.msg compound file
const PDF = [0x25, 0x50, 0x44, 0x46]; // %PDF

/** Which OOXML? The zip's entry names say so, and we only need the first few hundred bytes of the
 *  central directory to see them — no unzip, no allocation of the whole archive. */
function ooxmlKind(bytes: Uint8Array): DetectedFormat {
  // Entry names in a zip are ASCII here, and a lossy utf-8 decode preserves them; the point is only
  // to find a substring, so replacement characters elsewhere are harmless.
  const dec = new TextDecoder('utf-8', { fatal: false });
  const head = dec.decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  const tail = dec.decode(bytes.subarray(Math.max(0, bytes.length - 8192)));
  const hay = head + tail;
  if (hay.includes('word/document.xml')) return 'docx';
  if (hay.includes('xl/workbook.xml')) return 'xlsx';
  if (hay.includes('ppt/presentation.xml')) return 'unsupported'; // .pptx — named in the error
  return 'unsupported';
}

/** Printable-ratio test. Deliberately conservative: UTF-8 multibyte sequences and common control
 *  characters (tab/newline/CR) are text, everything else in the C0 range is not. */
function looksTextual(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return false; // a NUL byte is decisive — no text format contains one
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

function textualKind(bytes: Uint8Array, filename: string): ExtractFormat {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 65536)).trimStart();
  const ext = filename.toLowerCase().split('.').pop() ?? '';

  // JSON is decidable from the bytes: parse a prefix-safe candidate rather than guessing.
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      JSON.parse(new TextDecoder().decode(bytes));
      return 'json';
    } catch {
      // A truncated or invalid JSON file is still more usefully treated as text than rejected.
    }
  }
  if (/^\s*<(!doctype html|html|head|body)\b/i.test(text)) return 'html';

  // CSV vs prose is genuinely ambiguous from content alone, so the extension gets a vote HERE and
  // only here — being wrong costs a worse chunking, not a security problem or a crash.
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (/^#{1,6}\s/m.test(text) || /^---\n/.test(text)) return 'markdown';
  return 'text';
}

export function detect(bytes: Uint8Array, filename = ''): Detection {
  if (bytes.length === 0) return { format: 'unsupported', looksLike: 'an empty file' };
  if (startsWith(bytes, PDF)) return { format: 'pdf' };

  if (startsWith(bytes, ZIP)) {
    const kind = ooxmlKind(bytes);
    if (kind !== 'unsupported') return { format: kind };
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    if (ext === 'pptx') return { format: 'unsupported', looksLike: 'a PowerPoint presentation (.pptx)' };
    return { format: 'unsupported', looksLike: 'a zip archive' };
  }

  if (startsWith(bytes, OLE)) {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const named =
      ext === 'doc'
        ? 'a legacy Word document (.doc)'
        : ext === 'xls'
          ? 'a legacy Excel workbook (.xls)'
          : ext === 'msg'
            ? 'an Outlook message (.msg)'
            : 'a legacy Microsoft Office file';
    return { format: 'unsupported', looksLike: named };
  }

  if (!looksTextual(bytes)) return { format: 'unsupported', looksLike: 'a binary file' };
  return { format: textualKind(bytes, filename) };
}

/** The remediation half of an `unsupported_format` error. A user who uploaded a `.doc` needs to be
 *  told to re-save it, not told a MIME type. */
export function remediationFor(looksLike: string | undefined): string {
  if (!looksLike) return 'Supported: PDF, Word (.docx), Excel (.xlsx), CSV, JSON, HTML, Markdown, plain text.';
  if (looksLike.includes('.doc)')) return 'Open it in Word and use File > Save As > Word Document (.docx), then upload that.';
  if (looksLike.includes('.xls)')) return 'Open it in Excel and use File > Save As > Excel Workbook (.xlsx), then upload that.';
  if (looksLike.includes('.msg')) return 'Outlook uses its own format. In Outlook, drag the message to a folder as .eml, or forward it and save the result — .eml support is not built yet either, so paste the text for now.';
  if (looksLike.includes('.pptx')) return 'Slides are not supported yet. Export the deck as PDF and upload that.';
  if (looksLike.includes('empty')) return 'The file has no contents.';
  return 'Supported: PDF, Word (.docx), Excel (.xlsx), CSV, JSON, HTML, Markdown, plain text.';
}
