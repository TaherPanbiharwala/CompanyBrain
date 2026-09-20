// Offline coupling guards for M10 wave 1 sub-step A (migration 0023). Mirrors
// test/link-security-posture.test.ts's shape: migrate.ts re-creates cb_internal definers after the
// migration loop runs, so a body drift there would silently replace the checksummed migration's
// implementation on every subsequent `bun run migrate`. Live doctor only ever sees the replacement —
// this is the test that proves the two sources stay identical.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const migration = readFileSync(join(ROOT, 'src/db/migrations/0023_fact_extraction.sql'), 'utf8');
const hardening = readFileSync(join(ROOT, 'src/db/migrate.ts'), 'utf8');
const lifecycle = readFileSync(join(ROOT, 'src/ingest/lifecycle.ts'), 'utf8');

const DEFINERS = [
  'cycle_fact_extraction_candidates',
  'cycle_write_fact_extraction_stamp',
  'cycle_facts_by_entity',
] as const;

function body(sql: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `CREATE OR REPLACE FUNCTION cb_internal\\.${escapedName}[\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`,
  ).exec(sql);
  expect(match, `${name} must exist with a $fn$ body`).not.toBeNull();
  return match![1]!;
}

describe('M10 fact extraction security posture sources', () => {
  it('the checksummed migration and every-run hardener install identical definer bodies', () => {
    for (const name of DEFINERS) expect(body(hardening, name)).toBe(body(migration, name));
  });

  it('every fact-extraction definer requires the exact cycle system principal', () => {
    for (const name of DEFINERS) {
      for (const sql of [migration, hardening]) {
        expect(body(sql, name)).toContain("'00000000-0000-0000-0000-000000000000'");
      }
    }
  });

  it('the candidate reader filters server-side on the change-detection stamp', () => {
    for (const sql of [migration, hardening]) {
      const candidates = body(sql, 'cycle_fact_extraction_candidates');
      expect(candidates).toContain('facts_extracted_content_hash');
      // NULL content_hash must remain eligible (see this migration's comment) — the OR guard is the
      // whole point of the fix, so assert its presence rather than just the column name.
      expect(candidates).toMatch(/content_hash IS NULL OR/);
    }
  });

  it('the dedup reader ranks in SQL against the embedding index rather than returning raw vectors', () => {
    for (const sql of [migration, hardening]) {
      const dedup = body(sql, 'cycle_facts_by_entity');
      expect(dedup).toContain('ORDER BY f.embedding <=> p_embedding');
      expect(dedup).toContain('similarity');
    }
  });

  it('soft_delete_page(s) propagate to facts.deleted_at, not just content_chunks/page_sources', () => {
    for (const name of ['soft_delete_page', 'soft_delete_pages']) {
      const fn = body(hardening, name);
      expect(fn).toContain('facts_upd');
      expect(fn).toMatch(/UPDATE public\.facts SET deleted_at = now\(\)/);
    }
  });

  it('facts has no ordinary FOR ALL policy — INSERT is cycle-only, UPDATE is acl-only', () => {
    expect(migration).toContain('FOR SELECT TO cb_app');
    expect(migration).toContain('CREATE POLICY facts_cycle_system ON facts\n  FOR INSERT TO cb_app');
    expect(migration).toContain('CREATE POLICY facts_rescope ON facts\n  FOR UPDATE TO cb_app');
    expect(migration).not.toMatch(/CREATE POLICY facts_\w+ ON facts\s+FOR ALL/);
  });

  it('table-level UPDATE is revoked and replaced by a column-restricted grant, atomically and on every run', () => {
    expect(migration).toContain('REVOKE UPDATE, DELETE ON facts FROM cb_app;');
    expect(migration).toContain('GRANT UPDATE (acl) ON facts TO cb_app;');
    expect(hardening).toContain("EXECUTE 'revoke update, delete on facts from cb_app'");
    expect(hardening).toContain("EXECUTE 'grant update (acl) on facts to cb_app'");
  });

  it('rescopePages syncs facts.acl in the same batch as content_chunks.acl, before the page row', () => {
    const chunksIdx = lifecycle.indexOf('update content_chunks set acl');
    const factsIdx = lifecycle.indexOf('update facts set acl');
    const pageIdx = lifecycle.indexOf('update pages set scope =');
    expect(chunksIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(-1);
    expect(pageIdx).toBeGreaterThan(-1);
    expect(chunksIdx).toBeLessThan(pageIdx);
    expect(factsIdx).toBeLessThan(pageIdx);
  });
});
