// One-off admin-pool script: hard-deletes pages soft-deleted (migration 0014) more than the grace
// period ago. No cron/scheduler infrastructure exists in this repo yet (that is M8's job, per
// docs/pipeline-roadmap.md) — run this by hand, or wire it to any external scheduler.
//
// MUST run on the admin pool, not a scoped tx: a soft-deleted row's deleted_at IS NOT NULL, which the
// RLS USING clause (migration 0014) makes invisible to every cb_app connection — a scoped-tx script
// literally cannot see what it needs to purge.
//
//   bun run purge:deleted                          # dry run — the default. Prints counts only.
//   bun run purge:deleted --older-than-days 30      # override the grace period (default 30)
//   bun run purge:deleted --yes-purge               # actually delete
//
// Real DELETE, not another soft-delete: this is the step that lets the existing composite-FK
// ON DELETE CASCADE (0009, D76) reap content_chunks and page_sources automatically — the same
// mechanism a hard delete_page relied on before migration 0014, reused here rather than hand-rolled
// again.
//
// Logging is counts only (D28's rule, one layer out): never a slug, title, or page id.
import { adminSql, closePools } from '../src/db/client.ts';

const DEFAULT_GRACE_DAYS = 30;

function parseIntFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const raw = process.argv[i + 1];
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} must be a non-negative number, got ${raw ?? '(missing)'}`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes-purge');
  const days = parseIntFlag('older-than-days', DEFAULT_GRACE_DAYS);
  const sql = adminSql();

  // rls-exempt: MUST run on the admin pool — a soft-deleted row's deleted_at IS NOT NULL, which the
  // RLS restrictive policy (migration 0016) makes invisible to every cb_app connection, so a scoped
  // read could not see what it needs to count or purge even in principle.
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pages
    where deleted_at is not null and deleted_at < now() - make_interval(days => ${days})`;
  const pageCount = row?.n ?? 0;

  if (pageCount === 0) {
    console.log(`nothing to purge (0 pages soft-deleted more than ${days} day(s) ago)`);
    await closePools({ timeout: 5 });
    return;
  }

  console.log(`${pageCount} page(s) soft-deleted more than ${days} day(s) ago`);

  if (!yes) {
    console.log('DRY RUN — no rows removed. Re-run with --yes-purge to actually delete them.');
    console.log('This is IRREVERSIBLE: their content_chunks and page_sources rows go with them (ON DELETE CASCADE).');
    await closePools({ timeout: 5 });
    return;
  }

  // rls-exempt: same reason as the count above — admin pool, by necessity, not by convenience.
  const gone = await sql<{ id: string }[]>`
    delete from pages
    where deleted_at is not null and deleted_at < now() - make_interval(days => ${days})
    returning id`;
  console.log(`purged ${gone.length} page(s).`);
  await closePools({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(err);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
