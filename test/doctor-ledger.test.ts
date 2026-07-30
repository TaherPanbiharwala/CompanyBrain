// doctor's migrations-current classification, offline.
//
// The three checks it feeds — pending / orphaned / checksum-drifted — shipped with no tests at all,
// and two of their branches cannot be reached from a healthy live run: a NULL recorded checksum, and
// a ledger row for a file this tree does not have. Both are exactly the states the checks exist to
// report, so "we verified it against the live database" could never have covered them.
//
// This is the vacuity control for those checks, in the same way test/acl-tag-format.test.ts is the
// vacuity control for the acl census: doctor must be green on a healthy database, so the drift
// detectors are vacuous there by necessity and their negative cases have to live here.
import { describe, it, expect } from 'bun:test';
import { classifyLedger } from '../src/db/doctor.ts';

const f = (name: string, sha: string) => ({ name, sha });
const HEALTHY = [f('schema.sql', 'aaa'), f('migrations/0001_a.sql', 'bbb'), f('migrations/0002_b.sql', 'ccc')];
const APPLIED = new Map<string, string | null>([
  ['schema.sql', 'aaa'],
  ['migrations/0001_a.sql', 'bbb'],
  ['migrations/0002_b.sql', 'ccc'],
]);

describe('classifyLedger', () => {
  it('positive control: a fully-applied, unmodified tree is clean on all three axes', () => {
    // Without this, every negative below could be produced by a classifier that flags everything.
    const v = classifyLedger(HEALTHY, APPLIED);
    expect(v).toEqual({ pending: [], orphans: [], drifted: [] });
  });

  it('a file with no ledger row is PENDING, and is not also reported as drifted', () => {
    const ledger = new Map(APPLIED);
    ledger.delete('migrations/0002_b.sql');
    const v = classifyLedger(HEALTHY, ledger);
    expect(v.pending).toEqual(['migrations/0002_b.sql']);
    // Double-reporting the same file as two different problems sends the operator to two remedies
    // for one cause.
    expect(v.drifted).toEqual([]);
    expect(v.orphans).toEqual([]);
  });

  it('a ledger row with no file is an ORPHAN — the branch-divergence case', () => {
    // The state this project's shared database was actually found in: a migration applied from
    // another branch that this tree does not contain. Checksums are immutable, so it can never be
    // re-applied differently.
    const ledger = new Map(APPLIED).set('migrations/0099_other_branch.sql', 'zzz');
    const v = classifyLedger(HEALTHY, ledger);
    expect(v.orphans).toEqual(['migrations/0099_other_branch.sql']);
    expect(v.pending).toEqual([]);
    expect(v.drifted).toEqual([]);
  });

  it('a changed file is DRIFT', () => {
    const ledger = new Map(APPLIED).set('migrations/0001_a.sql', 'DIFFERENT');
    const v = classifyLedger(HEALTHY, ledger);
    expect(v.drifted).toEqual(['migrations/0001_a.sql (content changed)']);
    expect(v.pending).toEqual([]);
  });

  it('a NULL recorded checksum is DRIFT, not "fine"', () => {
    // The branch a live run cannot reach. An unverified checksum is not a verified one — the migrate
    // runner takes the same position, and a classifier that treated NULL as a pass would silently
    // exempt exactly the rows whose provenance is unknown.
    const ledger = new Map(APPLIED).set('migrations/0002_b.sql', null);
    const v = classifyLedger(HEALTHY, ledger);
    expect(v.drifted).toEqual(['migrations/0002_b.sql (no checksum recorded)']);
  });

  it('an empty ledger reports every file pending and nothing orphaned', () => {
    // The fresh-database case, and the shape doctor falls back to when _migrations does not exist.
    const v = classifyLedger(HEALTHY, new Map());
    expect(v.pending).toHaveLength(3);
    expect(v.orphans).toEqual([]);
    expect(v.drifted).toEqual([]);
  });

  it('reports every offender, not just the first', () => {
    // The detail strings name each file; a loop that broke early would hide the rest of the posture
    // behind whichever one happened to sort first.
    const ledger = new Map<string, string | null>([
      ['schema.sql', 'WRONG'],
      ['migrations/0001_a.sql', null],
      ['migrations/0099_gone.sql', 'zzz'],
    ]);
    const v = classifyLedger(HEALTHY, ledger);
    expect(v.pending).toEqual(['migrations/0002_b.sql']);
    expect(v.orphans).toEqual(['migrations/0099_gone.sql']);
    expect(v.drifted).toEqual(['schema.sql (content changed)', 'migrations/0001_a.sql (no checksum recorded)']);
  });
});
