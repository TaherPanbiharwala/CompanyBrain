// bun run ingest-file <path> [--slug s] [--title t] [--scope private|workspace] [--kind k] [--tag a --tag b]
//
// Reads the file LOCALLY and calls importFile with its bytes. The path never crosses a trust
// boundary — it is resolved by this process, on the operator's own machine, from an argument they
// typed. That is precisely the property the `ingest_file` OP cannot have: /api/_ops is
// unauthenticated (D53) and any `member` can call it, so a path parameter there would be a request
// for the server to read its own filesystem (D83).
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { assertMembership } from '../src/auth/membership.ts';
import { importFile } from '../src/ingest/file.ts';
import { formatLocator } from '../src/ingest/blocks.ts';
import { withScopedTx, closePools } from '../src/db/client.ts';
import { PACK_KINDS, DEFAULT_PACK_KIND, type PackKind } from '../src/core/pack.ts';
import { PAGE_SCOPES, DEFAULT_PAGE_SCOPE, type PageScope } from '../src/core/context.ts';
import { OperationError } from '../src/api/errors.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function flagAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

/** Derive a legal slug from a filename, matching the op's own charset so the CLI and the API cannot
 *  disagree about what is acceptable. */
function slugFromFilename(name: string): string {
  const stem = basename(name, extname(name));
  return (
    stem
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200) || 'document'
  );
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || path.startsWith('--')) {
    console.error('usage: bun run ingest-file <path> [--slug s] [--title t] [--scope private|workspace] [--kind k] [--tag t]...');
    process.exit(2);
  }

  const principal = process.env.CB_CLI_PRINCIPAL;
  const workspaceId = process.env.CB_CLI_WORKSPACE;
  if (!principal || !workspaceId) {
    console.error('set CB_CLI_PRINCIPAL and CB_CLI_WORKSPACE first (run: bun run seed:a17)');
    process.exit(2);
  }

  const scope = (flag('scope') ?? DEFAULT_PAGE_SCOPE) as PageScope;
  if (!PAGE_SCOPES.includes(scope)) {
    console.error(`--scope must be one of: ${PAGE_SCOPES.join(', ')}`);
    process.exit(2);
  }
  const kind = (flag('kind') ?? DEFAULT_PACK_KIND) as PackKind;
  if (!PACK_KINDS.includes(kind)) {
    console.error(`--kind must be one of: ${PACK_KINDS.join(', ')}`);
    process.exit(2);
  }

  const bytes = new Uint8Array(await readFile(path));
  // The role comes from the DATABASE, not from the environment — assertMembership reads it through
  // a SECURITY DEFINER function and throws if the pair is not a membership. Hardcoding `role:
  // 'owner'` here would let a mistyped CB_CLI_WORKSPACE stamp rows for a workspace the principal
  // does not belong to, which RLS would then hide from everyone including whoever wrote them.
  const role = await assertMembership(principal, workspaceId);
  const ctx = buildContext({
    principal,
    workspaceId,
    role,
    grants: resolveGrants(principal, workspaceId),
    remote: false,
  });

  try {
    const r = await importFile(ctx, {
      bytes,
      filename: basename(path),
      slug: flag('slug') ?? slugFromFilename(path),
      title: flag('title'),
      tags: flagAll('tag'),
      scope,
      kind,
    });

    console.log(`ingested ${basename(path)} as ${r.format}`);
    console.log(`  page    ${r.pageId}  (${r.slug})`);
    console.log(`  chunks  ${r.chunkCount}`);
    console.log(`  units   ${r.unitsExtracted} extracted, ${r.unitsSkipped} skipped`);
    console.log(`  sha256  ${r.sha256}`);
    if (r.degraded) {
      // Stated loudly and separately, because a partial extraction is invisible from the outside: a
      // 40-page PDF where 37 pages were scans looks exactly like a clean 3-page ingest.
      console.log('');
      console.log(`  DEGRADED — ${r.unitsSkipped} of ${r.unitsExtracted + r.unitsSkipped} units produced no text.`);
      console.log('  For a PDF this usually means scanned pages with no text layer. OCR is not supported yet.');
    }

    // Show one chunk's citation, so "the locator survived ingest" is visible rather than assumed.
    const sample = await withScopedTx(ctx, (tx) => tx<{ ord: number; locator: unknown }[]>`
      select ord, locator from content_chunks where page_id = ${r.pageId} order by ord limit 3`);
    const cited = sample
      .map((s) => formatLocator((s.locator ?? undefined) as never))
      .filter((s): s is string => Boolean(s));
    if (cited.length) console.log(`  cites   ${cited.join(', ')}${sample.length < r.chunkCount ? ', …' : ''}`);
  } catch (err) {
    if (err instanceof OperationError) {
      // The typed failure paths are the point of the extraction layer; print them as themselves
      // rather than as a stack trace.
      console.error(`\n${err.code}: ${err.message}`);
      if (err.suggestion) console.error(`  → ${err.suggestion}`);
      await closePools({ timeout: 5 });
      process.exit(1);
    }
    throw err;
  }

  await closePools({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(err);
  await closePools({ timeout: 5 });
  process.exit(1);
});
