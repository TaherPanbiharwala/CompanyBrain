// M10 wave 1, sub-step A — the first real per-item LLM cost this cycle engine incurs (link_extraction
// is zero-LLM; noop never calls chat()/embed() at all). One chat() call per candidate page, batched
// keyset reads via a dedicated cycle-only SECURITY DEFINER that filters unchanged pages SERVER-SIDE
// (unlike link_extraction's generic cycle_link_pages reader, reused as-is because links has no
// per-page cost to skip) — see cb_internal.cycle_fact_extraction_candidates (migration 0023).
//
// Checkpoint per PAGE, not per batch (unlike link_extraction's 200-page batches): each page already
// costs a network LLM round trip, so the worst-case redo after a crash should be one page's spend,
// not up to a whole batch's.
import { BaseCyclePhase } from '../base-phase.ts';
import { fingerprintParams } from '../checkpoint.ts';
import { BudgetExhaustedError } from '../budget-meter.ts';
import type { PhaseRunner } from '../runner-context.ts';
import { chat, embed, withRouterScope } from '../../../ai/router.ts';
import { toVectorLiteral } from '../../../ai/vector.ts';
import {
  buildFactExtractionMessages,
  parseFactExtractionResponse,
  type ExtractedFact,
} from '../../facts/extract.ts';
import { pickDuplicate, type SimilarFactCandidate } from '../../facts/dedup.ts';

export const FACT_EXTRACTION_BATCH_SIZE = 50;
/** Candidates fetched per fact for entity-scoped cosine dedup — see cb_internal.cycle_facts_by_entity. */
const DEDUP_CANDIDATE_LIMIT = 5;
const CHECKPOINT_VERSION = 1;

interface FactExtractionCandidateRow {
  id: string;
  slug: string;
  title: string | null;
  kind: string;
  tags: string[];
  acl: string[];
  body: string | null;
  extracted_text: string | null;
  content_hash: string | null;
}

interface FactInsertRow {
  workspace_id: string;
  source_page_id: string;
  acl: string[];
  entity_slug: string | null;
  kind: string;
  notability: string;
  confidence: number;
  claim_text: string;
  claim_metric: string | null;
  claim_value: number | null;
  claim_unit: string | null;
  claim_period: string | null;
  event_type: string | null;
  source_excerpt: string;
  embedding: string;
  consolidated_at: Date | null;
  consolidated_into: string | null;
  extracted_by_run_id: string;
}

/** Test-only seam (mirrors noop's CB_CYCLE_NOOP_PAUSE_MS): after each page's checkpoint write, print
 *  a stdout marker the test can wait on, then optionally sleep — so a kill-9 test has a deterministic
 *  window instead of racing a run that may finish before the signal arrives. No-op unless set. */
const PAUSE_MS = Number(process.env.CB_CYCLE_FACT_EXTRACTION_PAUSE_MS ?? '');

async function loadCandidateBatch(
  runner: PhaseRunner,
  afterPageId: string | null,
): Promise<FactExtractionCandidateRow[]> {
  return runner.withTx((tx) => tx<FactExtractionCandidateRow[]>`
    select id, slug, title, kind, tags, acl, body, extracted_text, content_hash
    from cb_internal.cycle_fact_extraction_candidates(${afterPageId}::uuid, ${FACT_EXTRACTION_BATCH_SIZE})`);
}

export class FactExtractionPhase extends BaseCyclePhase {
  readonly name = 'fact_extraction';
  // Real arithmetic, not an arbitrary round number: ~8000 chars/page (FACT_EXTRACTION_MAX_CHARS) is
  // ~2000 input + ~1000 output tokens, ~$0.0006/page at current chat-model pricing — a 600-page full
  // backfill is ~$0.36. $2.00 has headroom for a worst-case first full-corpus run, not just
  // steady-state incremental extraction. Verify against real per-page cost once this has run live.
  protected readonly budgetUsdDefault = 2.0;

