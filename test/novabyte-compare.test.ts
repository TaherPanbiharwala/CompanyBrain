import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function report() {
  return {
    smoke: false,
    corpusManifest: { datasetHash: 'same', chatModel: 'chat', embeddingModel: 'embed', expectedPages: 2, foundPages: 2 },
    retrieval: { requestedProfile: 'baseline', resolvedProfile: 'baseline', knobHash: 'old' },
    aclMismatches: 0,
    suites: {
      qrels: {
        hitAt1Rate: 0.5,
        hitAt3Rate: 1,
        mrr: 0.75,
        leaks: [] as Array<{ id: string; hitAt1: boolean; hitAt3: boolean; reciprocalRank: number; leaked: string[] }>,
        perQuestion: [{ id: 'q1', hitAt1: false, hitAt3: true, reciprocalRank: 0.5, leaked: [] }],
      },
    },
    allResults: [{ suite: 'injection_suite', caseId: 'i1', asker: 'alice', pass: true }],
  };
}

function compare(oldReport: object, newReport: object): ReturnType<typeof Bun.spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-nova-compare-'));
  const oldPath = join(dir, 'old.json');
  const newPath = join(dir, 'new.json');
  writeFileSync(oldPath, JSON.stringify(oldReport));
  writeFileSync(newPath, JSON.stringify(newReport));
  return Bun.spawnSync(['bun', 'run', 'scripts/compare-novabyte.ts', '--old', oldPath, '--new', newPath], {
    cwd: new URL('..', import.meta.url).pathname,
  });
}

describe('NovaByte comparator', () => {
  it('passes a labeled candidate with no regression', () => {
    const oldReport = report();
    const newReport = structuredClone(oldReport);
    newReport.retrieval = { requestedProfile: 'candidate', resolvedProfile: 'gbrain-intent', knobHash: 'new' };
    const result = compare(oldReport, newReport);
    expect(result.exitCode).toBe(0);
  });

  it('fails on a lost passing case, lost hit@3, lower aggregate, ACL mismatch, and leak', () => {
    const oldReport = report();
    const newReport = structuredClone(oldReport);
    newReport.retrieval = { requestedProfile: 'candidate', resolvedProfile: 'gbrain-intent', knobHash: 'new' };
    newReport.allResults[0]!.pass = false;
    newReport.aclMismatches = 1;
    newReport.suites.qrels.hitAt3Rate = 0;
    newReport.suites.qrels.perQuestion[0]!.hitAt3 = false;
    newReport.suites.qrels.leaks = [{ ...newReport.suites.qrels.perQuestion[0]!, leaked: ['cross-tenant'] }];
    const result = compare(oldReport, newReport);
    expect(result.exitCode).toBe(1);
    const output = result.stdout?.toString() ?? '';
    expect(output).toContain('previously passing case failed');
    expect(output).toContain('hitAt3Rate decreased');
    expect(output).toContain('ACL mismatch');
    expect(output).toContain('cross-tenant qrel leak');
  });
});
