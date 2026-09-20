// links (migration 0021) — the DB-touching wrapper around the pure extractLinks() algorithm.
// Called from synchronous ingest hooks and the link-extraction cycle phase — one implementation,
// not two, so the two paths cannot drift apart.
import type postgres from 'postgres';
import { extractLinks, type LinkCandidate as PureLinkCandidate } from './extract.ts';

export interface LinkCandidateRow extends PureLinkCandidate {}

interface PageCandidateAclRow {
  id: string;
  acl: string[];
}

interface SourcePageRow {
  id: string;
  body: string | null;
  extracted_text: string | null;
  acl: string[];
}

export interface ReconcileLinksParams {
  workspaceId: string;
  pageId: string;
  /**
   * Kept for compatibility with M9's existing ingest call sites. Deliberately ignored: from_acl is
   * copied from the source row while it is locked, never trusted from a potentially stale caller.
   */
  pageAcl: readonly string[];
  text: string;
}

export interface ReconcileLinkBatchParams {
  workspaceId: string;
  sourceRows: readonly SourcePageRow[];
  candidates: readonly LinkCandidateRow[];
}

export interface ReconcileLinkBatchResult {
  pageIds: string[];
  linksWritten: number;
  /** In-memory extraction failures only. Any database error aborts the entire transaction so the
   * caller can replay this batch from its prior checkpoint. */
  failures: Array<{ pageId: string; error: unknown }>;
}

/** The cycle SECURITY DEFINER functions reject arrays larger than this. Keep the client-side
 * chunk explicit so a high-fan-out 200-page batch cannot cross that security boundary. */
export const CYCLE_DEFINER_PAGE_ID_LIMIT = 1000;

/** One link row currently expands to nine bind parameters. 5,000 rows therefore use at most
 * 45,000 parameters, safely below PostgreSQL's 65,535 extended-query limit with room for a future
 * derived column. A full 200 x 50-fan-out cycle batch is emitted as two inserts. */
export const LINK_INSERT_BATCH_SIZE = 5000;

interface PlannedSource {
  source: SourcePageRow;
  links: ReturnType<typeof extractLinks>;
}

type TargetAclResolver = (
  tx: postgres.TransactionSql,
  workspaceId: string,
  targetIds: readonly string[],
) => Promise<Map<string, string[]>>;

/** Resolve current target ACLs while the transaction holds the workspace link advisory lock. */
async function currentTargetAcls(
  tx: postgres.TransactionSql,
  workspaceId: string,
  targetIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (targetIds.length === 0) return new Map();
  const rows = await tx<PageCandidateAclRow[]>`
    select id, acl from pages
    where workspace_id = ${workspaceId}
      and id = any(${targetIds}::uuid[])
      and deleted_at is null`;
  return new Map(rows.map((row) => [row.id, row.acl] as const));
}

/** Cycle-only equivalent of currentTargetAcls. The definer validates the exact system principal,
 * current workspace, and bounded input, then acquires the link advisory lock reentrantly before
 * returning current ACLs without page-row locks. */
async function cycleTargetAcls(
  tx: postgres.TransactionSql,
  _workspaceId: string,
  targetIds: readonly string[],
): Promise<Map<string, string[]>> {
  const resolved = new Map<string, string[]>();
  for (let start = 0; start < targetIds.length; start += CYCLE_DEFINER_PAGE_ID_LIMIT) {
    const chunk = targetIds.slice(start, start + CYCLE_DEFINER_PAGE_ID_LIMIT);
    const rows = await tx<PageCandidateAclRow[]>`
      select id, acl from cb_internal.cycle_link_page_acls(${chunk}::uuid[])`;
    for (const row of rows) resolved.set(row.id, row.acl);
  }
  return resolved;
}

/** Serialize ordinary ingest reconciliation against page ACL/deletion propagation. The page-sync
 * trigger and cycle definers use this byte-for-byte key expression too. Source row lock comes first
 * everywhere; target rows are never locked, preventing reciprocal-edge deadlocks. */
async function lockLinkWorkspace(
  tx: postgres.TransactionSql,
  workspaceId: string,
): Promise<void> {
  await tx`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('company-brain:links:' || ${workspaceId}::text, 0)
    )`;
}

