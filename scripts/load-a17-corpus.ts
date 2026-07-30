// Reads test/fixtures/a17-corpus/*.md and ingests each via the real `ingest` op (dispatchOp), the
// same ctx-building pattern as src/api/call.ts. Run after `bun run seed:a17` (export its output first).
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { assertMembership } from '../src/auth/membership.ts';
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
  if (!principal || !workspaceId) {
    console.error('set CB_CLI_PRINCIPAL and CB_CLI_WORKSPACE first (run: bun run seed:a17)');
    process.exit(2);
  }
  // D25: the env names the pair; the database supplies the authoritative role.
  const role = await assertMembership(principal, workspaceId);
  const ctx = buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: false });

  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.md')).sort();
  let failed = 0;

  // Bounded concurrency, not a bare Promise.all over every file. Each ingest holds one pooled
  // connection for its whole transaction, so unbounded fan-out would exhaust DB_POOL_MAX (10) and
  // the surplus would just queue — with the added downside that a burst of embedding calls goes out
  // at once. Four is comfortably under the pool and still hides most of the round-trip latency.
  // Files are consumed from one shared cursor so a slow document does not stall a whole batch.
  const CONCURRENCY = 4;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const file = files[i];
      if (!file) return;
      const raw = await readFile(join(CORPUS_DIR, file), 'utf8');
      const { title, tags, body } = parseFrontmatter(raw);
      const slug = basename(file, '.md');
      const result = await dispatchOp(ctx, 'ingest', { slug, title: title || slug, body, tags }, {
        unmetered:
          'corpus seeding: the whole job is a deliberate burst on a dedicated local principal, and a ' +
          'throttled load:a17 would fail partway with no resume path. Today the corpus is well under ' +
          'the 120/min ceiling, but that is an accident of its size, not a property of the script.',
      });
      if (result.ok) {
        const data = result.data as { chunkCount: number };
        console.log(`+ ${slug} -> ${data.chunkCount} chunks`);
      } else {
        failed++;
        console.error(`! ${slug} FAILED: ${result.error.code} ${result.error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  await closePools({ timeout: 5 });
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
