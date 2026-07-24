// One-time (idempotent) seed for the A17 spike: one hardcoded workspace + owner principal, the
// same "hardcode resolver output" identity every test/CLI already uses (test/rls-smoke.test.ts's
// seeding pattern). Prints the CB_CLI_* env exports the load/eval scripts need.
import { adminSql, closePools } from '../src/db/client.ts';

const SEED_EMAIL = 'a17-founder@example.com';
const SEED_WORKSPACE_NAME = 'A17 Spike Workspace';

async function main(): Promise<void> {
  const admin = adminSql();

  let principalId = (
    await admin<{ id: string }[]>`select id from principals where email_normalized = ${SEED_EMAIL}`
  )[0]?.id;
  if (!principalId) {
    principalId = (
      await admin<{ id: string }[]>`
        insert into principals (email, email_normalized) values (${SEED_EMAIL}, ${SEED_EMAIL}) returning id`
    )[0]!.id;
  }

  let workspaceId = (
    await admin<{ workspace_id: string }[]>`
      select workspace_id from workspace_members where principal_id = ${principalId} limit 1`
  )[0]?.workspace_id;
  if (!workspaceId) {
    workspaceId = (
      await admin<{ id: string }[]>`
        insert into workspaces (name, created_by) values (${SEED_WORKSPACE_NAME}, ${principalId}) returning id`
    )[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${workspaceId}, ${principalId}, 'owner')`;
  }

  console.log(`export CB_CLI_PRINCIPAL=${principalId}`);
  console.log(`export CB_CLI_WORKSPACE=${workspaceId}`);
  console.log('export CB_CLI_ROLE=owner');
  await closePools({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
