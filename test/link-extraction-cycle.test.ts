import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import {
  LinkExtractionPhase,
  LINK_EXTRACTION_BATCH_SIZE,
} from '../src/core/cycle/phases/link-extraction.ts';
import type { PhaseRunner } from '../src/core/cycle/runner-context.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import {
  CYCLE_DEFINER_PAGE_ID_LIMIT,
  extractAndReconcileLinkBatch,
  extractAndReconcileLinks,
  LINK_INSERT_BATCH_SIZE,
} from '../src/core/links/reconcile.ts';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const PRINCIPAL_ID = '22222222-2222-2222-2222-222222222222';
const ACL = [`ws:${WORKSPACE_ID}`];

interface FakePage {
  id: string;
  slug: string;
  title: string | null;
  acl: string[];
  body: string | null;
  extracted_text: string | null;
}

const pageId = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

function makePages(count: number): FakePage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: pageId(index + 1),
    slug: `page-${String(index + 1).padStart(4, '0')}`,
    title: `Unique Target ${String(index + 1).padStart(4, '0')}`,
    acl: ACL,
    body: index === 0 ? 'See Unique Target 0002 for the detail.' : 'No cross-reference here.',
    extracted_text: null,
  }));
}

interface FakeDb {
  readonly links: Set<string>;
  readonly queries: string[];
  failBatchStartingAt: string | null;
  tx: postgres.TransactionSql;
}

function createFakeDb(pages: FakePage[]): FakeDb {
  const links = new Set<string>();
  const queries: string[] = [];
  let pendingInsertRows: Array<Record<string, unknown>> = [];
  const db = { links, queries, failBatchStartingAt: null } as FakeDb;

  const tx = async (first: unknown, ...values: unknown[]): Promise<unknown> => {
    if (Array.isArray(first) && !Object.hasOwn(first, 'raw')) {
      pendingInsertRows = first as Array<Record<string, unknown>>;
      return { bulk: true };
    }

    const sql = (first as TemplateStringsArray).join(' ? ').replace(/\s+/g, ' ').trim();
    queries.push(sql);

    if (sql.includes('cb_internal.cycle_link_pages')) {
      const after = values[0] as string | null;
      const limit = values[1] as number;
      return pages.filter((page) => after === null || page.id > after).slice(0, limit);
    }
    if (sql.includes('cb_internal.cycle_lock_link_sources')) {
      const ids = values[0] as string[];
      if (db.failBatchStartingAt && ids[0] === db.failBatchStartingAt) throw new Error('simulated batch crash');
      return pages
        .filter((page) => ids.includes(page.id))
        .map((page) => ({
          id: page.id,
          acl: page.acl,
          get body() { return page.body; },
          extracted_text: page.extracted_text,
        }));
    }
    if (sql.includes('cb_internal.cycle_link_page_acls')) {
      const ids = values[0] as string[];
      return pages.filter((page) => ids.includes(page.id)).map(({ id, acl }) => ({ id, acl }));
    }
    if (sql.startsWith('delete from links')) {
      const sourceIds = values[1] as string[];
      for (const key of [...links]) {
        if (sourceIds.some((sourceId) => key.startsWith(`${sourceId}->`))) links.delete(key);
      }
      return [];
    }
    if (sql.startsWith('insert into links')) {
      for (const row of pendingInsertRows) {
        links.add(`${row.from_page_id}->${row.to_page_id}:${row.link_kind}:${row.link_source}`);
      }
      pendingInsertRows = [];
      return [];
    }
    if (sql.startsWith('delete from cycle_failures')) return [];
    throw new Error(`unhandled fake SQL: ${sql}`);
  };
  db.tx = tx as unknown as postgres.TransactionSql;
  return db;
}

interface RunnerHarness {
  runner: PhaseRunner;
  checkpoint: string[];
  checkpointWrites: string[][];
  checkpointClears: number;
  failures: string[];
  withTxCalls: number;
}

function createRunner(db: FakeDb, initialCheckpoint: string[] = []): RunnerHarness {
  const harness = {
    checkpoint: [...initialCheckpoint],
    checkpointWrites: [] as string[][],
    checkpointClears: 0,
    failures: [] as string[],
    withTxCalls: 0,
  } as RunnerHarness;
  const ctx = buildContext({
    principal: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    role: 'system',
    grants: resolveGrants(PRINCIPAL_ID, WORKSPACE_ID),
    remote: false,
  });
  harness.runner = {
    ctx,
    runId: 'run-1',
    dryRun: false,
    withTx: async (fn) => {
      harness.withTxCalls++;
      return fn(db.tx);
    },
    checkBudget: async () => ({ allowed: true, estimatedCostUsd: 0, cumulativeCostUsd: 0, budgetUsd: 1 }),
    recordSpend: async () => {},
    loadCheckpoint: async () => [...harness.checkpoint],
    saveCheckpoint: async (_fingerprint, completedKeys) => {
      harness.checkpoint = [...completedKeys];
      harness.checkpointWrites.push([...completedKeys]);
    },
    clearCheckpoint: async () => {
      harness.checkpoint = [];
      harness.checkpointClears++;
    },
    recordFailure: async (itemKey) => {
      harness.failures.push(itemKey);
      return { attempts: 1 };
    },
    clearFailure: async () => {},
  };
  return harness;
}

