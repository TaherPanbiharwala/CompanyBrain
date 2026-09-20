// M9 — the first real M8 cycle-engine consumer. A lightweight candidate catalog is retained once
// per run; source bodies are fetched in keyset pages and released after their ~200-page write
// transaction. Both reads go through a cycle-only SECURITY DEFINER so private and workspace pages
// are included without broadening ordinary page RLS. CPU mention matching remains O(P²) in wave 1,
// but body memory is O(batch size) and remote transactions are O(P / batch size), not one per page.
import { BaseCyclePhase } from '../base-phase.ts';
import { fingerprintParams } from '../checkpoint.ts';
import { extractLinks, type LinkCandidate } from '../../links/extract.ts';
import {
  CYCLE_DEFINER_PAGE_ID_LIMIT,
  extractAndReconcileLinkBatch,
  type LinkCandidateRow,
} from '../../links/reconcile.ts';
import type { PhaseRunner } from '../runner-context.ts';

export const LINK_EXTRACTION_BATCH_SIZE = 200;
export const LINK_CANDIDATE_BATCH_SIZE = CYCLE_DEFINER_PAGE_ID_LIMIT;
const CHECKPOINT_VERSION = 2;

interface CycleLinkPageRow extends LinkCandidateRow {
  acl: string[];
  body: string | null;
  extracted_text: string | null;
}

async function loadCandidateCatalog(runner: PhaseRunner): Promise<LinkCandidateRow[]> {
  const candidates: LinkCandidateRow[] = [];
  let afterPageId: string | null = null;

  while (true) {
    const page = await runner.withTx((tx) => tx<LinkCandidateRow[]>`
      select id, slug, title
      from cb_internal.cycle_link_pages(${afterPageId}::uuid, ${LINK_CANDIDATE_BATCH_SIZE})`);
    // Map deliberately rather than retaining the returned row object. Test doubles and PostgreSQL
    // drivers may attach additional fields; the all-run catalog must never keep page bodies alive.
    candidates.push(...page.map(({ id, slug, title }) => ({ id, slug, title })));
    if (page.length < LINK_CANDIDATE_BATCH_SIZE) break;
    afterPageId = page.at(-1)?.id ?? null;
  }
  return candidates;
}

async function loadSourceBatch(
  runner: PhaseRunner,
  afterPageId: string | null,
): Promise<CycleLinkPageRow[]> {
  return runner.withTx((tx) => tx<CycleLinkPageRow[]>`
    select id, slug, title, acl, body, extracted_text
    from cb_internal.cycle_link_pages(${afterPageId}::uuid, ${LINK_EXTRACTION_BATCH_SIZE})`);
}

export class LinkExtractionPhase extends BaseCyclePhase {
  readonly name = 'link_extraction';
  protected readonly budgetUsdDefault = 0.01;

  protected mapErrorCode(_err: unknown): string {
    return 'LINK_EXTRACTION_FAILED';
  }

  protected async process(runner: PhaseRunner) {
    if (runner.dryRun) return this.processDryRun(runner);

    const fingerprint = fingerprintParams({ version: CHECKPOINT_VERSION, batchSize: LINK_EXTRACTION_BATCH_SIZE });
    const checkpoint = await runner.loadCheckpoint(fingerprint);
    // Version 2 stores one high-water UUID, not an ever-growing completed-id set. Keep the maximum
    // defensively so a partially-written legacy-looking value still resumes monotonically.
    const lastCompletedPageId = checkpoint.length === 0 ? null : [...checkpoint].sort().at(-1) ?? null;
    const candidates: LinkCandidate[] = await loadCandidateCatalog(runner);

    let processed = 0;
    let failed = 0;
    let linksWritten = 0;
    let batches = 0;
    let afterPageId = lastCompletedPageId;

    while (true) {
      const batch = await loadSourceBatch(runner, afterPageId);
      if (batch.length === 0) break;
      const result = await runner.withTx(async (tx) => {
        const reconciled = await extractAndReconcileLinkBatch(tx, {
          workspaceId: runner.ctx.workspaceId,
          sourceRows: batch,
          candidates,
        });
        if (reconciled.pageIds.length > 0) {
          // Clear prior failures in the same batch transaction. Calling runner.clearFailure once per
          // successful page would recreate the remote round-trip problem this phase fixes.
          await tx`
            delete from cycle_failures
            where workspace_id = ${runner.ctx.workspaceId}
              and op = ${this.name}
              and item_key = any(${reconciled.pageIds}::text[])`;
        }
        return reconciled;
      });

      linksWritten += result.linksWritten;
      processed += result.pageIds.length;
      failed += result.failures.length;
      batches++;
      for (const failure of result.failures) {
        await runner.recordFailure(failure.pageId, failure.error);
      }

      // Only deterministic in-memory extraction failures reach the per-page ledger above. Any SQL
      // error rejects runner.withTx, aborts this phase, and leaves the prior batch checkpoint intact
      // so the whole database batch is replayed atomically.

      // Save exactly once per committed source batch. If the process dies before this write, the
      // batch is replayed; full replacement is idempotent, so at-least-once processing is safe.
      const highWater = batch.at(-1)?.id;
      if (highWater) {
        await runner.saveCheckpoint(fingerprint, [highWater]);
        afterPageId = highWater;
      }
      if (batch.length < LINK_EXTRACTION_BATCH_SIZE) break;
    }

    // Full pass completed. Pages with in-memory extraction failures remain in the failure ledger
    // and are retried on the next scheduled full walk; the checkpoint is only crash-resume state,
    // not a success cache.
    await runner.clearCheckpoint(fingerprint);

    return {
      summary: `link_extraction: processed ${processed} page(s), wrote ${linksWritten} edge(s), ${failed} failure(s)`,
      details: {
        pages_scanned: candidates.length,
        pages_processed: processed,
        batches,
        links_written: linksWritten,
        failures: failed,
      },
      status: failed > 0 ? ('warn' as const) : ('ok' as const),
    };
  }

  /** Read-only: retain only the lightweight catalog and stream body batches without any writes. */
  private async processDryRun(runner: PhaseRunner) {
    const allCandidates: LinkCandidate[] = await loadCandidateCatalog(runner);

    let pagesTotal = 0;
    let pagesWithText = 0;
    let wouldWriteLinks = 0;
    let afterPageId: string | null = null;
    while (true) {
      const batch = await loadSourceBatch(runner, afterPageId);
      if (batch.length === 0) break;
      pagesTotal += batch.length;
      for (const row of batch) {
        const text = row.body ?? row.extracted_text ?? '';
        if (!text) continue;
        pagesWithText++;
        wouldWriteLinks += extractLinks(text, allCandidates.filter((candidate) => candidate.id !== row.id)).length;
      }
      afterPageId = batch.at(-1)?.id ?? afterPageId;
      if (batch.length < LINK_EXTRACTION_BATCH_SIZE) break;
    }

    return {
      summary: `link_extraction (dry run): would process ${pagesWithText} of ${pagesTotal} page(s), would write ~${wouldWriteLinks} edge(s), no writes made`,
      details: {
        pages_total: pagesTotal,
        pages_with_text: pagesWithText,
        would_write_links: wouldWriteLinks,
        dry_run: true,
      },
    };
  }
}
