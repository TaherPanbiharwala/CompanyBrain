// M8 CLI entrypoint. Mirrors purge-deleted.ts's shape: admin pool enumerates workspaces (inherently
// cross-tenant — a scoped-tx script structurally can't see what it needs), then runCycle() does all
// its actual work through the normal RLS-scoped path, one workspace at a time. One workspace's
// failure never aborts the tick for the others.
//
//   bun run cycle                               # every workspace, every registered phase
//   bun run cycle --workspace <uuid>             # one workspace
//   bun run cycle --phase noop                   # restrict phases (repeatable)
//   bun run cycle --dry-run
//   bun run cycle --lock-ttl-minutes <n>          # override the default 30-minute lock TTL
//
// Never runs `bun run migrate` — assumes the target DB is already migrated, so this can't interact
// with CI's shared-DB migration concurrency guard.
import { adminSql, closePools } from '../src/db/client.ts';
import { registeredPhaseNames, runCycle } from '../src/core/cycle.ts';

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function flagValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const workspaceFilter = flagValue('workspace');
  const phases = flagValues('phase');
  const lockTtlRaw = flagValue('lock-ttl-minutes');
  const lockTtlMinutes = lockTtlRaw ? Number(lockTtlRaw) : undefined;
  if (lockTtlRaw !== undefined && (!Number.isFinite(lockTtlMinutes) || (lockTtlMinutes ?? 0) <= 0)) {
    console.error(`--lock-ttl-minutes must be a positive number, got ${lockTtlRaw}`);
    process.exit(2);
  }
  for (const name of phases) {
    if (!registeredPhaseNames().includes(name)) {
      console.error(`unknown --phase "${name}". Available: ${registeredPhaseNames().join(', ')}`);
      process.exit(2);
    }
  }

  const sql = adminSql();
  // rls-exempt: enumerating workspaces is inherently cross-tenant, same justification as
  // purge-deleted.ts — a scoped-tx connection cannot see across workspaces even in principle.
  const workspaces = workspaceFilter
    ? await sql<{ id: string }[]>`select id from workspaces where id = ${workspaceFilter}`
    : await sql<{ id: string }[]>`select id from workspaces order by created_at`;

  if (workspaces.length === 0) {
    console.log(workspaceFilter ? `no workspace found with id ${workspaceFilter}` : 'no workspaces to run a cycle for');
    await closePools({ timeout: 5 });
    return;
  }

  console.log(`running cycle for ${workspaces.length} workspace(s)${dryRun ? ' (dry run)' : ''}${phases.length ? `, phases: ${phases.join(', ')}` : ''}`);

  let ok = 0;
  let notOk = 0;
  for (const { id } of workspaces) {
    try {
      const report = await runCycle({
        workspaceId: id,
        phases: phases.length ? phases : undefined,
        dryRun,
        lockTtlMinutes,
      });
      console.log(`workspace ${id}: ${report.status}${report.reason ? ` (${report.reason})` : ''} — ${report.phases.map((p) => `${p.phase}=${p.status}`).join(', ') || '(no phases ran)'}`);
      if (report.status === 'ok' || report.status === 'skipped') ok++;
      else notOk++;
    } catch (err) {
      // One workspace's failure must not abort the tick for the others.
      console.error(`workspace ${id}: cycle run threw —`, err);
      notOk++;
    }
  }

  console.log(`done: ${ok} ok/skipped, ${notOk} partial/failed/errored`);
  await closePools({ timeout: 5 });
  if (notOk > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
