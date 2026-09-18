// The M8 exit-criterion phase. Does zero real work and touches no content tables (pages,
// content_chunks) — its only job is exercising every mechanism the cycle engine provides
// (lock, budget, checkpoint, resume) end to end.
import { BaseCyclePhase } from '../base-phase.ts';
import { fingerprintParams } from '../checkpoint.ts';
import type { PhaseRunner } from '../runner-context.ts';

const TICKS = ['tick-1', 'tick-2', 'tick-3'];

/** Test-only seam (test/cycle-kill9.live.test.ts): after each checkpoint write, print a stdout
 *  marker line the test can wait on, then — if set — sleep this many ms before the next tick, so
 *  the test has a deterministic window to `kill -9` the process mid-run instead of racing a
 *  three-tick loop that would otherwise finish in milliseconds. No-op (no marker, no sleep) unless
 *  the env var is set, so this never affects a real scheduled run. */
const PAUSE_MS = Number(process.env.CB_CYCLE_NOOP_PAUSE_MS ?? '');

export class NoopPhase extends BaseCyclePhase {
  readonly name = 'noop';
  protected readonly budgetUsdDefault = 0.01;

  protected async process(runner: PhaseRunner) {
    if (runner.dryRun) {
      // No mutation at all — not even a budget check, since checkBudget() itself commits a ledger
      // row. loadCheckpoint() is a read and safe to report accurately.
      const fingerprint = fingerprintParams({});
      const done = new Set(await runner.loadCheckpoint(fingerprint));
      const remaining = TICKS.filter((t) => !done.has(t));
      return {
        summary: `noop (dry run): would process ${remaining.length} of ${TICKS.length} tick(s), no writes made`,
        details: { ticks_total: TICKS.length, ticks_would_process: remaining.length, dry_run: true },
      };
    }

    const fingerprint = fingerprintParams({});
    const done = new Set(await runner.loadCheckpoint(fingerprint));
    let processed = 0;

    for (const tick of TICKS) {
      if (done.has(tick)) continue;

      await runner.checkBudget({ modelId: 'noop', estimatedInputTokens: 0, maxOutputTokens: 0, kind: 'chat' });

      done.add(tick);
      await runner.saveCheckpoint(fingerprint, [...done]);
      processed++;

      if (Number.isFinite(PAUSE_MS) && PAUSE_MS > 0) {
        console.log(`NOOP_CHECKPOINT ${tick}`);
        await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
    }

    await runner.clearCheckpoint(fingerprint);
    return {
      summary: `noop: processed ${processed} of ${TICKS.length} tick(s) (${TICKS.length - processed} already checkpointed)`,
      details: { ticks_total: TICKS.length, ticks_processed: processed },
    };
  }
}