/** Replace every successful source's outgoing edges in one DELETE and one INSERT. */
async function replacePlannedLinks(
  tx: postgres.TransactionSql,
  workspaceId: string,
  planned: readonly PlannedSource[],
  resolveTargetAcls: TargetAclResolver = currentTargetAcls,
): Promise<number> {
  if (planned.length === 0) return 0;

  const targetIds = [...new Set(planned.flatMap(({ links }) => links.map((link) => link.toPageId)))];
  const targetAcls = await resolveTargetAcls(tx, workspaceId, targetIds);
  const sourceIds = planned.map(({ source }) => source.id);

  // Both public entry points hold stable source-row locks before this DELETE. DELETE is not itself
  // the lock: in the empty-initial-state case there is no links row for it to serialize on.
  await tx`
    delete from links
    where workspace_id = ${workspaceId} and from_page_id = any(${sourceIds}::uuid[])`;

  const values = planned.flatMap(({ source, links }) => links.flatMap((link) => {
    const toAcl = targetAcls.get(link.toPageId);
    // A target may have been deleted or moved out of this transaction's RLS visibility after the
    // candidate catalog was loaded. It is no longer a valid edge target in this transaction.
    if (!toAcl) return [];
    return [{
      workspace_id: workspaceId,
      from_page_id: source.id,
      to_page_id: link.toPageId,
      from_acl: source.acl,
      to_acl: toAcl,
      link_kind: link.linkKind,
      link_source: link.linkSource,
      context: link.context,
    }];
  }));

  for (let start = 0; start < values.length; start += LINK_INSERT_BATCH_SIZE) {
    const chunk = values.slice(start, start + LINK_INSERT_BATCH_SIZE);
    await tx`
      insert into links ${tx(chunk, 'workspace_id', 'from_page_id', 'to_page_id', 'from_acl', 'to_acl', 'link_kind', 'link_source', 'context')}`;
  }
  return values.length;
}

/**
 * Re-derive one source page's outgoing edges. The source page is the serialization row: locking it
 * before candidate discovery makes two concurrent first-time reconciliations safe even when the
 * links table has no existing row for DELETE to lock.
 */
export async function extractAndReconcileLinks(
  tx: postgres.TransactionSql,
  params: ReconcileLinksParams,
): Promise<{ linksWritten: number }> {
  const [source] = await tx<Pick<SourcePageRow, 'id' | 'acl'>[]>`
    select id, acl from pages
    where workspace_id = ${params.workspaceId} and id = ${params.pageId} and deleted_at is null
    for update`;
  if (!source) return { linksWritten: 0 };

  await lockLinkWorkspace(tx, params.workspaceId);

  const rows = await tx<LinkCandidateRow[]>`
    select id, slug, title from pages
    where workspace_id = ${params.workspaceId} and id <> ${params.pageId} and deleted_at is null`;
  const links = extractLinks(params.text, rows);
  const linksWritten = await replacePlannedLinks(tx, params.workspaceId, [{
    source: { ...source, body: null, extracted_text: null },
    links,
  }]);
  return { linksWritten };
}

/**
 * Reconcile one already-keyset-paginated source batch. The caller supplies page snapshots from the
 * cycle-only definer, while this least-privilege transaction locks every source row it can see and
 * derives current source ACLs before writing. The normal workspace-visible path therefore uses one
 * short transaction per ~200 pages, not one per page.
 */
export async function extractAndReconcileLinkBatch(
  tx: postgres.TransactionSql,
  params: ReconcileLinkBatchParams,
): Promise<ReconcileLinkBatchResult> {
  if (params.sourceRows.length === 0) return { pageIds: [], linksWritten: 0, failures: [] };

  const requestedIds = params.sourceRows.map((row) => row.id);
  const lockedRows = await tx<SourcePageRow[]>`
    select id, acl, body, extracted_text
    from cb_internal.cycle_lock_link_sources(${requestedIds}::uuid[])`;
  const lockedById = new Map(lockedRows.map((row) => [row.id, row] as const));

  const planned: PlannedSource[] = [];
  const failures: ReconcileLinkBatchResult['failures'] = [];
  for (const snapshot of params.sourceRows) {
    const locked = lockedById.get(snapshot.id);
    // A row can disappear between the catalog snapshot and this lock call because it was deleted.
    if (!locked) continue;
    try {
      const text = locked.body ?? locked.extracted_text ?? '';
      const candidates = params.candidates.filter((candidate) => candidate.id !== snapshot.id);
      planned.push({ source: { ...snapshot, ...locked }, links: text ? extractLinks(text, candidates) : [] });
    } catch (error) {
      // Isolate only this page's in-memory extraction error: keep its last known-good edges and let
      // other pages commit. SQL errors are intentionally not caught and abort the entire batch.
      failures.push({ pageId: snapshot.id, error });
    }
  }

  const linksWritten = await replacePlannedLinks(tx, params.workspaceId, planned, cycleTargetAcls);
  return { pageIds: planned.map(({ source }) => source.id), linksWritten, failures };
}
