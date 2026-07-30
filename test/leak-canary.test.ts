// THE LEAK CANARY (D16 — sacred, runs in CI forever, never skipped to move faster).
//
// This file asserts ONE property in several shapes: a row is reachable only when its workspace
// matches the caller's active workspace AND its acl overlaps the caller's grants. Everything here
// is fast and deterministic. The slow, timing-dependent cousins — filtered-HNSW recall at corpus
// scale, GUC-bleed concurrency, pool headroom — live in test/perf-recall.test.ts and are gated
// separately. That split is deliberate: welding the flakiest tests in the suite to the one file
// that must never be disabled is exactly how a sacred file gets disabled, and D43 exists because a
// green-but-skipping canary already happened here once.
//
// Written BEFORE migration 0007. On the pre-0007 schema the intra-workspace cases FAIL, which is
// the point — a canary authored after the implementation is a canary written to match it.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { deniedCode } from './helpers/denied.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, appSql, withScopedTx, closePools } from '../src/db/client.ts';
import { aclForScope, buildContext, resolveGrants, visibleBy, type OperationContext } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { operations, operationsByName } from '../src/api/operations.ts';
import { dispatchOp } from '../src/api/dispatch.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('leak-canary', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

// A string that exists in exactly one tenant's content, so "did B see A's data" is a substring
// question rather than a judgement call.
const A_PRIVATE_SECRET = `zqx-private-${RUN}`;
const A_SHARED_TOKEN = `zqx-shared-${RUN}`;
const C_SECRET = `zqx-other-tenant-${RUN}`;

