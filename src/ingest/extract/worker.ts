// The extraction subprocess. Reads raw bytes on stdin, writes a framed `Extracted` JSON on stdout.
//
// Why a separate process at all: four third-party parsers handling hostile input would otherwise run
// inside the API process, next to the database pool and both provider API keys. A parser OOM or a
// malicious file that trips a native bug should cost one process, not the server. The parent strips
// the environment to PATH alone, so nothing in here can read a secret even if it wanted to.
//
// Bytes over stdin, never a path: a temp file named from a caller-supplied filename is a traversal on
// WRITE, which would be a worse hole than the server-file-read this design exists to avoid — and
// tenant document bytes would sit in a world-readable /tmp outliving the request, for pages whose
// whole point may be scope:'private'.

// FIRST STATEMENT, before any import can run: stdout is the payload channel and nothing else may
// write to it. Any dependency doing console.log — mammoth and pdf.js both warn — would interleave
// with the JSON and make a perfectly-extracted file fail to parse, indistinguishable from an
// OOM-truncated write.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a: unknown[]) => void process.stderr.write(a.map(String).join(' ') + '\n');
console.info = console.log;
console.warn = console.log;
console.debug = console.log;
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  process.stderr.write(typeof chunk === 'string' ? chunk : String(chunk));
  const cb = rest.find((r) => typeof r === 'function') as ((e?: Error) => void) | undefined;
  cb?.();
  return true;
}) as typeof process.stdout.write;

import type { ExtractFormat } from '../blocks.ts';
import { extractPdf } from './pdf.ts';
import { extractDocx } from './docx.ts';
import { extractXlsx } from './xlsx.ts';
import { extractPlain, extractHtml, extractCsv, extractJson } from './text.ts';

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function main(): Promise<void> {
  const format = process.argv[2] as ExtractFormat | undefined;
  if (!format) throw new Error('worker: no format argument');

  const bytes = await readStdin();
  const extracted =
    format === 'pdf'
      ? await extractPdf(bytes)
      : format === 'docx'
        ? await extractDocx(bytes)
        : format === 'xlsx'
          ? extractXlsx(bytes)
          : format === 'csv'
            ? extractCsv(bytes)
            : format === 'json'
              ? extractJson(bytes)
              : format === 'html'
                ? extractHtml(bytes)
                : extractPlain(bytes, format === 'markdown' ? 'markdown' : 'text');

  // Framed so the parent can tell a SHORT READ (process killed mid-write) from GARBAGE (something
  // still contaminated the stream). Without the declared length those two look identical, and they
  // have different causes and different fixes.
  const payload = Buffer.from(JSON.stringify(extracted), 'utf8');
  realStdoutWrite(`CBX1\n${payload.byteLength}\n`);
  realStdoutWrite(payload);
}

main().catch((err) => {
  // Structured on stderr; the parent maps the leading token to a typed OperationError.
  process.stderr.write(`CBXERR ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(3);
});
