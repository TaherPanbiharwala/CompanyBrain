// The extraction admission gate, which had ZERO test references until this file existed — nothing
// in test/ mentioned MAX_CONCURRENT, MAX_WAITING or acquire. It is the tightest bottleneck in the
// system (3 concurrent subprocesses for EVERY format) and the first thing any bulk client hits, so
// "untested" was the wrong state for it.
//
// Offline by construction: extractFile spawns a subprocess and touches no database, so this suite
// imports nothing from src/db/ and needs no liveOrFail() gate (test/live-gate.test.ts's touchesDb()
// keys on exactly that import).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { OperationError } from '../src/api/errors.ts';
import { extractFile, MAX_CONCURRENT, MAX_WAITING } from '../src/ingest/extract/index.ts';
import { MAX_FILE_BYTES } from '../src/ingest/file.ts';

const TEXT = new TextEncoder().encode(
  '# Fixture\n\nBody text long enough to clear the forty-character sanity floor comfortably.\n',
);

/** Source with comments stripped. Scanning raw source is the trap recorded in this project's own
 *  learnings as `guard-passes-with-subject-deleted`: the identifier you assert on almost always also
 *  appears in a comment in the same file, so the guard stays green with its subject deleted. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('extraction admission gate', () => {
  test(
    'sheds past MAX_CONCURRENT + MAX_WAITING rather than spawning unbounded subprocesses',
    async () => {
      // Fired in ONE tick on purpose. acquire() is synchronous up to its first await, so all N reach
      // the gate before any extraction completes: the first MAX_CONCURRENT take slots, the next
      // MAX_WAITING queue, and everything beyond that is refused immediately. Staggering these would
      // let early parses finish and free slots, and the shed would never fire.
      const n = MAX_CONCURRENT + MAX_WAITING + 5;
      const results = await Promise.allSettled(
        Array.from({ length: n }, (_, i) => extractFile(TEXT, `admission-${i}.md`)),
      );

      const shed = results.filter(
        (r): r is PromiseRejectedResult =>
          r.status === 'rejected' &&
          r.reason instanceof OperationError &&
          r.reason.code === 'rate_limited',
      );

      // The gate must actually fire. Deleting acquire()'s throw turns this to 0 and fails here —
      // which is the property D97 asks for: break the subject AND delete it.
      expect(shed.length).toBeGreaterThan(0);

      // And the ones that got through must still have worked. A gate that sheds everything is not a
      // gate, it is an outage, and `shed.length > 0` alone cannot tell the two apart.
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok.length).toBeGreaterThanOrEqual(MAX_CONCURRENT);

      const err = shed[0]!.reason as OperationError;
      expect(err.message).toContain('too many uploads');
      expect(err.suggestion).toBeTruthy();
    },
    120_000, // 15 real subprocess spawns; the existing live suites use the same order of timeout.
  );

  test('the shed carries a numeric retry-after so a client has something to back off against', async () => {
    const n = MAX_CONCURRENT + MAX_WAITING + 5;
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => extractFile(TEXT, `retry-after-${i}.md`)),
    );
    const shed = results.find(
      (r): r is PromiseRejectedResult =>
        r.status === 'rejected' &&
        r.reason instanceof OperationError &&
        r.reason.code === 'rate_limited',
    );
    expect(shed).toBeDefined();

    // Before this landed, retryAfter was set ONLY at dispatch rung 0, so the 429 a bulk client hits
    // first arrived bare and docs/screens.md's promised countdown was unreachable for it.
    const err = shed!.reason as OperationError;
    expect(typeof err.retryAfter).toBe('number');
    expect(err.retryAfter).toBeGreaterThan(0);

    // It must NOT reach the response body — it is a header, and test/errors.test.ts asserts the wire
    // shape with toEqual, so leaking it here would break that suite instead of this one.
    expect(err.toWire()).not.toHaveProperty('retryAfter');
  }, 120_000);
});

describe('the extraction subprocess does not load document parsers it will not use', () => {
  // Bun.spawn in extract/index.ts is unconditional — every format spawns — and ESM evaluates static
  // dependencies depth-first before the module body. So a static import of the three heavy parsers
  // made a 2 KB markdown file pay to load unpdf + mammoth + SheetJS before reading a byte, directly
  // on the MAX_CONCURRENT=3 bottleneck. Measured: 92ms -> 25ms median once they went lazy.
  const worker = codeOf(`${import.meta.dir}/../src/ingest/extract/worker.ts`);

  test('the heavy parsers are imported lazily, not statically', () => {
    for (const mod of ['./pdf.ts', './docx.ts', './xlsx.ts']) {
      expect(worker).not.toMatch(new RegExp(`^\\s*import\\s[^\\n]*from\\s+'${mod.replace('.', '\\.')}'`, 'm'));
      expect(worker).toContain(`await import('${mod}')`);
    }
  });

  test('text.ts stays static — four formats use it and it has no third-party dependency', () => {
    expect(worker).toMatch(/^\s*import\s+\{[^}]*\}\s+from\s+'\.\/text\.ts'/m);
  });
});

// MAX_FILE_BYTES (src/ingest/file.ts) and MAX_WAITING (src/ingest/extract/index.ts) are coupled
// across two files, and until this existed the binding was a COMMENT.
//
// THE FIRST VERSION OF THIS TEST MODELLED THE WRONG THING, which is worth recording because it is
// the more interesting failure: it counted only "decoded bytes + base64" (2.33x) and multiplied by
// the gate width, matching the comment it was written from. Both were mine, so the test agreed with
// the code for the same wrong reason — a guard derived from the model it is supposed to check
// inherits that model's blind spots.
//
// What a request actually retains at its peak, all live at the final insert:
//   1.00x  the decoded Uint8Array
//   1.33x  the base64 string, reachable via req.body until the response ends
//   1.00x  Buffer.from(bytes) for the page_sources insert
//   2.00x  postgres.js serialises bytea as '\\x' + hex — TWO ascii chars per byte
// = ~5.33x MAX_FILE_BYTES per in-flight upload, not 2.33x.
//
// And the gate now spans the WHOLE upload (withUploadSlot), not just extractFile — embedAll is
// network-bound and can run for minutes while holding all of the above, so gating only the parse
// bounded the cheapest phase.
describe('the file cap and the queue depth stay within a memory ceiling', () => {
  /** Peak retained per in-flight upload, as a multiple of the file size. Derived above, not chosen. */
  const RETAINED_PER_UPLOAD = 1 + 4 / 3 + 1 + 2;
  /** Half of the deployment's 8 GB (Railway, 1 replica, verified from the dashboard rather than
   *  assumed — the previous value here was a guess at "a small container" and was wrong by 8x).
   *  Half, not all: the runtime, the connection pool and every non-upload request live in the other
   *  half. If the plan is ever downsized, this number must come down with it. */
  const CONTAINER_BYTES = 8 * 1024 * 1024 * 1024;
  const CEILING_BYTES = CONTAINER_BYTES / 2;

  test('worst-case in-flight upload memory stays under the ceiling', () => {
    const worstCase = (MAX_CONCURRENT + MAX_WAITING) * RETAINED_PER_UPLOAD * MAX_FILE_BYTES;
    expect(worstCase).toBeLessThanOrEqual(CEILING_BYTES);
    // Anti-vacuity: a ceiling nothing could breach is not a guard. Doubling the file cap must break
    // it, or this passes with the coupling deleted.
    expect((MAX_CONCURRENT + MAX_WAITING) * RETAINED_PER_UPLOAD * MAX_FILE_BYTES * 2).toBeGreaterThan(
      CEILING_BYTES,
    );
  });
});