describe.skipIf(!live)('leak canary — a row is reachable only via workspace AND acl', () => {
  // ws1 holds two principals (A the author, B a colleague). ws2 holds C, an unrelated tenant.
  let ws1 = '';
  let ws2 = '';
  let pA = '';
  let pB = '';
  let pC = '';
  let privatePageId = '';
  let sharedPageId = '';

  const realFetch = globalThis.fetch;
  const realOpenAI = mutableConfig.OPENAI_API_KEY;
  const realOpenRouter = mutableConfig.OPENROUTER_API_KEY;

  const ctxFor = (principal: string, workspaceId: string, role = 'owner'): OperationContext =>
    buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: false });

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    // Deterministic embeddings + a chat stub: this file tests isolation, never answer quality.
    globalThis.fetch = installFakeAiFetch(() => '{"answer":"stub","citations":[]}');

    const admin = adminSql();
    const mkPrincipal = async (tag: string) =>
      (
        await admin<{ id: string }[]>`
          insert into principals (email, email_normalized)
          values (${`canary-${tag}-${RUN}@ex.com`}, ${`canary-${tag}-${RUN}@ex.com`}) returning id`
      )[0]!.id;

    pA = await mkPrincipal('a');
    pB = await mkPrincipal('b');
    pC = await mkPrincipal('c');

    const mkWorkspace = async (name: string, owner: string) =>
      (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${name}, ${owner}) returning id`)[0]!.id;

    ws1 = await mkWorkspace(`canary-ws1-${RUN}`, pA);
    ws2 = await mkWorkspace(`canary-ws2-${RUN}`, pC);

    await admin`
      insert into workspace_members (workspace_id, principal_id, role) values
        (${ws1}, ${pA}, 'owner'), (${ws1}, ${pB}, 'admin'), (${ws2}, ${pC}, 'owner')`;

    // A writes one private page and one shared page; C writes one in the other tenant.
    const rPriv = await importPage(ctxFor(pA, ws1), {
      slug: `canary-private-${RUN}`,
      title: 'A private note',
      body: `This note is private to its author. Marker ${A_PRIVATE_SECRET}.`,
      scope: 'private',
    });
    privatePageId = rPriv.pageId;

    const rShared = await importPage(ctxFor(pA, ws1), {
      slug: `canary-shared-${RUN}`,
      title: 'A shared note',
      body: `This note is shared with the whole workspace. Marker ${A_SHARED_TOKEN}.`,
      scope: 'workspace',
    });
    sharedPageId = rShared.pageId;

    await importPage(ctxFor(pC, ws2), {
      slug: `canary-other-${RUN}`,
      title: 'Another tenant',
      body: `Content belonging to a different tenant entirely. Marker ${C_SECRET}.`,
      scope: 'workspace',
    });
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realOpenAI;
    mutableConfig.OPENROUTER_API_KEY = realOpenRouter;
    const admin = adminSql();
    await admin`delete from workspaces where id in (${ws1}, ${ws2})`; // cascades pages + chunks + members
    await admin`delete from principals where id in (${pA}, ${pB}, ${pC})`;
    await closePools({ timeout: 5 });
  }, 60_000);

  // ── The case that cannot pass before 0007 ────────────────────────────────
  // This carries the milestone's headline property by itself. The registry sweep below is
  // workspace-shaped and cannot see it: A and B share a workspace, so every op correctly returns
  // overlapping values and the sweep's oracle has nothing to assert on the ACL axis.
  describe('intra-workspace: a private page is readable by its author alone', () => {
    it('a colleague in the SAME workspace cannot read the private page row', async () => {
      const rows = await withScopedTx(ctxFor(pB, ws1, 'admin'), (tx) =>
        tx<{ id: string }[]>`select id from pages where id = ${privatePageId}`);
      expect(rows.length).toBe(0);
    }, 60_000);

    it("a colleague cannot read the private page's CHUNKS (the denormalized acl is enforced too)", async () => {
      const rows = await withScopedTx(ctxFor(pB, ws1, 'admin'), (tx) =>
        tx<{ id: string }[]>`select id from content_chunks where page_id = ${privatePageId}`);
      expect(rows.length).toBe(0);
    }, 60_000);

    it('the AUTHOR can still read their own private page — the filter is not a blanket deny', async () => {
      const rows = await withScopedTx(ctxFor(pA, ws1), (tx) =>
        tx<{ id: string }[]>`select id from pages where id = ${privatePageId}`);
      expect(rows.length).toBe(1);
    }, 60_000);

    it('both principals see the SHARED page — private is the exception, not the rule', async () => {
      for (const [p, role] of [[pA, 'owner'], [pB, 'admin']] as const) {
        const rows = await withScopedTx(ctxFor(p, ws1, role), (tx) =>
          tx<{ id: string }[]>`select id from pages where id = ${sharedPageId}`);
        expect(rows.length).toBe(1);
      }
    }, 60_000);

    it('search never surfaces the private marker to a colleague, in content OR citations', async () => {
      // Positive control FIRST: the author searching the same term must actually find it, or the
      // absence below proves only that search is broken.
      const { hits: authorHits } = await hybridSearch(ctxFor(pA, ws1), A_PRIVATE_SECRET);
      expect(authorHits.some((h) => h.pageId === privatePageId), 'author cannot find their own page').toBe(true);
      expect(authorHits.some((h) => h.content.includes(A_PRIVATE_SECRET))).toBe(true);

      const { hits } = await hybridSearch(ctxFor(pB, ws1, 'admin'), A_PRIVATE_SECRET);
      expect(hits.some((h) => h.content.includes(A_PRIVATE_SECRET))).toBe(false);
      expect(hits.some((h) => h.pageId === privatePageId)).toBe(false);
      // Not `length === 0`: the vector arm ranks every VISIBLE chunk by distance and always returns
      // its top-k, so B legitimately still gets the SHARED page back for any query. The count-leak
      // property is that B's results contain nothing B may not read — an inflated count sourced
      // from the private row would show up here as a hit whose page B cannot select.
      const visibleToB = await withScopedTx(ctxFor(pB, ws1, 'admin'), (tx) =>
        tx<{ id: string }[]>`select id from pages`);
      const allowed = new Set(visibleToB.map((r) => r.id));
      expect(hits.every((h) => allowed.has(h.pageId)), 'a hit referenced a page B cannot read').toBe(true);
    }, 60_000);

    it('the app-side predicate agrees with the database (visibleBy vs the policy)', async () => {
      const acl = (await adminSql()<{ acl: string[] }[]>`select acl from pages where id = ${privatePageId}`)[0]!.acl;
      expect(visibleBy(acl, resolveGrants(pA, ws1))).toBe(true);
      expect(visibleBy(acl, resolveGrants(pB, ws1))).toBe(false);
    }, 60_000);
  });

  // ── Cross-tenant, via every operation, including ones written later ──────
  // Two-phase oracle. A one-phase sweep ("B sees nothing") passes for an op that returns [], 403s
  // for an unrelated reason, or was never wired to a route — this repo has shipped exactly that
  // vacuity three times (D50 create_invite registered as no op, D62 an unprovable fixture, D64 a
  // nonce test that passed with the defense deleted). So each op must first PROVE it returns the
  // tenant's own value, and only then is its absence for the other tenant meaningful.
  describe('cross-tenant: the registry sweep', () => {
    // op name -> how to exercise it, and the tenant-specific string it must surface for its owner.
    const SWEEP: Record<string, { params: unknown; expect: (ctx: OperationContext) => string }> = {
      get_workspace: { params: {}, expect: (ctx) => (ctx.workspaceId === ws1 ? `canary-ws1-${RUN}` : `canary-ws2-${RUN}`) },
      list_members: { params: {}, expect: (ctx) => (ctx.workspaceId === ws1 ? pA : pC) },
      whoami: { params: {}, expect: (ctx) => ctx.principal },
      ask: { params: { question: A_SHARED_TOKEN }, expect: (ctx) => (ctx.workspaceId === ws1 ? A_SHARED_TOKEN : C_SECRET) },
      // list_pages enumerates the content plane by design, which makes it the single best sweep
      // target in the registry: its whole output is "every page I can reach", so a tenancy bug shows
      // up as another workspace's slug appearing verbatim rather than as a subtle ranking change.
      list_pages: { params: {}, expect: (ctx) => (ctx.workspaceId === ws1 ? `canary-shared-${RUN}` : `canary-other-${RUN}`) },
      // `search` returns raw chunk CONTENT with no model in the way, which makes it the most direct
      // read of the content plane in the registry — an isolation bug here is verbatim text, not a
      // paraphrase an LLM might have laundered.
      search: {
        params: { query: A_SHARED_TOKEN },
        expect: (ctx) => (ctx.workspaceId === ws1 ? A_SHARED_TOKEN : C_SECRET),
      },
    };

    // Ops with no meaningful positive control, each with a stated reason. An op that is neither
    // swept nor listed here fails the completeness check below — so a new op cannot slip through
    // uncovered, which is the whole reason this sweep is registry-parameterized.
    const ALLOWLIST: Record<string, string> = {
      ingest: 'mutating: writing a page as the wrong tenant is covered by the RLS WITH CHECK test in rls-smoke, and a positive control would pollute the corpus mid-sweep',
      create_invite: 'mutating and admin-gated: its tenancy is covered by test/invites.test.ts, which asserts the row is stamped from ctx and not from params',
      delete_page:
        'mutating and DESTRUCTIVE: a cross-tenant positive control would have to delete a real page mid-sweep, and the sweep runs against the same fixtures every later case reads. Covered by test/lifecycle.test.ts, which proves a page in the other tenant is not addressable by id from here',
      replace_page:
        'mutating: rewrites chunks and spends an embedding call per run, and like delete_page it would mutate fixtures the rest of this file depends on. Covered by test/lifecycle.test.ts',
      ingest_file:
        'mutating, and its tenancy is inherited rather than independent: importFile stamps acl from aclForScope(ctx) exactly as importPage does, and the resulting page/chunks/bytes are all proven isolated by the page_sources and quarantine cases in this same file. The BYTES-not-path rule it exists to enforce is asserted by test/ingest-file.test.ts, which is where a positive control belongs',
    };

    it('every non-hidden operation is either swept or explicitly allowlisted', () => {
      const uncovered = operations
        .filter((op) => !op.hidden)
        .map((op) => op.name)
        .filter((name) => !(name in SWEEP) && !(name in ALLOWLIST));
      expect(
        uncovered,
        `these ops are covered by neither the cross-tenant sweep nor the allowlist: ${uncovered.join(', ')}. ` +
          `Add a positive control to SWEEP, or an ALLOWLIST entry stating why one is impossible.`,
      ).toEqual([]);
    });

    for (const [name, spec] of Object.entries(SWEEP)) {
      it(`${name}: returns the caller's own tenant value, and never the other tenant's`, async () => {
        const ctxA = ctxFor(pA, ws1);
        const ctxC = ctxFor(pC, ws2);

        // Phase 1 — positive control. Without this the absence below proves nothing.
        const own = await dispatchOp(ctxA, name, spec.params);
        expect(own.ok, `${name} failed for its own tenant: ${JSON.stringify(own)}`).toBe(true);
        const ownBody = JSON.stringify((own as { data: unknown }).data);
        expect(ownBody, `${name} did not surface its own tenant's value — the oracle is vacuous`)
          .toContain(spec.expect(ctxA));

        // Phase 2 — the actual assertion.
        const other = await dispatchOp(ctxC, name, spec.params);
        // A REFUSAL IS NOT A CLEAN NEGATIVE. Since M4 put the per-principal budget at dispatchOp rung
        // 0 (D94), this call can come back `rate_limited` — and because the line below collapses any
        // non-ok result to '', all three assertions would then pass while asserting nothing. The sweep
        // is 7 ops against a 120/min ceiling so it cannot happen today, but apiLimiter is a module
        // singleton shared across every suite in one bun process, and nothing here resets it. Phase 1
        // has a positive control; this is Phase 2's.
        if (!other.ok) {
          expect(
            (other as { error: { code: string } }).error.code,
            `${name}: the cross-tenant call was SHED by the rate limiter, so the assertions below ` +
              `would pass without ever testing tenancy. The canary must never be answered by the meter.`,
          ).not.toBe('rate_limited');
        }
        const otherBody = other.ok ? JSON.stringify((other as { data: unknown }).data) : '';
        expect(otherBody, `${name} leaked workspace 1 data to workspace 2`).not.toContain(spec.expect(ctxA));
        expect(otherBody).not.toContain(A_PRIVATE_SECRET);
        expect(otherBody).not.toContain(A_SHARED_TOKEN);
      }, 90_000);
    }
  });

  // ── The buggy-query case: RLS, not the op layer, is what filters ─────────
  // Free under RLS-only enforcement and impossible to write meaningfully if the predicate had gone
  // into the engine query instead — which is the strongest argument for where it lives.
  describe('buggy-query: a raw SELECT respects the boundary', () => {
    it('an unfiltered select from another tenant returns none of workspace 1', async () => {
      const rows = await withScopedTx(ctxFor(pC, ws2), (tx) =>
        tx<{ workspace_id: string }[]>`select workspace_id from pages`);
      expect(rows.length).toBeGreaterThan(0); // positive control: C sees C's own
      expect(rows.every((r) => r.workspace_id === ws2)).toBe(true);
    }, 60_000);

    it('a select with NO scoped transaction sees nothing at all (fail closed)', async () => {
      const rows = await appSql()`select id from pages`;
      expect(rows.length).toBe(0);
    }, 60_000);

    it('an unfiltered chunk select never carries another tenant\'s content', async () => {
      const rows = await withScopedTx(ctxFor(pC, ws2), (tx) =>
        tx<{ content: string }[]>`select content from content_chunks`);
      expect(rows.some((r) => r.content.includes(C_SECRET))).toBe(true); // positive control
      expect(rows.some((r) => r.content.includes(A_SHARED_TOKEN))).toBe(false);
      expect(rows.some((r) => r.content.includes(A_PRIVATE_SECRET))).toBe(false);
    }, 60_000);
  });

  // ── Identity plane: no enumeration of people, invites, or memberships ────
  describe('identity enumeration', () => {
    it('a principal sees only themselves in principals', async () => {
      const rows = await withScopedTx(ctxFor(pC, ws2), (tx) => tx<{ id: string }[]>`select id from principals`);
      expect(rows.map((r) => r.id)).toEqual([pC]);
    }, 60_000);

    it('membership rows do not cross the workspace boundary', async () => {
      const rows = await withScopedTx(ctxFor(pC, ws2), (tx) =>
        tx<{ principal_id: string }[]>`select principal_id from workspace_members`);
      const ids = rows.map((r) => r.principal_id);
      expect(ids).toContain(pC); // positive control
      expect(ids).not.toContain(pA);
      expect(ids).not.toContain(pB);
    }, 60_000);

    it('invites are not readable across tenants', async () => {
      // WAS VACUOUS. This fixture creates no invites, so `rows` was always [] and `[].every(...)`
      // is true — the assertion passed unchanged with the invites policy dropped entirely. Its two
      // siblings above both carry positive controls; this one did not, which is exactly the shape
      // the two-phase oracle in the registry sweep exists to prevent.
      const admin = adminSql();
      const ws1Email = `canary-inv-ws1-${RUN}@ex.com`;
      const ws2Email = `canary-inv-ws2-${RUN}@ex.com`;
      await admin`
        insert into invites (workspace_id, email, email_normalized, role, token_hash, invited_by, expires_at)
        values (${ws1}, ${ws1Email}, ${ws1Email}, 'member', ${`h1-${RUN}`}, ${pA}, now() + interval '7 days'),
               (${ws2}, ${ws2Email}, ${ws2Email}, 'member', ${`h2-${RUN}`}, ${pC}, now() + interval '7 days')`;

      const rows = await withScopedTx(ctxFor(pC, ws2), (tx) =>
        tx<{ workspace_id: string; email: string }[]>`select workspace_id, email from invites`);
      const emails = rows.map((r) => r.email);
      // Phase 1 — positive control. Without it the absence below proves nothing.
      expect(emails, 'C cannot see its OWN invite — the negative assertion is vacuous').toContain(ws2Email);
      // Phase 2 — the actual property.
      expect(emails).not.toContain(ws1Email);
      expect(rows.every((r) => r.workspace_id === ws2)).toBe(true);
    }, 60_000);

    it('cb_app holds NO privilege on sessions — a 42501, not an empty result', async () => {
      // Distinct from the cases above on purpose: those are RLS filtering rows, this is a GRANT
      // refusing the statement. Asserting the SQLSTATE is what tells the two apart.
      const code = await deniedCode(() => withScopedTx(ctxFor(pC, ws2), (tx) => tx`select id from sessions`));
      expect(code).toBe('42501');
    }, 60_000);
  });

  // ── D58's tenancy control, asserted rather than assumed ──────────────────
  describe('hnsw.iterative_scan is a tenancy control (D58)', () => {
    it('is a REAL pgvector GUC, not a placeholder that silently accepts anything', async () => {
      // A bare current_setting() read is vacuous here. On pgvector < 0.8 (or a backend where the
      // extension is not loaded) set_config creates a PLACEHOLDER GUC that accepts any string and
      // reads it back verbatim — so the naive assertion passes on a server where the setting does
      // nothing, which is precisely the failure D58 describes. Placeholders carry GUC_NO_SHOW_ALL
      // and are therefore absent from pg_settings; a real GUC is present.
      const rows = await withScopedTx(ctxFor(pA, ws1), (tx) => tx<{ setting: string }[]>`
        select setting from pg_settings where name = 'hnsw.iterative_scan'`);
      expect(rows.length, 'hnsw.iterative_scan is not a real GUC here — pgvector < 0.8 or not loaded').toBe(1);
      expect(rows[0]!.setting).toBe('relaxed_order');
    }, 60_000);

    it('pgvector is >= 0.8 (D14 — the version floor that makes iterative scan exist)', async () => {
      const rows = await adminSql()<{ extversion: string }[]>`
        select extversion from pg_extension where extname = 'vector'`;
      expect(rows.length).toBe(1);
      const [maj, min] = rows[0]!.extversion.split('.').map(Number);
      expect(maj! > 0 || min! >= 8, `pgvector ${rows[0]!.extversion} < 0.8 (DECISIONS D14)`).toBe(true);
    }, 60_000);
  });

  // ── The denormalized acl is enforced on chunks independently of its page ─
  describe('acl drift between a page and its chunks', () => {
    it('a chunk whose acl the caller does not hold is filtered even when its page is visible', async () => {
      const admin = adminSql();
      const chunk = (await admin<{ id: string; acl: string[] }[]>`
        select id, acl from content_chunks where page_id = ${sharedPageId} order by ord limit 1`)[0]!;
      try {
        // Simulate drift: content_chunks.acl is a denormalized copy kept in sync only by the ingest
        // waist, and the composite FK locks workspace_id — NOT acl. Nothing structurally prevents
        // this state, so the canary proves what happens when it occurs rather than assuming it cannot.
        await admin`update content_chunks set acl = ${[`self:${pC}`]} where id = ${chunk.id}`;

        const rows = await withScopedTx(ctxFor(pA, ws1), (tx) =>
          tx<{ id: string }[]>`select id from content_chunks where id = ${chunk.id}`);
        expect(rows.length, 'a chunk tagged for another principal was still readable').toBe(0);

        // …while its parent page stays visible, which is exactly the asymmetry that makes this
        // silent: search returns fewer hits than expected and nothing errors.
        const page = await withScopedTx(ctxFor(pA, ws1), (tx) =>
          tx<{ id: string }[]>`select id from pages where id = ${sharedPageId}`);
        expect(page.length).toBe(1);
      } finally {
        await admin`update content_chunks set acl = ${chunk.acl} where id = ${chunk.id}`;
      }
    }, 60_000);
  });

  // ── The two planes migration 0009 added ──────────────────────────────────
  //
  // `bun run doctor` proves the DECLARED posture: page_sources_ws and quarantine_ws exist and read
  // `acl && current_grants()` on qual and with_check. That is a snapshot of pg_policies, not
  // evidence that a query is actually filtered — a policy on a table cb_app reaches by some other
  // path, or a with_check that is never evaluated, would look identical in that fixture.
  //
  // These two tables are where the leak would hurt most and be least visible: the ORIGINAL BYTES of
  // a private document, and the FILENAME of one that was rejected before any page existed to
  // protect it.
  describe('page_sources and quarantine (migration 0009)', () => {
    const PRIVATE_BYTES = `zqx-source-bytes-${RUN}`;
    const PRIVATE_REJECT = `zqx-rejected-private-${RUN}.pdf`;
    const SHARED_REJECT = `zqx-rejected-shared-${RUN}.pdf`;

    beforeAll(async () => {
      const ctxA = ctxFor(pA, ws1);
      const priv = aclForScope('private', ctxA);
      const shared = aclForScope('workspace', ctxA);

      // Written through withScopedTx as A, NOT through admin: an insert that the policy's WITH CHECK
      // has actually passed is the only kind whose later invisibility to B means anything.
      await withScopedTx(ctxA, async (tx) => {
        await tx`
          insert into page_sources (page_id, workspace_id, acl, filename, sha256, byte_len, bytes)
          values (${privatePageId}, ${ws1}, ${priv}, ${'private.pdf'}, ${'0'.repeat(64)},
                  ${PRIVATE_BYTES.length}, ${Buffer.from(PRIVATE_BYTES)})`;
        await tx`
          insert into quarantine (workspace_id, owner_principal, acl, filename, reason, detail)
          values (${ws1}, ${pA}, ${priv}, ${PRIVATE_REJECT}, 'binary', ${'62% of characters are not printable text'})`;
        await tx`
          insert into quarantine (workspace_id, owner_principal, acl, filename, reason, detail)
          values (${ws1}, ${pA}, ${shared}, ${SHARED_REJECT}, 'too_short', ${'only 12 characters of text'})`;
      });
    }, 120_000);

    it('a colleague cannot read the stored BYTES of a private document', async () => {
      // The page row and its chunks are already proven invisible above. This is the third copy of
      // the same content and it is governed by a different policy on a different table — so it
      // needs its own proof, not an inference.
      const rows = await withScopedTx(ctxFor(pB, ws1, 'admin'), (tx) =>
        tx<{ bytes: Buffer }[]>`select bytes from page_sources where page_id = ${privatePageId}`);
      expect(rows.length).toBe(0);
    }, 60_000);

    it('the AUTHOR can read them back byte-for-byte (positive control)', async () => {
      const rows = await withScopedTx(ctxFor(pA, ws1), (tx) =>
        tx<{ bytes: Buffer }[]>`select bytes from page_sources where page_id = ${privatePageId}`);
      expect(rows.length).toBe(1);
      expect(rows[0]!.bytes.toString('utf8')).toBe(PRIVATE_BYTES);
    }, 60_000);

    it('the other tenant sees no source rows at all', async () => {
      // Seeded in ws2 FIRST. Without a row of C's own this asserted `.every()` over an array that is
      // empty by construction — true whether the policy filtered it or the table simply had nothing
      // for C, which are different facts and only one of them is the property under test.
      const admin = adminSql();
      const otherPage = (await admin<{ id: string }[]>`select id from pages where workspace_id = ${ws2} limit 1`)[0]!;
      await admin`
        insert into page_sources (page_id, workspace_id, acl, filename, sha256, byte_len, bytes)
        values (${otherPage.id}, ${ws2}, ${[`ws:${ws2}`]}, ${`other-tenant-${RUN}.pdf`}, ${'c'.repeat(64)},
                ${5}, ${Buffer.from('other')})
        on conflict (page_id) do nothing`;

      const rows = await withScopedTx(ctxFor(pC, ws2), (tx) =>
        tx<{ workspace_id: string; filename: string }[]>`select workspace_id, filename from page_sources`);
      // Phase 1 — C sees its OWN stored file, so the absence below is a filter and not an empty table.
      expect(rows.map((r) => r.filename), 'C cannot see its own source row — the negative is vacuous')
        .toContain(`other-tenant-${RUN}.pdf`);
      // Phase 2 — and nothing of ws1's.
      expect(rows.every((r) => r.workspace_id === ws2)).toBe(true);
      expect(rows.map((r) => r.filename)).not.toContain('private.pdf');
    }, 60_000);

    it('a writer cannot stamp source bytes with an acl it does not hold', async () => {
      // The WITH CHECK half. Without it a caller could store bytes tagged for someone else —
      // creating a row it cannot itself read back, which is unrecoverable (the same policy that
      // hides it blocks repairing it) and, worse, plants readable content under another identity.
      const code = await deniedCode(() =>
        withScopedTx(ctxFor(pA, ws1), (tx) => tx`
          insert into page_sources (page_id, workspace_id, acl, filename, sha256, byte_len, bytes)
          values (${sharedPageId}, ${ws1}, ${[`self:${pB}`]}, ${'smuggled.pdf'}, ${'1'.repeat(64)},
                  ${1}, ${Buffer.from('x')})`),
      );
      expect(code, 'a page_sources row was stamped with an unheld grant').toBe('42501');
    }, 60_000);

    it('cb_app cannot UPDATE stored bytes — a 42501, not a filtered row', async () => {
      // The runtime half of the narrowGrants revoke. Bytes and the sha256 that identifies them must
      // move together or not at all, so replace_page deletes and re-inserts; a partial UPDATE would
      // let the two diverge with nothing to notice.
      const code = await deniedCode(() =>
        withScopedTx(ctxFor(pA, ws1), (tx) => tx`
          update page_sources set bytes = ${Buffer.from('tampered')} where page_id = ${privatePageId}`));
      expect(code).toBe('42501');
    }, 60_000);

    it("a colleague cannot see the FILENAME of a privately-scoped rejected upload", async () => {
      // The reason quarantine is a full tenancy-plane table rather than a metadata log. A
      // workspace-equality-only policy would pass every check above and still show every member
      // `Priya_termination_letter.pdf` — for a file that was never even accepted.
      const rows = await withScopedTx(ctxFor(pB, ws1, 'admin'), (tx) =>
        tx<{ filename: string }[]>`select filename from quarantine`);
      const names = rows.map((r) => r.filename);
      expect(names).not.toContain(PRIVATE_REJECT);
      // …and the workspace-scoped rejection IS visible, so this is acl enforcement rather than the
      // table being unreadable for some unrelated reason.
      expect(names, 'nothing is visible — the negative above proves nothing').toContain(SHARED_REJECT);
    }, 60_000);

    it('the other tenant sees no quarantine rows', async () => {
      // Same fix as the page_sources case above, and it mattered doubly here: the only ws1 row this
      // checked was SHARED_REJECT, whose acl is `ws:<ws1>` — a tag C's keyring can never overlap. So
      // the assertion held even with the workspace_id half of the policy removed, testing the acl
      // half twice and the tenancy half not at all.
      const otherReject = `other-tenant-reject-${RUN}.bin`;
      await withScopedTx(ctxFor(pC, ws2), (tx) => tx`
        insert into quarantine (workspace_id, owner_principal, acl, filename, reason, detail)
        values (${ws2}, ${pC}, ${[`ws:${ws2}`]}, ${otherReject}, 'binary', ${'seeded control'})`);

      const rows = await withScopedTx(ctxFor(pC, ws2), (tx) =>
        tx<{ filename: string }[]>`select filename from quarantine`);
      const names = rows.map((r) => r.filename);
      expect(names, 'C cannot see its own quarantine row — the negative is vacuous').toContain(otherReject);
      expect(names).not.toContain(SHARED_REJECT);
      expect(names).not.toContain(PRIVATE_REJECT);
    }, 60_000);

    it('cb_app cannot UPDATE a quarantine verdict', async () => {
      // A rewritable `reason` is not evidence of anything. The gate's own record of what it decided
      // has to be append-only for a false-reject investigation to mean something.
      const code = await deniedCode(() =>
        withScopedTx(ctxFor(pA, ws1), (tx) => tx`
          update quarantine set reason = 'too_short' where filename = ${SHARED_REJECT}`));
      expect(code).toBe('42501');
    }, 60_000);
  });

  // ── Guard against the sweep itself rotting ──────────────────────────────
  it('the registry is non-empty and reachable (a sweep over zero ops proves nothing)', () => {
    expect(operations.length).toBeGreaterThan(0);
    expect(operationsByName.whoami).toBeDefined();
  });
});
