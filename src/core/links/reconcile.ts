// links (migration 0021) — the DB-touching wrapper around the pure extractLinks() algorithm.
// Called from two places (src/ingest/{import,file,lifecycle}.ts's synchronous ingest hooks, and
// src/core/cycle/phases/link-extraction.ts's backfill/reconciliation phase) — one implementation,
// not two, so the two call sites can never drift apart.
import type postgres from 'postgres';
import { extractLinks, type LinkCandidate as PureLinkCandidate } from './extract.ts';

interface PageCandidateRow {
  id: string;
  slug: string;
  title: string | null;
  acl: string[];
}

export interface ReconcileLinksParams {
  workspaceId: string;
  pageId: string;
  pageAcl: readonly string[];
  text: string;
}

/**
 * Re-derives every outgoing edge from `pageId`'s current content and replaces its existing rows
 * wholesale — matching `replacePage`'s own established pattern for content_chunks (delete-then-
 * reinsert), not a true add/remove diff. Content-deterministic, so re-running against unchanged
 * content reproduces the same row set; bounded cheaply by MAX_LINKS_PER_PAGE (extract.ts).
 *
 * MUST run on a transaction the caller already holds — this function never opens its own. Pure
 * regex/string work, no I/O, so it's safe inside a transaction alongside other writes (unlike an
 * LLM call — D6's rule is specifically about not holding a transaction open across a provider
 * round-trip, which this never does).
 *
 * No advisory lock: Postgres row locking on the DELETE below already serializes two concurrent
 * reconciliations of the same page (whichever commits second simply overwrites the first's
 * committed state with its own freshly-computed set) — worst case is wasted work, not corruption
 * or a constraint violation.
 */
export async function extractAndReconcileLinks(
  tx: postgres.TransactionSql,
  params: ReconcileLinksParams,
): Promise<{ linksWritten: number }> {
  // RLS-scoped by construction (this runs on the caller's tx) — deleted_at IS NULL is stated
  // explicitly as defense-in-depth even though the restrictive hide-deleted policy already
  // enforces it, since this is the one query in the codebase where getting that wrong would let a
  // reconciliation link TO a soft-deleted page.
  const rows = await tx<PageCandidateRow[]>`
    select id, slug, title, acl from pages
    where workspace_id = ${params.workspaceId} and id <> ${params.pageId} and deleted_at is null`;

  const aclByPageId = new Map(rows.map((r) => [r.id, r.acl] as const));
  const candidates: PureLinkCandidate[] = rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title }));
  const extracted = extractLinks(params.text, candidates);

  await tx`delete from links where from_page_id = ${params.pageId} and workspace_id = ${params.workspaceId}`;
  if (extracted.length === 0) return { linksWritten: 0 };

  const values = extracted.map((link) => ({
    workspace_id: params.workspaceId,
    from_page_id: params.pageId,
    to_page_id: link.toPageId,
    from_acl: params.pageAcl,
    to_acl: aclByPageId.get(link.toPageId) ?? [],
    link_kind: link.linkKind,
    link_source: link.linkSource,
    context: link.context,
  }));
  await tx`
    insert into links ${tx(values, 'workspace_id', 'from_page_id', 'to_page_id', 'from_acl', 'to_acl', 'link_kind', 'link_source', 'context')}`;

  return { linksWritten: extracted.length };
}
