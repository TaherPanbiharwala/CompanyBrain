// The cheapest guard in the suite: no database, no seeding, no flake, milliseconds.
//
// The leak canary proves the POLICY works. This proves nobody wrote a content query that never
// reaches the policy in the first place. Those are different failures: the canary fires the day
// someone remembers to seed two tenants, this fires the day the mistake is made.
//
// Same mechanical-property shape as test/live-gate.test.ts (D43) — assert the invariant over the
// source tree rather than trusting a convention, so a file written six months from now is covered
// without anyone remembering this file exists.
//
// The rule: any source file naming a content table must either go through withScopedTx (which sets
// app.workspace / app.principal / app.grants, the inputs every content policy reads), or carry an
// explicit `// rls-exempt: <reason>` marker. The marker matters more than the allowlist it
// replaces — `doctor.ts` and `migrate.ts` query these tables on the OWNER pool deliberately, and a
// filename allowlist would have hidden that intent instead of recording it.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const SCANNED_DIRS = ['src', 'scripts'];

// Table names whose reads and writes are governed by an RLS policy.
//
// `pages` needs a preceding keyword because the bare word appears constantly in prose, identifiers
// and paths (`pageCount`, `listPages`, `pages.ts`) and would make this guard fire on comments. The
// other three are unambiguous as bare words — they exist only as tables.
//
// page_sources and quarantine (migration 0009) are here for the same reason content_chunks is, and
// with more at stake: one holds the ORIGINAL BYTES of a document and the other holds the FILENAME
// of a rejected upload, so a query that skips withScopedTx on either leaks the content itself
// rather than a derived chunk.
const CONTENT_TABLES =
  /\b(content_chunks|page_sources|quarantine|from\s+pages|into\s+pages|update\s+pages|join\s+pages)\b/i;
const EXEMPT_MARKER = /\/\/\s*rls-exempt:\s*\S+/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Which handle opened the template literal a query sits in. `tx` is the handle withScopedTx hands
// its callback, and is the ONLY one with the tenancy GUCs set; `sql`, `admin`, `adminSql()` and
// `appSql()` are all unscoped from the policy's point of view (the owner pool bypasses RLS entirely,
// and a bare appSql() call has no GUCs so the policy sees NULL).
//
// Classifying by HANDLE rather than by file is the whole point. The first version of this test
// asked "does the file import withScopedTx", and scripts/measure-a17.ts passed it while running
// `from pages p left join content_chunks c` on adminSql() forty lines away from its only scoped
// call — a live hit, green forever. A guard that can be satisfied by an unrelated import elsewhere
// in the file is not a guard.
// `.unsafe(` is recognised as an opener too. Without it, a content query inside
// `sql.unsafe(\`…\`)` — which migrate.ts uses for DO blocks — does not match here, so the walk-back
// sails past it to whatever ordinary template literal came earlier and reports the handle of an
// unrelated query. That is worse than not matching: it attributes the wrong owner, and the
// exemption marker written next to the real query is outside the window it searches.
const TEMPLATE_OPENER = /\b(tx|sql|admin|adminSql\(\)|appSql\(\)|authSql\(\))(?:\.unsafe)?\s*\(?\s*(<[^`]*>)?\s*`/;

test('every content query runs on a scoped tx handle, or is explicitly exempt with a reason', () => {
  const offenders: string[] = [];

  for (const dir of SCANNED_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      const rel = file.slice(ROOT.length + 1);

      // Only lines that look like SQL touching a content table. Comments mentioning the table by
      // name are everywhere in this repo and are not queries.
      const hits = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(
          ({ line }) =>
            CONTENT_TABLES.test(line) &&
            !line.trim().startsWith('//') &&
            !line.trim().startsWith('--') &&
            !line.trim().startsWith('*'),
        );

      for (const { n } of hits) {
        // Walk back to the nearest template opener and see which handle owns this query.
        //
        // The budget counts NON-COMMENT lines, and is generous. It used to be 40 RAW lines, which
        // quietly encoded "queries are short" — and src/search/hybrid.ts is now a ~170-line statement
        // (four arms, weighted fusion, a per-page cap and a blend, each with its reasoning inline).
        // Every content-table reference past line 40 of it was reported as `handle: unknown`, i.e. as
        // an unscoped query, when the opener was `tx` all along. A guard that cries wolf on the most
        // carefully documented query in the repo gets its window widened by the next person in a
        // hurry, and they will not think about it as carefully as this.
        //
        // Widening does not loosen the rule, because the budget is not what makes this precise: the
        // search stops at the NEAREST opener above the hit, so the handle found is the one that
        // actually opened the literal. The budget only bounds the work. Verified by deliberately
        // planting an unscoped `adminSql()` content query and confirming this still reports it.
        let handle: string | undefined;
        let openerIdx = -1;
        let budget = 200;
        for (let i = n - 1; i >= 0 && budget > 0; i--) {
          const text = (lines[i] ?? '').trim();
          const m = TEMPLATE_OPENER.exec(lines[i] ?? '');
          if (m) {
            handle = m[1];
            openerIdx = i;
            break;
          }
          if (text !== '' && !text.startsWith('--') && !text.startsWith('//') && !text.startsWith('*')) budget--;
        }
        if (handle === 'tx') continue; // scoped: the GUCs are set, the policy applies

        // Unscoped — needs an explicit reason. Anchor the marker to the QUERY (the template
        // opener), not to the line the table name happens to fall on: a SQL literal spans many
        // lines and the reason belongs above the statement, which is where anyone would write it.
        const from = openerIdx >= 0 ? Math.max(0, openerIdx - 6) : Math.max(0, n - 6);
        const to = openerIdx >= 0 ? openerIdx + 1 : n;
        if (EXEMPT_MARKER.test(lines.slice(from, to).join('\n'))) continue;

        offenders.push(`${rel}:${n} (handle: ${handle ?? 'unknown'})`);
      }
    }
  }

  expect(
    offenders,
    `these files query a content table without withScopedTx and without an exemption:\n  ` +
      offenders.join('\n  ') +
      `\n\nA query outside withScopedTx has no app.workspace / app.grants set, so the RLS policy ` +
      `sees NULL and hides everything (fail-closed) — or, on the owner pool, RLS does not apply at ` +
      `all and it sees EVERYTHING. If the latter is intended, add a line comment directly above the ` +
      `query: // rls-exempt: <why this must run unscoped>`,
  ).toEqual([]);
});

test('the scan actually matches something (a guard over zero files proves nothing)', () => {
  // Vacuity check, in the shape D62 taught: a regex that silently stops matching turns this whole
  // file into a permanent green light. Assert the known-good hits are still seen.
  const hybrid = readFileSync(join(ROOT, 'src/search/hybrid.ts'), 'utf8');
  const importer = readFileSync(join(ROOT, 'src/ingest/import.ts'), 'utf8');
  expect(hybrid.split('\n').some((l) => CONTENT_TABLES.test(l))).toBe(true);
  expect(importer.split('\n').some((l) => CONTENT_TABLES.test(l))).toBe(true);
  // …and both are legitimately scoped, which is why they are not offenders above.
  expect(hybrid.includes('withScopedTx')).toBe(true);
  expect(importer.includes('withScopedTx')).toBe(true);
});
