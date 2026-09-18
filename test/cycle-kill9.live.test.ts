// The M8 exit criterion, verified end to end: "a no-op phase runs on a schedule, takes a
// workspace-scoped advisory lock, respects a budget ceiling, checkpoints its progress, and resumes
// correctly after a kill -9 mid-run." Spawns the real CLI (scripts/run-cycle.ts) as a subprocess —
// same Bun.spawn idiom test/extract.test.ts uses for worker-isolation — so the crash is a real
// SIGKILL against a real process, not a simulated failure inside the test's own process.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { cycleLockKey } from '../src/core/cycle/lock.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('cycle-kill9', hasDbEnv());
const REPO_ROOT = new URL('..', import.meta.url).pathname;

/** Reads a subprocess's stdout stream until `pattern` matches, or throws on timeout. Used to wait
 *  for the child to genuinely be mid-run (past its first checkpoint write) before killing it —
 *  otherwise a race could kill it before it starts, or after it already finished, and the test
 *  would pass having proven nothing (the exact D43 failure class this repo's tests explicitly
 *  guard against elsewhere). */
async function waitForLine(stream: ReadableStream<Uint8Array>, pattern: RegExp, timeoutMs: number): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (pattern.test(buf)) return;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`timed out waiting for ${pattern} in child stdout:\n${buf}`);
}

describe.skipIf(!live)('cycle kill -9 / resume — M8 exit criterion', () => {
  let ws = '';
  let p = '';

  beforeAll(async () => {
    const admin = adminSql();
    p = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`cycle-kill9-${RUN}@ex.com`}, ${`cycle-kill9-${RUN}@ex.com`}) returning id`)[0]!.id;
    ws = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'cycle-kill9-ws'}, ${p}) returning id`)[0]!.id;
  });

  afterAll(async () => {
    const admin = adminSql();
    await admin`delete from workspaces where id = ${ws}`;
    await admin`delete from principals where id = ${p}`;
    await closePools({ timeout: 5 });
  });

  it('a crash mid-run leaves the lock and checkpoint intact; the next run reclaims it and resumes without redoing completed ticks', async () => {
    // Both the same-host dead-PID reap (HOLDER_TAKEOVER_GRACE_MS) and the TTL/steal-grace fallback
    // in lock.ts have a hardcoded 60s floor before ANY crashed lock becomes reclaimable — verified
    // live during the M8 review: a first version of this test retried within seconds of the kill and
    // reliably got 'skipped (cycle_already_running)' back, because neither path actually fires that
    // fast. CB_CYCLE_LOCK_STEAL_GRACE_SECONDS (mirroring gbrain's own GBRAIN_LOCK_STEAL_GRACE_SECONDS
    // escape hatch) overrides that floor for exactly this: proving the reclaim genuinely works,
    // without a real test waiting out a real 60+ seconds.
    const shortLockEnv = { CB_CYCLE_LOCK_STEAL_GRACE_SECONDS: '3' };

    // Long enough that the test can reliably observe the tick-1 marker and SIGKILL before the
    // phase advances to tick-2 on its own. --lock-ttl-minutes is short so the row this run leaves
    // behind actually expires quickly once killed.
    const proc1 = Bun.spawn(
      ['bun', 'run', 'scripts/run-cycle.ts', '--workspace', ws, '--phase', 'noop', '--lock-ttl-minutes', '0.1'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...shortLockEnv, CB_CYCLE_NOOP_PAUSE_MS: '5000' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    await waitForLine(proc1.stdout, /NOOP_CHECKPOINT tick-1/, 20_000);
    proc1.kill('SIGKILL');
    await proc1.exited;

    const admin = adminSql();

    // The crash must NOT have cleaned up after itself — this is the whole scenario under test.
    const lockRows = await admin<{ holder_pid: number }[]>`select holder_pid from cycle_locks where lock_key = ${cycleLockKey(ws)}`;
    expect(lockRows, 'lock row should survive a SIGKILL — release() never ran').toHaveLength(1);

    const checkpointRows = await admin<{ completed_keys: string[] }[]>`
      select completed_keys from op_checkpoints where workspace_id = ${ws} and op = 'noop'`;
    expect(checkpointRows).toHaveLength(1);
    expect(checkpointRows[0]?.completed_keys).toEqual(['tick-1']);

    // Let the short TTL (6s, 0.1 minutes) and steal grace (3s, overridden above) actually elapse —
    // this is real wall-clock time, not simulated, so the reclaim below is the genuine TTL/steal-grace
    // path in lock.ts's upsertAcquire, not a mocked shortcut.
    await new Promise((r) => setTimeout(r, 10_000));

    const proc2 = Bun.spawn(
      ['bun', 'run', 'scripts/run-cycle.ts', '--workspace', ws, '--phase', 'noop', '--lock-ttl-minutes', '1'],
      {
        cwd: REPO_ROOT,
        // Small pause so this run's own NOOP_CHECKPOINT markers are still observable in the
        // captured output — used below to prove tick-1 was SKIPPED, not redone.
        env: { ...process.env, ...shortLockEnv, CB_CYCLE_NOOP_PAUSE_MS: '50' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [out2, err2, code2] = await Promise.all([
      new Response(proc2.stdout).text(),
      new Response(proc2.stderr).text(),
      proc2.exited,
    ]);
    expect(code2, `run-cycle exited ${code2}, stderr:\n${err2}\nstdout:\n${out2}`).toBe(0);
    expect(out2, `expected the resumed run to report ok:\n${out2}`).toMatch(/: ok(\s|$|\s—)/);

    // The proof that this was a RESUME and not a restart-from-scratch: only tick-2 and tick-3 fire
    // a checkpoint marker on the second run. A bug that ignored the loaded checkpoint would print
    // three markers here (tick-1 redone), not two.
    const markers = out2.match(/NOOP_CHECKPOINT tick-\d/g) ?? [];
    expect(markers).toEqual(['NOOP_CHECKPOINT tick-2', 'NOOP_CHECKPOINT tick-3']);

    // Checkpoint cleared on successful completion — nothing left to resume from.
    const finalCheckpoint = await admin<{ n: number }[]>`
      select count(*)::int as n from op_checkpoints where workspace_id = ${ws} and op = 'noop'`;
    expect(finalCheckpoint[0]?.n).toBe(0);

    // And the lock was released cleanly at the end of the successful run.
    const finalLock = await admin<{ n: number }[]>`select count(*)::int as n from cycle_locks where lock_key = ${cycleLockKey(ws)}`;
    expect(finalLock[0]?.n).toBe(0);
  }, 60_000);
});
