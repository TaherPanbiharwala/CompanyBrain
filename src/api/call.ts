// `bun run call <op> '<json params>'` — trusted LOCAL dispatch for dogfooding (review AM7).
// Ported from gbrain's handleToolCall/call.ts idea: build a ctx directly (no HTTP, no auth surface)
// and run the op, so you can watch an operation work in seconds. Identity comes from env.
import { buildContext, resolveGrants } from '../core/context.ts';
import { dispatchOp } from './dispatch.ts';

async function main(): Promise<void> {
  const [name, jsonArg] = process.argv.slice(2);
  if (!name) {
    console.error("usage: bun run call <op> '<json params>'   (e.g. bun run call whoami)");
    process.exit(2);
  }
  let params: unknown = {};
  if (jsonArg) {
    try {
      params = JSON.parse(jsonArg);
    } catch {
      console.error('params must be valid JSON');
      process.exit(2);
    }
  }
  const principal = process.env.CB_CLI_PRINCIPAL ?? process.env.CB_MCP_PRINCIPAL;
  const workspaceId = process.env.CB_CLI_WORKSPACE ?? process.env.CB_MCP_WORKSPACE;
  const role = process.env.CB_CLI_ROLE ?? process.env.CB_MCP_ROLE ?? 'owner';
  if (!principal || !workspaceId) {
    console.error('set CB_CLI_PRINCIPAL and CB_CLI_WORKSPACE (uuids of a real membership) in the env.');
    process.exit(2);
  }
  const ctx = buildContext({
    principal,
    workspaceId,
    role,
    grants: resolveGrants(principal, workspaceId),
    remote: false, // trusted local caller
  });
  const result = await dispatchOp(ctx, name, params);
  // Flush stdout THEN exit — an immediate process.exit after console.log can truncate piped output.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => process.exit(result.ok ? 0 : 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
