// M9 — the first real M8 cycle-engine consumer. Backfills/reconciles links for every page in a
// workspace on a schedule, using the exact same extractAndReconcileLinks() the synchronous ingest
// hooks (src/ingest/{import,file,lifecycle}.ts) call. Not redundant with those hooks — this phase
// does two things a per-page write-time hook structurally cannot:
//   1. Backfill pages ingested before this feature existed.
//   2. Backward-mention discovery: the hook only computes a page's own OUTGOING edges at the moment
//      it's written. It can't retroactively add an edge from an older page that happens to mention
//      a brand-new page's title — only a periodic full re-walk finds that.
//
// No content-hash skip in wave 1, deliberately: a naive "skip pages whose content_hash hasn't
// changed" would also skip re-discovering the backward-mention case above, since the *candidate set*
// changed even though the skipped page's own content didn't. Ship a full re-walk every run.
import { BaseCyclePhase } from '../base-phase.ts';
import { fingerprintParams } from '../checkpoint.ts';
import { extractLinks, type LinkCandidate } from '../../links/extract.ts';
import { extractAndReconcileLinks } from '../../links/reconcile.ts';
import type { PhaseRunner } from '../runner-context.ts';

const CHECKPOINT_EVERY = 100;

export class LinkExtractionPhase extends BaseCyclePhase {
  readonly name = 'link_extraction';
  // Zero LLM calls — this phase is pure regex/mention work. The positive default is a formality
  // BaseCyclePhase requires (no "disabled" value, per docs/plan.md Invariant 6), same posture noop
  // takes.
  protected readonly budgetUsdDefault = 0.01;

  protected mapErrorCode(_err: unknown): string {
    return 'LINK_EXTRACTION_FAILED';
  }

  protected async process(runner: PhaseRunner) {
    if (runner.dryRun) return this.processDryRun(runner);

    const fingerprint = fingerprintParams({});
    const done = new Set(await runner.loadCheckpoint(fingerprint));

    const pageIds = await runner.withTx(
      (tx) => tx<{ id: string }[]>`select id from pages where deleted_at is null order by id`,
    );

    let processed = 0;
    let failed = 0;
    let linksWritten = 0;

    for (const { id: pageId } of pageIds) {
      if (done.has(pageId)) continue;

      try {
        const result = await runner.withTx(async (tx) => {
          const [row] = await tx<{ id: string; body: string | null; extracted_text: string | null; acl: string[] }[]>`
            select id, body, extracted_text, acl from pages where id = ${pageId} and deleted_at is null`;
          if (!row) return { linksWritten: 0 };
          const text = row.body ?? row.extracted_text ?? '';
          if (!text) return { linksWritten: 0 };
          return extractAndReconcileLinks(tx, {
            workspaceId: runner.ctx.workspaceId,
            pageId: row.id,
            pageAcl: row.acl,
            text,
          });
        });
        linksWritten += result.linksWritten;
        await runner.clearFailure(pageId);
      } catch (err) {
        // One bad page must not abort the whole phase — record it and keep walking.
        failed++;
        await runner.recordFailure(pageId, err);
        continue;
      }

      done.add(pageId);
      processed++;
      if (processed % CHECKPOINT_EVERY === 0) {
        await runner.saveCheckpoint(fingerprint, [...done]);
      }
    }

    // Full pass completed (whether or not some pages individually failed) — nothing left to resume.
    // A failed page's id was never added to `done`, but retrying it specifically is not this
    // checkpoint's job: the phase always fully re-walks on its next scheduled run regardless (see
    // header comment), so there is no cross-run "skip what already succeeded" cache to preserve.
    await runner.clearCheckpoint(fingerprint);

    return {
      summary: `link_extraction: processed ${processed} page(s), wrote ${linksWritten} edge(s), ${failed} failure(s)`,
      details: { pages_processed: processed, links_written: linksWritten, failures: failed },
      status: failed > 0 ? ('warn' as const) : ('ok' as const),
    };
  }

  /** Read-only: reports what a real run would write, with zero writes — not even a checkpoint read
   *  beyond the one page query (matching noop.ts's own dry-run posture: a pure read, no mutation). */
  private async processDryRun(runner: PhaseRunner) {
    const rows = await runner.withTx(
      (tx) => tx<{ id: string; slug: string; title: string | null; body: string | null; extracted_text: string | null }[]>`
        select id, slug, title, body, extracted_text from pages where deleted_at is null order by id`,
    );

    const allCandidates: LinkCandidate[] = rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title }));

    let pagesWithText = 0;
    let wouldWriteLinks = 0;
    for (const row of rows) {
      const text = row.body ?? row.extracted_text ?? '';
      if (!text) continue;
      pagesWithText++;
      const candidates = allCandidates.filter((c) => c.id !== row.id);
      wouldWriteLinks += extractLinks(text, candidates).length;
    }

    return {
      summary: `link_extraction (dry run): would process ${pagesWithText} of ${rows.length} page(s), would write ~${wouldWriteLinks} edge(s), no writes made`,
      details: { pages_total: rows.length, pages_with_text: pagesWithText, would_write_links: wouldWriteLinks, dry_run: true },
    };
  }
}