describe('LinkExtractionPhase batching', () => {
  it('keyset-loads once, reconciles 200-page batches, and is idempotent', async () => {
    const pages = makePages(2 * LINK_EXTRACTION_BATCH_SIZE + 50);
    const db = createFakeDb(pages);
    const first = createRunner(db);

    const result = await new LinkExtractionPhase().run(first.runner, { runId: 'run-1', dryRun: false });
    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({ pages_scanned: 450, pages_processed: 450, batches: 3, failures: 0 });
    // One lightweight catalog page + three body pages + three reconciliation transactions —
    // never one transaction per source, and never retaining the corpus bodies in the catalog.
    expect(first.withTxCalls).toBe(7);
    const pageReads = db.queries.filter((query) => query.includes('cb_internal.cycle_link_pages'));
    expect(pageReads).toHaveLength(4);
    expect(pageReads[0]).toContain('select id, slug, title from');
    expect(pageReads[0]).not.toContain('acl');
    expect(pageReads[1]).toContain('acl, body, extracted_text');
    expect(first.checkpointWrites.map((write) => write[0])).toEqual([pageId(200), pageId(400), pageId(450)]);
    expect(first.checkpointClears).toBe(1);
    // The cycle source-lock helper must return content as well as ACL. If body/extracted_text is
    // dropped from that SQL contract, the batch silently reconciles every source to an empty set.
    expect([...db.links]).toEqual([
      `${pageId(1)}->${pageId(2)}:mention:unique target 0002`,
    ]);

    const before = [...db.links];
    const second = createRunner(db);
    const repeated = await new LinkExtractionPhase().run(second.runner, { runId: 'run-2', dryRun: false });
    expect(repeated.status).toBe('ok');
    expect([...db.links]).toEqual(before);
  });

  it('resumes after a crash at the prior committed batch boundary', async () => {
    const pages = makePages(2 * LINK_EXTRACTION_BATCH_SIZE + 50);
    const db = createFakeDb(pages);
    const first = createRunner(db);
    db.failBatchStartingAt = pageId(201);

    const interrupted = await new LinkExtractionPhase().run(first.runner, { runId: 'run-1', dryRun: false });
    expect(interrupted.status).toBe('fail');
    expect(first.checkpoint).toEqual([pageId(200)]);
    expect(first.checkpointClears).toBe(0);

    db.failBatchStartingAt = null;
    const resumed = createRunner(db, first.checkpoint);
    const completed = await new LinkExtractionPhase().run(resumed.runner, { runId: 'run-2', dryRun: false });
    expect(completed.status).toBe('ok');
    expect(completed.details).toMatchObject({ pages_processed: 250, batches: 2 });
    expect(resumed.checkpointWrites.map((write) => write[0])).toEqual([pageId(400), pageId(450)]);
    expect(resumed.checkpointClears).toBe(1);
    expect(db.links.size).toBe(1);
  });

  it('records one bad page and continues the rest of its batch', async () => {
    const pages = makePages(3);
    const broken = pages[1]!;
    Object.defineProperty(broken, 'body', { get: () => { throw new Error('bad extracted text'); } });
    const db = createFakeDb(pages);
    const harness = createRunner(db);

    const result = await new LinkExtractionPhase().run(harness.runner, { runId: 'run-1', dryRun: false });
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({ pages_scanned: 3, pages_processed: 2, failures: 1 });
    expect(harness.failures).toEqual([broken.id]);
    expect(harness.checkpointClears).toBe(1);
  });

  it('replaces a now-empty source with an empty edge set instead of preserving stale links', async () => {
    const pages = makePages(2);
    pages[0]!.body = null;
    pages[0]!.extracted_text = null;
    const db = createFakeDb(pages);
    db.links.add(`${pageId(1)}->${pageId(2)}:mention:stale`);

    const result = await new LinkExtractionPhase().run(
      createRunner(db).runner,
      { runId: 'run-1', dryRun: false },
    );

    expect(result.status).toBe('ok');
    expect(db.links.size).toBe(0);
  });

  it('the scheduled workflow invokes the real phase, not noop', () => {
    const workflow = readFileSync(new URL('../.github/workflows/cycle.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('bun run cycle --phase link_extraction');
    expect(workflow).not.toContain('bun run cycle --phase noop');
  });
});

describe('extractAndReconcileLinkBatch scale boundaries', () => {
  it('chunks >1,000 target ACLs and a >65,535-parameter-equivalent insert', async () => {
    const sourceCount = LINK_EXTRACTION_BATCH_SIZE;
    const targetsPerSource = 50;
    const targetCount = CYCLE_DEFINER_PAGE_ID_LIMIT + 50;
    const targetCandidates = Array.from({ length: targetCount }, (_, index) => ({
      id: pageId(10_000 + index),
      slug: `scale-target-${String(index + 1).padStart(4, '0')}`,
      title: `Scale Target ${String(index + 1).padStart(4, '0')}`,
    }));
    const sourceRows = Array.from({ length: sourceCount }, (_, sourceIndex) => {
      const mentions = Array.from({ length: targetsPerSource }, (_, offset) =>
        targetCandidates[(sourceIndex * targetsPerSource + offset) % targetCount]!.title);
      return {
        id: pageId(sourceIndex + 1),
        acl: ACL,
        body: mentions.join('. '),
        extracted_text: null,
      };
    });

    const sourceById = new Map(sourceRows.map((row) => [row.id, row] as const));
    const targetById = new Map(targetCandidates.map((row) => [row.id, row] as const));
    const targetAclChunkSizes: number[] = [];
    const insertChunkSizes: number[] = [];
    let pendingInsertRows: Array<Record<string, unknown>> = [];

    const tx = (async (first: unknown, ...values: unknown[]): Promise<unknown> => {
      if (Array.isArray(first) && !Object.hasOwn(first, 'raw')) {
        pendingInsertRows = first as Array<Record<string, unknown>>;
        return { bulk: true };
      }

      const sql = (first as TemplateStringsArray).join(' ? ').replace(/\s+/g, ' ').trim();
      if (sql.includes('cb_internal.cycle_lock_link_sources')) {
        return (values[0] as string[]).flatMap((id) => {
          const row = sourceById.get(id);
          return row ? [row] : [];
        });
      }
      if (sql.includes('cb_internal.cycle_link_page_acls')) {
        const ids = values[0] as string[];
        targetAclChunkSizes.push(ids.length);
        return ids.flatMap((id) => targetById.has(id) ? [{ id, acl: ACL }] : []);
      }
      if (sql.startsWith('delete from links')) return [];
      if (sql.startsWith('insert into links')) {
        insertChunkSizes.push(pendingInsertRows.length);
        pendingInsertRows = [];
        return [];
      }
      throw new Error(`unhandled fake SQL: ${sql}`);
    }) as unknown as postgres.TransactionSql;

    const result = await extractAndReconcileLinkBatch(tx, {
      workspaceId: WORKSPACE_ID,
      sourceRows,
      candidates: targetCandidates,
    });

    const expectedLinks = sourceCount * targetsPerSource;
    // Nine columns per row would be 90,000 binds as one VALUES expression, over PostgreSQL's
    // 65,535 limit. The implementation keeps both independent DB limits bounded.
    expect(expectedLinks * 9).toBeGreaterThan(65_535);
    expect(LINK_INSERT_BATCH_SIZE * 9).toBeLessThan(65_535);
    expect(result.linksWritten).toBe(expectedLinks);
    expect(targetAclChunkSizes).toEqual([CYCLE_DEFINER_PAGE_ID_LIMIT, 50]);
    expect(insertChunkSizes).toEqual([LINK_INSERT_BATCH_SIZE, LINK_INSERT_BATCH_SIZE]);
    expect(Math.max(...targetAclChunkSizes)).toBeLessThanOrEqual(CYCLE_DEFINER_PAGE_ID_LIMIT);
    expect(Math.max(...insertChunkSizes)).toBeLessThanOrEqual(LINK_INSERT_BATCH_SIZE);
  });
});

describe('extractAndReconcileLinks locking', () => {
  it('locks the stable source row first and derives from_acl from that row, not caller input', async () => {
    const source = makePages(1)[0]!;
    const target = { ...makePages(2)[1]!, title: 'Locked Target 0002' };
    let pendingInsertRows: Array<Record<string, unknown>> = [];
    const statements: string[] = [];

    const tx = (async (first: unknown, ..._values: unknown[]): Promise<unknown> => {
      if (Array.isArray(first) && !Object.hasOwn(first, 'raw')) {
        pendingInsertRows = first as Array<Record<string, unknown>>;
        return { bulk: true };
      }
      const sql = (first as TemplateStringsArray).join(' ? ').replace(/\s+/g, ' ').trim();
      statements.push(sql);
      if (sql.startsWith('select id, acl from pages') && sql.includes('for update')) {
        return [{ id: source.id, acl: ['db-current-acl'] }];
      }
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.startsWith('select id, slug, title from pages')) return [target];
      if (sql.startsWith('select id, acl from pages')) {
        return [{ id: target.id, acl: ['target-current-acl'] }];
      }
      if (sql.startsWith('delete from links') || sql.startsWith('insert into links')) return [];
      throw new Error(`unhandled fake SQL: ${sql}`);
    }) as unknown as postgres.TransactionSql;

    await extractAndReconcileLinks(tx, {
      workspaceId: WORKSPACE_ID,
      pageId: source.id,
      pageAcl: ['stale-caller-acl'],
      text: 'See Locked Target 0002.',
    });

    expect(statements[0]).toContain('for update');
    expect(statements[1]).toContain('pg_advisory_xact_lock');
    expect(statements.join(' ')).not.toContain('for share');
    expect(pendingInsertRows).toHaveLength(1);
    expect(pendingInsertRows[0]?.from_acl).toEqual(['db-current-acl']);
    expect(pendingInsertRows[0]?.to_acl).toEqual(['target-current-acl']);
  });
});
