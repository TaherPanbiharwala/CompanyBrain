// Idempotent seed for a dataset's TWO eval workspaces (plain + meta).
//
// Cloned from scripts/seed-a17.ts, with its workspace-resolution bug fixed. seed-a17.ts:22 resolves
//
//     select workspace_id from workspace_members where principal_id = $1 limit 1
//
// which is the principal's FIRST membership, not the workspace it just named. With one workspace per
// principal that is invisible; this script needs two, so the same query would hand back whichever
// row Postgres returned first and the meta corpus would land in the plain workspace. Resolving by
// NAME joined to the membership is what makes two workspaces per principal representable at all.
//
// Human text goes to stderr, `export` lines to stdout, so this works:
//     eval "$(bun run --silent seed:eval --dataset multihop)"
import { adminSql, closePools } from '../src/db/client.ts';
import {
  parseArgs, say, readState, writeState, workspaceName, VARIANTS, STATE_PATH,
  type DatasetState, type WorkspaceRecord, type Variant,
} from './eval-common.ts';

async function ensurePrincipal(admin: ReturnType<typeof adminSql>, email: string): Promise<string> {
  const existing = await admin<{ id: string }[]>`
    select id from principals where email_normalized = ${email}`;
  if (existing[0]) return existing[0].id;
  const created = await admin<{ id: string }[]>`
    insert into principals (email, email_normalized) values (${email}, ${email}) returning id`;
  return created[0]!.id;
}

async function ensureWorkspace(
  admin: ReturnType<typeof adminSql>,
  principalId: string,
  name: string,
): Promise<WorkspaceRecord> {
  // Resolve by NAME, joined through the membership — see the header. Selecting every match rather
  // than `limit 1` so an ambiguous state is reported instead of silently resolved.
  const found = await admin<{ id: string }[]>`
    select w.id
    from workspaces w
    join workspace_members m on m.workspace_id = w.id
    where m.principal_id = ${principalId} and w.name = ${name}
    order by w.id`;

  if (found.length > 1) {
    throw new Error(
      `two or more workspaces named "${name}" are visible for this principal ` +
        `(${found.map((r) => r.id).join(', ')}) — refusing to guess which one the corpus belongs in.\n` +
        `Delete the duplicates, or pass an explicit workspace id.`,
    );
  }
  if (found[0]) return { workspaceId: found[0].id, name };

  const created = await admin<{ id: string }[]>`
    insert into workspaces (name, created_by) values (${name}, ${principalId}) returning id`;
  const workspaceId = created[0]!.id;
  await admin`
    insert into workspace_members (workspace_id, principal_id, role)
    values (${workspaceId}, ${principalId}, 'owner')`;
  return { workspaceId, name };
}

const HELP = `
bun run seed:eval [--dataset <name>]

Creates (idempotently) the two workspaces an eval corpus needs: "<dataset> eval (plain)" and
"<dataset> eval (meta)". Records their ids in eval/.eval-workspaces.json so load:eval and eval:rag
never have to trust an exported CB_CLI_WORKSPACE.

  --dataset <name>   Default: multihop.
  --help             This text.

Human output goes to stderr and the export line to stdout, so this works:
  eval "$(bun run --silent seed:eval --dataset multihop)"
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    say(HELP);
    return;
  }
  const args = parseArgs(argv);
  const { dataset } = args;
  const seedEmail = `${dataset}-eval@example.com`;

  const admin = adminSql();
  const principalId = await ensurePrincipal(admin, seedEmail);

  const workspaces = {} as Record<Variant, WorkspaceRecord>;
  for (const variant of VARIANTS) {
    workspaces[variant] = await ensureWorkspace(admin, principalId, workspaceName(dataset, variant));
    say(`  ${variant.padEnd(5)} -> ${workspaces[variant].workspaceId}  "${workspaces[variant].name}"`);
  }

  const entry: DatasetState = {
    principalId,
    seedEmail,
    seededAt: new Date().toISOString(),
    workspaces,
  };
  const state = readState();
  state[dataset] = entry;
  writeState(state);

  say(`\nRecorded in ${STATE_PATH} — load:eval and eval:rag read it directly, so you do not have to`);
  say(`keep CB_CLI_* exported (and cannot accidentally point them at the a17 workspace).`);
  say(`\nNext:  bun run load:eval --dataset ${dataset}`);

  // stdout stays pure shell. CB_CLI_PRINCIPAL is emitted for the other tools in this repo that
  // expect it; the workspace is deliberately NOT exported, because there are two of them and a
  // single CB_CLI_WORKSPACE could only ever name one.
  process.stdout.write(`export CB_CLI_PRINCIPAL=${principalId}\n`);

  await closePools({ timeout: 5 });
}

main().catch(async (err) => {
  say(`\nseed failed: ${(err as Error).message}`);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
