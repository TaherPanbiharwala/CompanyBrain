// The extraction entry point: detect in-process, extract out-of-process.
//
// Everything hostile happens in a child with no environment. Everything cheap and safe — magic-byte
// detection, rejecting an unsupported format — happens here, so an unsupported upload never pays to
// spawn anything.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Extracted } from '../blocks.ts';
import { detect, remediationFor } from './detect.ts';
import { OperationError } from '../../api/errors.ts';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'worker.ts');

/**
 * An empty directory to run the child in, created ONCE per process.
 *
 * `env: { PATH }` is necessary but NOT sufficient, and that gap was live: Bun's runtime auto-loads
 * a `.env` file from the child's WORKING DIRECTORY, and the API process runs from the repo root
 * where `.env` sits. So the child was handed DATABASE_URL, OPENAI_API_KEY, SESSION_SECRET,
 * CB_APP_DB_PASSWORD and OPENROUTER_API_KEY despite the explicit env — measured, not theorised.
 *
 * Running from a directory with no `.env` closes it (Bun does not walk up to parent directories).
 * The old test asserted only the SHAPE of this call in the source, which stayed correct the whole
 * time the leak was live — so the replacement test in test/extract.test.ts spawns a child and reads
 * its actual environment instead.
 */
const CHILD_CWD = mkdtempSync(join(tmpdir(), 'cb-extract-'));

/** Hard ceiling on what the child may write back. The 5 MB input cap does NOT bound the output —
 *  a spreadsheet expands enormously — and this buffer is materialised in the API process, next to
 *  the connection pool and the keys. Without it the subprocess bounds a parser CRASH but not a
 *  parser BOMB, which is half the property the design claims. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Wall-clock ceiling for one file. A parser stuck in native code ignores SIGTERM, which is why the
 *  kill escalates rather than trusting the first signal. */
const EXTRACT_TIMEOUT_MS = 60_000;
const SIGKILL_GRACE_MS = 2_000;

/** A subprocess bounds the blast radius of one parse; it does NOT bound memory across many. The API
 *  process accepts requests far faster than a PDF parses, so without a gate a burst of uploads spawns
 *  a Bun process per request, each loading three parsers, and the HOST dies rather than the child. */
const MAX_CONCURRENT = 3;

/** How many requests may WAIT for a slot. The gate bounded subprocesses but not the queue in front
 *  of them, so a burst parked unbounded callers — each pinning its decoded bytes plus the ~6.7 MB
 *  base64 string that produced them — for as long as it took. Shedding is the honest answer: the
 *  client has usually given up long before a deep-queued request would have run. */
const MAX_WAITING = 12;

/** How long a request may wait for a slot before giving up. Three slots x a 60s parse means a
 *  full queue can legitimately take minutes; past this the caller is certainly gone. */
const MAX_WAIT_MS = 30_000;

let active = 0;
const waiting: { resolve: () => void; reject: (e: Error) => void }[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  if (waiting.length >= MAX_WAITING) {
    throw new OperationError(
      'rate_limited',
      'too many uploads are being processed right now',
      'Retry in a few seconds. Extraction runs a bounded number of parsers at a time.',
    );
  }
  await new Promise<void>((resolve, reject) => {
    const entry = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (e: Error) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    const timer = setTimeout(() => {
      const i = waiting.indexOf(entry);
      if (i !== -1) waiting.splice(i, 1);
      entry.reject(
        new OperationError(
          'rate_limited',
          'timed out waiting for an extraction slot',
          'Retry in a few seconds.',
        ),
      );
    }, MAX_WAIT_MS);
    waiting.push(entry);
  });
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.resolve();
}

/** Read a stream to completion, refusing to buffer more than `cap`. Returns `overflow` rather than
 *  throwing so the caller can kill the child before unwinding — a throw from inside the drain would
 *  leave the other pipe and the process itself unattended. */