  protected mapErrorCode(_err: unknown): string {
    return 'FACT_EXTRACTION_FAILED';
  }

  protected async process(runner: PhaseRunner) {
    if (runner.dryRun) return this.processDryRun(runner);

    const fingerprint = fingerprintParams({ version: CHECKPOINT_VERSION, batchSize: FACT_EXTRACTION_BATCH_SIZE });
    const checkpoint = await runner.loadCheckpoint(fingerprint);
    // Same "one high-water value, not a growing set" contract link_extraction's checkpoint uses.
    let afterPageId = checkpoint.length === 0 ? null : [...checkpoint].sort().at(-1) ?? null;

    const routerScope = {
      workspaceId: runner.ctx.workspaceId,
      zdr: false,
      // The FIRST real production phase to exercise this wiring — proven only in test/router.test.ts
      // until now. chat()/embed() perform the check/record internally when scope.budget is set.
      budget: { check: runner.checkBudget, record: runner.recordSpend },
    };

    let pagesScanned = 0;
    let pagesProcessed = 0;
    let factsWritten = 0;
    let duplicatesFound = 0;
    let failed = 0;

    while (true) {
      const batch = await loadCandidateBatch(runner, afterPageId);
      if (batch.length === 0) break;
      pagesScanned += batch.length;

      for (const page of batch) {
        const text = page.body ?? page.extracted_text ?? '';
        let extracted: ExtractedFact[] = [];

        if (text) {
          // LLM calls happen OUTSIDE any transaction (D6) — a stalled model call must never pin a
          // pooled connection.
          let raw: string;
          try {
            const messages = buildFactExtractionMessages(
              { title: page.title, slug: page.slug, kind: page.kind, tags: page.tags },
              text,
            );
            raw = await withRouterScope(routerScope, () => chat({ messages }));
          } catch (err) {
            if (err instanceof BudgetExhaustedError) throw err; // abort the whole phase, not this page
            await runner.recordFailure(page.id, err);
            failed++;
            await runner.saveCheckpoint(fingerprint, [page.id]);
            afterPageId = page.id;
            continue;
          }

          const parsed = parseFactExtractionResponse(raw);
          if (parsed.parseFailed) {
            await runner.recordFailure(page.id, new Error('fact extraction response could not be parsed as JSON'));
            failed++;
            await runner.saveCheckpoint(fingerprint, [page.id]);
            afterPageId = page.id;
            continue;
          }
          extracted = parsed.facts;
        }

        let vectors: number[][] = [];
        if (extracted.length > 0) {
          try {
            vectors = await withRouterScope(routerScope, () => embed(extracted.map((f) => f.claimText)));
          } catch (err) {
            if (err instanceof BudgetExhaustedError) throw err;
            await runner.recordFailure(page.id, err);
            failed++;
            await runner.saveCheckpoint(fingerprint, [page.id]);
            afterPageId = page.id;
            continue;
          }
        }

        // Everything DB-touching for this page — dedup lookups, the fact insert, and the extraction
        // stamp — lands in ONE short transaction, so a later page's failure never rolls back this
        // page's already-earned work, and this page costs one round-trip session, not N.
        const { written, duplicates } = await runner.withTx(async (tx) => {
          const rows: FactInsertRow[] = [];
          let dupCount = 0;
          for (let i = 0; i < extracted.length; i++) {
            const fact = extracted[i]!;
            const vector = toVectorLiteral(vectors[i]!);
            let consolidatedInto: string | null = null;
            if (fact.entitySlug) {
              const candidates = await tx<SimilarFactCandidate[]>`
                select id, similarity from cb_internal.cycle_facts_by_entity(
                  ${fact.entitySlug}, ${vector}::vector, ${DEDUP_CANDIDATE_LIMIT})`;
              consolidatedInto = pickDuplicate(candidates);
            }
            if (consolidatedInto) dupCount++;
            rows.push({
              workspace_id: runner.ctx.workspaceId,
              source_page_id: page.id,
              acl: page.acl,
              entity_slug: fact.entitySlug,
              kind: fact.kind,
              notability: fact.notability,
              confidence: fact.confidence,
              claim_text: fact.claimText,
              claim_metric: fact.claimMetric,
              claim_value: fact.claimValue,
              claim_unit: fact.claimUnit,
              claim_period: fact.claimPeriod,
              event_type: fact.eventType,
              source_excerpt: fact.sourceExcerpt,
              embedding: vector,
              consolidated_at: consolidatedInto ? new Date() : null,
              consolidated_into: consolidatedInto,
              extracted_by_run_id: runner.runId,
            });
          }

          // No RETURNING here — see facts_cycle_system's comment in migration 0023: for a private
          // page, the sentinel's workspace-only grants don't overlap that page's acl, so RETURNING's
          // implicit SELECT-visibility check would 42501 even though the INSERT's own WITH CHECK (no
          // acl condition) passes fine.
          if (rows.length > 0) {
            await tx`
              insert into facts ${tx(
                rows,
                'workspace_id',
                'source_page_id',
                'acl',
                'entity_slug',
                'kind',
                'notability',
                'confidence',
                'claim_text',
                'claim_metric',
                'claim_value',
                'claim_unit',
                'claim_period',
                'event_type',
                'source_excerpt',
                'embedding',
                'consolidated_at',
                'consolidated_into',
                'extracted_by_run_id',
              )}`;
          }
          await tx`select cb_internal.cycle_write_fact_extraction_stamp(${page.id}, ${page.content_hash})`;

          return { written: rows.length, duplicates: dupCount };
        });

        await runner.clearFailure(page.id);
        factsWritten += written;
        duplicatesFound += duplicates;
        pagesProcessed++;
        await runner.saveCheckpoint(fingerprint, [page.id]);
        afterPageId = page.id;

        if (Number.isFinite(PAUSE_MS) && PAUSE_MS > 0) {
          console.log(`FACT_EXTRACTION_CHECKPOINT ${page.id}`);
          await new Promise((r) => setTimeout(r, PAUSE_MS));
        }
      }

      if (batch.length < FACT_EXTRACTION_BATCH_SIZE) break;
    }

    // Full pass completed. A page recorded in the failure ledger was never stamped
    // (facts_extracted_content_hash unchanged), so the NEXT scheduled run's candidate query naturally
    // re-includes it — no separate retry-from-ledger logic needed, matching link_extraction's model.
    await runner.clearCheckpoint(fingerprint);

    return {
      summary:
        `fact_extraction: processed ${pagesProcessed} of ${pagesScanned} page(s), ` +
        `wrote ${factsWritten} fact(s) (${duplicatesFound} deduplicated), ${failed} failure(s)`,
      details: {
        pages_scanned: pagesScanned,
        pages_processed: pagesProcessed,
        facts_written: factsWritten,
        duplicates_found: duplicatesFound,
        failures: failed,
      },
      status: failed > 0 ? ('warn' as const) : ('ok' as const),
    };
  }

  /** Read-only: scans candidates and reports counts without calling the LLM or writing anything. */
  private async processDryRun(runner: PhaseRunner) {
    let pagesTotal = 0;
    let pagesWithText = 0;
    let afterPageId: string | null = null;
    while (true) {
      const batch = await loadCandidateBatch(runner, afterPageId);
      if (batch.length === 0) break;
      pagesTotal += batch.length;
      for (const row of batch) {
        if ((row.body ?? row.extracted_text ?? '').length > 0) pagesWithText++;
      }
      afterPageId = batch.at(-1)?.id ?? afterPageId;
      if (batch.length < FACT_EXTRACTION_BATCH_SIZE) break;
    }
    return {
      summary:
        `fact_extraction (dry run): ${pagesTotal} page(s) need extraction (${pagesWithText} with text), ` +
        `no writes made, no LLM calls made`,
      details: { pages_total: pagesTotal, pages_with_text: pagesWithText, dry_run: true },
    };
  }
}
