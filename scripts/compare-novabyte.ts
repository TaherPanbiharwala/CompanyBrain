// Strict before/after gate for the NovaByte answer, citation, injection, ACL, leak, and qrel suites.
import { readFileSync, writeFileSync } from 'node:fs';

interface CaseResult {
  suite: string;
  caseId: string;
  asker: string;
  pass: boolean;
  error?: string;
}

interface QrelResult {
  id: string;
  hitAt1: boolean;
  hitAt3: boolean;
  reciprocalRank: number;
  leaked: string[];
}

interface NovaReport {
  smoke: boolean;
  corpusManifest: Record<string, unknown>;
  retrieval: { requestedProfile: string; resolvedProfile: string; knobHash: string };
  aclMismatches: number;
  suites: {
    qrels: {
      hitAt1Rate: number;
      hitAt3Rate: number;
      mrr: number;
      leaks: QrelResult[];
      perQuestion: QrelResult[];
    };
  };
  allResults: CaseResult[];
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const value = inline?.slice(name.length + 3) ?? (index >= 0 ? process.argv[index + 1] : undefined);
  if (!value) throw new Error(`missing --${name} <report.json>`);
  return value;
}

function key(result: CaseResult): string {
  return `${result.suite}\u0000${result.caseId}\u0000${result.asker}`;
}

function main(): void {
  const oldPath = flag('old');
  const newPath = flag('new');
  const output = process.argv.includes('--output') ? flag('output') : undefined;
  const oldReport = JSON.parse(readFileSync(oldPath, 'utf8')) as NovaReport;
  const newReport = JSON.parse(readFileSync(newPath, 'utf8')) as NovaReport;
  const reasons: string[] = [];

  if (oldReport.smoke !== newReport.smoke) reasons.push('smoke/full mode differs');
  if (JSON.stringify(oldReport.corpusManifest) !== JSON.stringify(newReport.corpusManifest)) {
    reasons.push('dataset/model/corpus manifest differs');
  }
  if (oldReport.retrieval.requestedProfile !== 'baseline') reasons.push('old report is not labeled baseline');
  if (newReport.retrieval.requestedProfile !== 'candidate') reasons.push('new report is not labeled candidate');

  const nextCases = new Map(newReport.allResults.map((result) => [key(result), result]));
  for (const previous of oldReport.allResults) {
    const next = nextCases.get(key(previous));
    if (!next) {
      reasons.push(`candidate omitted case ${previous.suite}/${previous.caseId}/${previous.asker}`);
      continue;
    }
    if (previous.pass && !next.pass) reasons.push(`previously passing case failed: ${previous.suite}/${previous.caseId}/${previous.asker}`);
  }
  if (oldReport.allResults.some((result) => result.error) || newReport.allResults.some((result) => result.error)) {
    reasons.push('one or both runs contains case errors');
  }
  if (newReport.aclMismatches > 0 || newReport.aclMismatches > oldReport.aclMismatches) {
    reasons.push(`candidate has ${newReport.aclMismatches} ACL mismatch(es)`);
  }
  if (newReport.suites.qrels.leaks.length > 0) reasons.push('candidate has cross-tenant qrel leak(s)');

  const nextQrels = new Map(newReport.suites.qrels.perQuestion.map((row) => [row.id, row]));
  for (const previous of oldReport.suites.qrels.perQuestion) {
    const next = nextQrels.get(previous.id);
    if (!next) reasons.push(`candidate omitted qrel ${previous.id}`);
    else if (previous.hitAt3 && !next.hitAt3) reasons.push(`qrel lost a previously achieved hit@3: ${previous.id}`);
  }
  const metrics = ['hitAt1Rate', 'hitAt3Rate', 'mrr'] as const;
  for (const metric of metrics) {
    if (newReport.suites.qrels[metric] + Number.EPSILON < oldReport.suites.qrels[metric]) {
      reasons.push(`${metric} decreased: ${oldReport.suites.qrels[metric]} -> ${newReport.suites.qrels[metric]}`);
    }
  }

  const verdict = {
    passed: reasons.length === 0,
    old: { path: oldPath, retrieval: oldReport.retrieval, qrels: oldReport.suites.qrels },
    new: { path: newPath, retrieval: newReport.retrieval, qrels: newReport.suites.qrels },
    reasons,
  };
  if (output) writeFileSync(output, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.passed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
