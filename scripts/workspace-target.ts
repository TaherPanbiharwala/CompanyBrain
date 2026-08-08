// Which corpus a measurement script is about to measure — resolved once, in one place, and always
// printed by NAME.
//
// This exists because of a specific failure. scripts/measure-a17.ts picked its target with
// `order by count(c.id) desc limit 1` and printed only the workspace UUID. When the MultiHop-RAG
// corpus was loaded, the biggest tenant stopped being the A17 spike workspace and the script
// silently began measuring something else — under the name `measure:a17`, against a baseline
// recorded on a 14-chunk corpus. Nothing was wrong with any individual number; the numbers were just
// no longer about the same thing, and the output could not say so.
//
// So: the name is always printed, and `--workspace` makes the choice explicit when it matters.
import type postgres from 'postgres';

export interface WorkspaceTarget {
  id: string;
  name: string;
  ownerPrincipal: string;
  pages: number;
  chunks: number;
  /** True when no --workspace was given and this is simply the biggest tenant. Callers say so in
   *  their output, because "the largest corpus" is a moving target and the reader deserves to know
   *  the script chose rather than was told. */
  auto: boolean;
}

interface Row {
  id: string;
  name: string;
  owner_principal: string;
  pages: number;
  chunks: number;
}

/** `--workspace <name-substring | uuid>` from argv, if present. */
export function workspaceFlag(argv: readonly string[] = process.argv): string | undefined {
  const i = argv.indexOf('--workspace');
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Resolve the workspace to measure, on the OWNER pool.
 *
 * @param wanted a case-insensitive substring of the workspace name, or its exact uuid. Omit to take
 *               the largest by chunk count.
 * @throws when `wanted` matches no workspace, or matches more than one — an ambiguous match silently
 *         resolved is the same class of bug this module exists to prevent.
 */
export async function resolveWorkspaceTarget(
  sql: postgres.Sql,
  wanted?: string,
): Promise<WorkspaceTarget> {
  // rls-exempt: corpus sizing across ALL tenants, on the owner pool. "Which workspace holds the most
  // chunks" and "what is that workspace called" are questions the app role cannot answer by
  // construction — a scoped read only ever sees one workspace, which is the property the whole
  // security model exists to provide. Names and counts only, never content, never in the request
  // path. Measurement scripts only; nothing here is reachable from src/.
  const rows = await sql<Row[]>`
    select w.id, w.name,
           min(p.owner_principal)     as owner_principal,
           count(distinct p.id)::int  as pages,
           count(c.id)::int           as chunks
    from workspaces w
    join pages p on p.workspace_id = w.id
    left join content_chunks c on c.page_id = p.id
    group by w.id, w.name
    having count(c.id) > 0
    order by count(c.id) desc`;

  if (rows.length === 0) {
    throw new Error('no corpus found in any workspace — run `bun run load:a17` first');
  }

  if (wanted === undefined) {
    const top = rows[0]!;
    return { id: top.id, name: top.name, ownerPrincipal: top.owner_principal, pages: top.pages, chunks: top.chunks, auto: true };
  }

  const needle = wanted.toLowerCase();
  const matches = rows.filter((r) => r.id === wanted || r.name.toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new Error(
      `no workspace matching ${JSON.stringify(wanted)}. Workspaces with content:\n` +
        rows.map((r) => `  ${String(r.chunks).padStart(6)} chunks  ${r.name}`).join('\n'),
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${JSON.stringify(wanted)} matches ${matches.length} workspaces — name one exactly, or pass its id:\n` +
        matches.map((r) => `  ${r.id}  ${r.name}`).join('\n'),
    );
  }
  const m = matches[0]!;
  return { id: m.id, name: m.name, ownerPrincipal: m.owner_principal, pages: m.pages, chunks: m.chunks, auto: false };
}

/** The one line every measurement script prints before any timing. Names the corpus, and says
 *  whether the script chose it or was told. */
export function describeTarget(t: WorkspaceTarget): string {
  return (
    `corpus: ${t.pages} pages / ${t.chunks} chunks in "${t.name}" (${t.id})` +
    (t.auto ? '  [largest tenant — auto-selected; pass --workspace to pin it]' : '')
  );
}
