// Reads test/fixtures/a17-corpus/*.md and ingests each via the real `ingest` op (dispatchOp), the
// same ctx-building pattern as src/api/call.ts. Run after `bun run seed:a17` (export its output first).
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { dispatchOp } from '../src/api/dispatch.ts';
import { closePools } from '../src/db/client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, '..', 'test', 'fixtures', 'a17-corpus');

function parseFrontmatter(raw: string): { title: string; tags: string[]; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { title: '', tags: [], body: raw.trim() };
  const [, fm, body] = match;
  const titleMatch = fm!.match(/^title:\s*(.+)$/m);
  const tagsMatch = fm!.match(/^tags:\s*\[(.*)\]$/m);
  const title = titleMatch?.[1]?.trim() ?? '';
  const tags = tagsMatch?.[1] ? tagsMatch[1].split(',').map((t) => t.trim()).filter(Boolean) : [];
  return { title, tags, body: (body ?? '').trim() };
}

async function main(): Promise<void> {
  const principal = process.env.CB_CLI_PRINCIPAL;
  const workspaceId = process.env.CB_CLI_WORKSPACE;
  const role = process.env.CB_CLI_ROLE ?? 'owner';
  if (!principal || !workspaceId) {
    console.error('set CB_CLI_PRINCIPAL and CB_CLI_WORKSPACE first (run: bun run seed:a17)');
    process.exit(2);
  }
  const ctx = buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: false });

  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.md')).sort();
  let failed = 0;
  for (const file of files) {
    const raw = await readFile(join(CORPUS_DIR, file), 'utf8');
    const { title, tags, body } = parseFrontmatter(raw);
    const slug = basename(file, '.md');
    const result = await dispatchOp(ctx, 'ingest', { slug, title: title || slug, body, tags });
    if (result.ok) {
      const data = result.data as { chunkCount: number };
      console.log(`+ ${slug} -> ${data.chunkCount} chunks`);
    } else {
      failed++;
      console.error(`! ${slug} FAILED: ${result.error.code} ${result.error.message}`);
    }
  }
  await closePools({ timeout: 5 });
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