async function drain(
  stream: ReadableStream<Uint8Array> | null,
  cap = MAX_OUTPUT_BYTES,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  if (!stream) return { bytes: new Uint8Array(0), overflow: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  for await (const c of stream) {
    if (total + c.byteLength > cap) {
      overflow = true;
      break;
    }
    chunks.push(c);
    total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { bytes: out, overflow };
}

/** `CBX1\n<len>\n<json>`. The declared length is what separates "killed mid-write" from "something
 *  else wrote to stdout" — two failures with identical symptoms and different fixes. */
function parseFramed(buf: Uint8Array): Extracted {
  const text = new TextDecoder().decode(buf);
  if (!text.startsWith('CBX1\n')) {
    throw new OperationError(
      'extraction_failed',
      'the extractor produced unreadable output',
      'This is a bug rather than a problem with your file. The server log has the detail.',
    );
  }
  const second = text.indexOf('\n', 5);
  const declared = Number(text.slice(5, second));
  const body = text.slice(second + 1);
  const actualBytes = Buffer.byteLength(body, 'utf8');
  if (!Number.isFinite(declared) || actualBytes < declared) {
    throw new OperationError(
      'extraction_failed',
      'extraction was cut short — the file may be too large or too complex',
      'Try a smaller file, or split it.',
    );
  }
  return JSON.parse(body) as Extracted;
}

function mapWorkerError(stderr: string, exitCode: number | null): OperationError {
  const line = stderr.split('\n').find((l) => l.startsWith('CBXERR ')) ?? '';
  const msg = line.slice('CBXERR '.length);

  if (msg.startsWith('PASSWORD_PROTECTED')) {
    return new OperationError(
      'extraction_failed',
      'this PDF is password-protected',
      'Remove the password (open it, then Print to PDF or Save As without protection) and upload again.',
    );
  }
  // 137 = 128 + SIGKILL. Either the timeout escalation or the OS OOM killer — from the caller's side
  // both mean "this file was too much", which is a size problem, not an internal error.
  if (exitCode === 137) {
    return new OperationError(
      'payload_too_large',
      'the file exhausted the extractor before it finished',
      'Split it into smaller files and upload them separately.',
    );
  }
  if (/UNREADABLE/.test(msg)) {
    return new OperationError(
      'extraction_failed',
      'the file could not be read — it may be corrupt or not really the format its name suggests',
      'Open it locally to confirm it works, then re-save and try again.',
    );
  }
  return new OperationError(
    'extraction_failed',
    'the file could not be processed',
    'The server log has the detail; reference the reqId.',
  );
}

export interface ExtractResult extends Extracted {
  /** Echoed so callers do not re-sniff; the parent's detection is authoritative. */
  detectedFormat: Extracted['format'];
  /** Library and version that produced the text, e.g. `unpdf@1.8.0`. Stored on `pages.extractor`. */
  extractor: string;
}

/**
 * Which library produced the text for each format.
 *
 * Recorded per page because re-chunking REUSES `pages.extracted_text` instead of re-running the
 * parsers, and parser output is not stable across versions — a page whose text came from unpdf 1.8
 * and one re-extracted under 2.0 can legitimately differ, and without this column nothing could tell
 * them apart or decide which pages need redoing.
 *
 * Hardcoded rather than read from package.json at runtime, and kept honest by
 * test/extract.test.ts, which parses package.json and fails if these drift. A version string that
 * silently lags the dependency is worse than none: it would assert provenance that is false.
 */
const EXTRACTOR_VERSIONS = { unpdf: '1.8.0', mammoth: '1.12.0', xlsx: '0.20.3' } as const;

export function extractorFor(format: Extracted['format']): string {
  switch (format) {
    case 'pdf':
      return `unpdf@${EXTRACTOR_VERSIONS.unpdf}`;
    case 'docx':
      return `mammoth@${EXTRACTOR_VERSIONS.mammoth}`;
    case 'xlsx':
      return `xlsx@${EXTRACTOR_VERSIONS.xlsx}`;
    // csv/json/html/markdown/text are parsed in-repo, so the thing that can change their output is
    // this codebase — which git already versions better than a string here could.
    default:
      return `company-brain/${format}`;
  }
}

export { EXTRACTOR_VERSIONS };

export async function extractFile(bytes: Uint8Array, filename = ''): Promise<ExtractResult> {
  const d = detect(bytes, filename);
  if (d.format === 'unsupported') {
    throw new OperationError(
      'unsupported_format',
      `this looks like ${d.looksLike ?? 'a format that is not supported'}`,
      remediationFor(d.looksLike),
    );
  }

  await acquire();
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    proc = Bun.spawn(['bun', 'run', WORKER, d.format], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      // BOTH of these are load-bearing, and the second one is the non-obvious half.
      //
      // `env` replaces the inherited environment — without it Bun.spawn hands the child every
      // secret this process holds. But Bun's runtime ALSO auto-loads `.env` from the child's
      // working directory, and the server runs from the repo root where `.env` lives, so the
      // explicit env alone still leaked DATABASE_URL / OPENAI_API_KEY / SESSION_SECRET /
      // CB_APP_DB_PASSWORD / OPENROUTER_API_KEY. CHILD_CWD is an empty temp dir, which closes it.
      //
      // test/extract.test.ts asserts this by READING THE CHILD'S ACTUAL ENVIRONMENT. The previous
      // source-regex assertion passed throughout the period this leaked.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      cwd: CHILD_CWD,
    });

    timer = setTimeout(() => {
      timedOut = true;
      proc?.kill(); // SIGTERM first…
      killer = setTimeout(() => proc?.kill(9), SIGKILL_GRACE_MS); // …then SIGKILL, for native code
    }, EXTRACT_TIMEOUT_MS);

    // Write and drain CONCURRENTLY, and finish draining BEFORE awaiting exit. The pipe buffer is
    // ~64KB; a 200-page PDF's JSON is megabytes. Awaiting `exited` first deadlocks — the child blocks
    // writing, the parent blocks waiting for a child that cannot finish — and it presents as "the
    // timeout fires on every real file", which sends you looking at the timeout.
    //
    // The stdin write is guarded: a worker that dies during module load (a broken parser install)
    // closes the pipe, and the resulting EPIPE would otherwise escape the orchestration entirely,
    // skipping the exit-code handling below and leaving the real cause invisible.
    const writing = (async () => {
      try {
        const w = proc!.stdin as unknown as { write: (b: Uint8Array) => void; end: () => void };
        w.write(bytes);
        w.end();
      } catch {
        // The child is already gone; its exit code and stderr below are the real diagnosis.
      }
    })();
    const [, stdout, stderr] = await Promise.all([writing, drain(proc.stdout), drain(proc.stderr)]);

    if (stdout.overflow) {
      throw new OperationError(
        'payload_too_large',
        'the document expanded beyond what can be processed',
        'This file produces far more extracted content than its size suggests. Split it and retry.',
      );
    }

    const code = await proc.exited;

    if (timedOut) {
      throw new OperationError(
        'extraction_failed',
        'extraction timed out',
        'The file is unusually large or complex. Try splitting it.',
      );
    }
    if (code !== 0) {
      const err = mapWorkerError(new TextDecoder().decode(stderr.bytes), code);
      console.error(`[extract] worker exit ${code} for ${d.format}: ${new TextDecoder().decode(stderr.bytes).slice(0, 500)}`);
      throw err;
    }

    const extracted = parseFramed(stdout.bytes);
    return { ...extracted, detectedFormat: extracted.format, extractor: extractorFor(extracted.format) };
  } finally {
    if (timer) clearTimeout(timer);
    if (killer) clearTimeout(killer);
    // Kill BEFORE releasing the slot. Any throw above — an output overflow, an EPIPE, a parse
    // failure — reaches here with the child possibly still running; releasing without killing would
    // hand the slot to the next request while the old process keeps its memory, so MAX_CONCURRENT
    // would stop bounding actual concurrency, which is the one thing it exists to do.
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
      setTimeout(() => proc?.kill(9), SIGKILL_GRACE_MS).unref?.();
    }
    release();
  }
}
