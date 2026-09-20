// Offline coupling guards for M9's forward-only security migration. `migrate.ts` re-creates these
// definers after the migration loop, so a body mismatch would silently replace the checksummed
// migration's implementation on every run. Live doctor sees only the replacement; this is the test
// that proves the two sources stay identical.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const migration = readFileSync(join(ROOT, 'src/db/migrations/0022_link_security_hardening.sql'), 'utf8');
const hardening = readFileSync(join(ROOT, 'src/db/migrate.ts'), 'utf8');
const lifecycle = readFileSync(join(ROOT, 'src/ingest/lifecycle.ts'), 'utf8');

const DEFINERS = [
  'sync_link_security_state',
  'cycle_link_pages',
  'cycle_link_page_acls',
  'cycle_lock_link_sources',
] as const;

function body(sql: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `CREATE OR REPLACE FUNCTION cb_internal\\.${escapedName}[\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`,
  ).exec(sql);
  expect(match, `${name} must exist with a $fn$ body`).not.toBeNull();
  return match![1]!;
}

describe('M9 link security posture sources', () => {
  it('the checksummed migration and every-run hardener install identical definer bodies', () => {
    for (const name of DEFINERS) expect(body(hardening, name)).toBe(body(migration, name));
  });

  it('the cycle source lock returns current ACL and content under the same lock', () => {
    for (const sql of [migration, hardening]) {
      expect(sql).toContain(
        'RETURNS TABLE (id uuid, acl text[], body text, extracted_text text)',
      );
      const sourceLock = body(sql, 'cycle_lock_link_sources');
      expect(sourceLock).toContain('FOR UPDATE');
      expect(sourceLock).toContain('SELECT p.id, p.acl, p.body, p.extracted_text');
    }
  });

  it('revokes in-place link mutation both atomically and on every later migration run', () => {
    expect(migration).toContain('REVOKE UPDATE ON links FROM cb_app;');
    expect(hardening).toContain("EXECUTE 'revoke update on links from cb_app'");
  });

  it('orders every multi-page lifecycle lock the same way as the cycle source lock', () => {
    const batchDelete = body(hardening, 'soft_delete_pages');
    expect(batchDelete).toContain('WITH locked AS MATERIALIZED');
    expect(batchDelete).toContain('ORDER BY id\n    FOR UPDATE');

    const movingLock = /select id from pages\s+where id = any\([^)]*moving[^)]*\)[\s\S]*?order by id\s+for update/i;
    expect(lifecycle).toMatch(movingLock);
  });
});
