// M8 — the cycle engine's main loop. Deliberately a THIN runner: gbrain's own cycle.ts hit 2,505
// lines specifically because phase logic got inlined into it over time (docs/pipeline-roadmap.md:
// "build it eight times badly inside eight separate phase scripts"). Every phase here gets its own
// file under cycle/phases/ from day one instead — this file only orders phases, holds the lock, and
// writes the audit trail.
import { BaseCyclePhase } from './cycle/base-phase.ts';
import { buildCycleContext, CycleLockUnavailableError, reapDeadCycleLocks, withRefreshingCycleLock } from './cycle/lock.ts';
import { writeIngestLog } from './cycle/ingest-log.ts';
import { NoopPhase } from './cycle/phases/noop.ts';
import { LinkExtractionPhase } from './cycle/phases/link-extraction.ts';
import { FactExtractionPhase } from './cycle/phases/fact-extraction.ts';
import { buildPhaseRunner } from './cycle/runner-context.ts';
import type { CycleOpts, CycleReport, PhaseResult } from './cycle/types.ts';

export type { CycleOpts, CycleReport, PhaseResult } from './cycle/types.ts';
export { CycleLockUnavailableError } from './cycle/lock.ts';

const PHASE_REGISTRY: Record<string, () => BaseCyclePhase> = {
  noop: () => new NoopPhase(),
  link_extraction: () => new LinkExtractionPhase(),
  fact_extraction: () => new FactExtractionPhase(),
};

export function registeredPhaseNames(): string[] {
  return Object.keys(PHASE_REGISTRY).sort();
}

/** M9+ phases register here (e.g. `PHASE_REGISTRY.link_extraction = () => new LinkExtractionPhase()`)
 *  rather than this file growing a phase-specific branch. */
export function registerPhase(name: string, factory: () => BaseCyclePhase): void {
  PHASE_REGISTRY[name] = factory;
}

export async function runCycle(opts: CycleOpts): Promise<CycleReport> {
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const ctx = buildCycleContext(opts.workspaceId);
  const dryRun = opts.dryRun ?? false;

  const phaseNames = opts.phases && opts.phases.length > 0 ? opts.phases : registeredPhaseNames();
  for (const name of phaseNames) {
    if (!PHASE_REGISTRY[name]) {
      throw new Error(`unknown cycle phase "${name}". Available: ${registeredPhaseNames().join(', ')}`);
    }
  }

  // Best-effort: a crashed prior run's lock self-heals here instead of waiting out the full TTL.
  await reapDeadCycleLocks(ctx).catch((err) => {
    console.warn(`[cycle] reapDeadCycleLocks failed for workspace ${opts.workspaceId} (non-fatal):`, err);
  });

  const results: PhaseResult[] = [];
  try {
    await withRefreshingCycleLock(
      ctx,
      async () => {
        for (const name of phaseNames) {
          const phase = PHASE_REGISTRY[name]!();
          const budgetUsd = opts.budgetUsdOverride ?? phase.budgetUsd;
          const runner = buildPhaseRunner(ctx, { runId, dryRun, op: name, budgetUsd });
          const phaseStartedAt = new Date();

          const result = await phase.run(runner, { runId, dryRun, budgetUsdOverride: opts.budgetUsdOverride });
          results.push(result);

          await writeIngestLog(ctx, {
            runId,
            op: name,
            status: result.status,
            summary: result.summary,
            details: result.details,
            durationMs: result.duration_ms,
            startedAt: phaseStartedAt,
          }).catch((err) => {
            console.error(`[cycle] failed to write ingest_log for phase "${name}" (non-fatal, phase result stands):`, err);
          });
        }
      },
      { ttlMinutes: opts.lockTtlMinutes },
    );
  } catch (err) {
    if (err instanceof CycleLockUnavailableError) {
      return {
        workspace_id: opts.workspaceId,
        run_id: runId,
        timestamp: startedAt.toISOString(),
        duration_ms: Date.now() - startedAt.getTime(),
        status: 'skipped',
        reason: 'cycle_already_running',
        phases: [],
      };
    }
    throw err;
  }

  const allFailed = results.length > 0 && results.every((r) => r.status === 'fail');
  const anyBad = results.some((r) => r.status === 'fail' || r.status === 'warn');
  const status: CycleReport['status'] = allFailed ? 'failed' : anyBad ? 'partial' : 'ok';

  return {
    workspace_id: opts.workspaceId,
    run_id: runId,
    timestamp: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    status,
    phases: results,
  };
}
