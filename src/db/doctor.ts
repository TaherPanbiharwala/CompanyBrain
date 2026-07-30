// `bun run doctor` — the standing assertion that M2's security posture is what we think it is.
//
// The twelve cross-tenant defects closed during M2's review were closed by GRANTs and POLICIES, not
// by application code. Nothing in the type system or the test suite can see those. This turns them
// from a one-shot audit into something that fails loudly the day it drifts: four snapshots diffed
// against checked-in fixtures, plus explicit boolean assertions on the cells that actually carry
// the tenancy boundary.
//
// Run it AFTER `bun run migrate` has run TWICE — the highest-value regression here (grantExisting
// re-broadening every table on every run) is an idempotency bug that a single run cannot catch.
//
// `bun run doctor --update` regenerates the fixtures. md5(prosrc) tracks the exact function body and
// pg_policies.qual is Postgres-normalized text, so neither is hand-authorable. A fixture bump is
// reviewed as a SECURITY CHANGE, never regenerated blindly to make the check green.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { adminSql, closePools } from './client.ts';
import { collectFiles, sha256 } from './migrate.ts';
import { config } from '../config.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Compare the migration files on disk against the `_migrations` ledger.
 *
 * PURE, and exported, so the three classifications can be tested without a database — the checks that
 * use them were the only part of doctor that had no coverage at all, and the `null`-checksum branch
 * in particular is unreachable from a healthy live run.
 *
 * Three lists rather than one because the remedies are three different actions: run migrate /
 * reconcile the branches / restore the file. A NULL recorded checksum counts as DRIFT, not as
 * "fine" — an unverified checksum is not a verified one, which is the position the migrate runner
 * already takes.
 */
export function classifyLedger(
  files: readonly { name: string; sha: string }[],
  ledger: ReadonlyMap<string, string | null>,
): { pending: string[]; orphans: string[]; drifted: string[] } {
  const onDisk = new Set(files.map((f) => f.name));
  const pending = files.filter((f) => !ledger.has(f.name)).map((f) => f.name);
  const orphans = [...ledger.keys()].filter((n) => !onDisk.has(n));
  const drifted: string[] = [];
  for (const f of files) {
    const recorded = ledger.get(f.name);
    if (recorded === undefined) continue; // already reported as pending
    if (recorded === null) { drifted.push(`${f.name} (no checksum recorded)`); continue; }
    if (f.sha !== recorded) drifted.push(`${f.name} (content changed)`);
  }
  return { pending, orphans, drifted };
}

/** Print one verdict the moment it is reached.
 *
 *  Shared by the fixture diffs and by every boolean check, because buffering was the actual defect:
 *  results were collected and rendered only after the last one, so one throw mid-run (an unguarded
 *  query against a table a migration had not created yet) discarded everything already proven and
 *  left the operator with a bare SQLSTATE. */
function renderCheck(c: Check): void {
  if (c.ok) console.log(`  ok   ${c.name}`);
  else console.log(`  FAIL ${c.name}${c.detail ? `\n       ${c.detail}` : ''}`);
}

// ── Snapshots ─────────────────────────────────────────────────────────────
// Each returns a stable, ordered, JSON-serializable shape.

/** Every SECURITY DEFINER function in the schemas we are responsible for.
 *  Includes `public` on purpose: Supabase provisions `public.rls_auto_enable()` (the ensure_rls
 *  event trigger), so "there must be zero definers in public" is FALSE on a real project. Snapshot-
 *  and-diff is strictly stronger anyway — it catches a NEW definer, a changed owner, an unpinned
 *  search_path, and a widened ACL, none of which a count would notice.
 *
 *  A changed BODY is caught for cb_internal definers only. public.rls_auto_enable is Supabase's, and
 *  its body legitimately changes under vendor maintenance — see the CASE expression below for why
 *  pinning it trains the operator to run --update reflexively. Everything else about it stays pinned. */
async function snapshotDefiners(sql: postgres.Sql) {
  return sql`
    select n.nspname                                   as schema,
           p.proname                                   as name,
           pg_get_function_identity_arguments(p.oid)   as args,
           pg_get_userbyid(p.proowner)                 as owner,
           coalesce(p.proconfig::text, '(unpinned)')   as config,
           coalesce(p.proacl::text, '(default: PUBLIC EXECUTE)') as acl,
           -- Body hash ONLY for the definers we author. public.rls_auto_enable() is Supabase's own
           -- event trigger: its body legitimately changes during vendor maintenance, and a check
           -- that goes red for a reason the operator cannot act on teaches them to reach for
           -- --update reflexively — which is precisely how a REAL drift gets rubber-stamped.
           -- Every security-relevant property of it is still pinned below (owner, pinned
           -- search_path, ACL), and a NEW definer appearing in public still fails the diff.
           case when n.nspname = 'cb_internal' then md5(p.prosrc)
                else '(vendor-owned: body not pinned)' end as body_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname in ('cb_internal', 'public')
    order by 1, 2, 3`;
}

/** PUBLIC is in the grantee list deliberately. cb_app and cb_auth hold PUBLIC's privileges IN
 *  ADDITION to their own, so a stray `GRANT SELECT ON principals TO PUBLIC` — or an
 *  `ALTER DEFAULT PRIVILEGES … TO PUBLIC` added later — widens both roles while producing zero diff
 *  in a snapshot filtered to the two named roles. The has_*_privilege booleans below DO account for
 *  PUBLIC, but they cover only a dozen hand-picked cells; everything else was unguarded. */
async function snapshotTableGrants(sql: postgres.Sql) {
  return sql`
    select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
    from information_schema.role_table_grants
    where grantee in ('cb_app', 'cb_auth', 'PUBLIC') and table_schema = 'public'
    group by 1, 2 order by 1, 2`;
}

/** THE detector. information_schema.role_table_grants derives from pg_class.relacl and CANNOT see
 *  column-level grants (those live in pg_attribute.attacl). After
 *  `REVOKE UPDATE ON t FROM r; GRANT UPDATE(col) ON t TO r;` the table view shows NO update row at
 *  all — so a matrix asserted from table grants alone is blind to exactly the column grants that
 *  carry the boundary, and to a table grant silently dominating one. */
async function snapshotColumnGrants(sql: postgres.Sql) {
  return sql`
    select grantee, table_name, column_name, privilege_type
    from information_schema.role_column_grants
    where grantee in ('cb_app', 'cb_auth', 'PUBLIC') and table_schema = 'public'
    order by 1, 2, 3, 4`;
}

/** `permissive` is in here deliberately, and was missing until this pass.
 *
 *  It is the field that decides whether a policy WIDENS or NARROWS access. Multiple PERMISSIVE
 *  policies on a table are OR'd — so adding one can only grant more — while a RESTRICTIVE policy is
 *  AND'd and can only take away. Flipping an existing policy from RESTRICTIVE to PERMISSIVE is
 *  therefore a real privilege change that left every other column in this snapshot byte-identical.
 *  Same shape as the `relrowsecurity` gap the M2 review found: the snapshot listed the policies and
 *  could not see the thing that decided whether they bound. */
async function snapshotPolicies(sql: postgres.Sql) {
  return sql`
    select tablename, policyname, coalesce(roles::text, '{public}') as roles, cmd, permissive,
           coalesce(qual, '(none)') as qual, coalesce(with_check, '(none)') as with_check
    from pg_policies where schemaname = 'public'
    order by 1, 2`;
}

// ── Explicit assertions ───────────────────────────────────────────────────

async function booleanChecks(sql: postgres.Sql): Promise<Check[]> {
  const checks: Check[] = [];
  // Records AND prints. See renderCheck — a verdict that is only buffered is a verdict a later throw
  // can erase.
  const add = (name: string, ok: boolean, detail?: string): void => {
    const c: Check = { name, ok, detail };
    checks.push(c);
    renderCheck(c);
  };

  // The cells that carry the tenancy boundary. Each maps to a specific defect found in review.
  const p = (
    await sql<Record<string, boolean>[]>`select
      has_column_privilege('cb_app','invites','role','UPDATE')            as app_invite_role,
      has_column_privilege('cb_app','invites','status','UPDATE')          as app_invite_status,
      has_column_privilege('cb_app','workspaces','domain','UPDATE')       as app_ws_domain,
      has_column_privilege('cb_app','workspaces','name','UPDATE')         as app_ws_name,
      has_column_privilege('cb_app','principals','google_sub','UPDATE')   as app_sub,
      has_column_privilege('cb_app','principals','email','UPDATE')        as app_email,
      has_column_privilege('cb_auth','principals','google_sub','UPDATE')  as auth_sub,
      has_column_privilege('cb_auth','workspaces','domain','UPDATE')      as auth_ws_domain,
      has_table_privilege('cb_app','workspaces','DELETE')                 as app_ws_del,
      has_table_privilege('cb_app','workspace_members','DELETE')          as app_wm_del,
      has_table_privilege('cb_app','sessions','SELECT')                   as app_sessions_sel`
  )[0]!;

  add('cb_app cannot UPDATE invites.role (no self-minted owner invites)', p.app_invite_role === false);
  add('cb_app CAN UPDATE invites.status (revocation path works)', p.app_invite_status === true);
  add('cb_app cannot UPDATE workspaces.domain (domain-squat mutation path)', p.app_ws_domain === false);
  add('cb_app CAN UPDATE workspaces.name (rename works)', p.app_ws_name === true);
  add('cb_app cannot UPDATE principals.google_sub (identity rebinding)', p.app_sub === false);
  add('cb_app cannot UPDATE principals.email (invite-match key)', p.app_email === false);
  add('cb_auth cannot UPDATE principals.google_sub (adopt is a definer fn)', p.auth_sub === false);
  add('cb_auth cannot UPDATE workspaces.domain', p.auth_ws_domain === false);
  add('cb_app cannot DELETE workspaces (whole-tenant destruction)', p.app_ws_del === false);
  add('cb_app cannot DELETE workspace_members (lock out every colleague)', p.app_wm_del === false);
  add('cb_app has no SELECT on sessions (definer-only access)', p.app_sessions_sel === false);

  // Function-level ACLs. The definers exist to SHRINK the pre-auth surface; a PUBLIC EXECUTE would
  // hand it to every role, and cb_auth executing resolve_session would widen it back out.
  const f = (
    await sql<Record<string, boolean>[]>`select
      has_function_privilege('public','cb_internal.resolve_session(text)','EXECUTE')  as pub_resolve,
      has_function_privilege('cb_app','cb_internal.resolve_session(text)','EXECUTE')  as app_resolve,
      has_function_privilege('cb_auth','cb_internal.resolve_session(text)','EXECUTE') as auth_resolve,
      has_function_privilege('cb_auth','cb_internal.adopt_principal(uuid,text)','EXECUTE') as auth_adopt,
      has_function_privilege('cb_app','cb_internal.adopt_principal(uuid,text)','EXECUTE')  as app_adopt,
      has_schema_privilege('cb_app','cb_internal','CREATE')  as app_create_internal,
      has_schema_privilege('cb_app','public','CREATE')       as app_create_public,
      has_schema_privilege('cb_auth','public','CREATE')      as auth_create_public`
  )[0]!;

  add('PUBLIC cannot EXECUTE resolve_session', f.pub_resolve === false);
  add('cb_app CAN EXECUTE resolve_session (the hot path)', f.app_resolve === true);
  add('cb_auth cannot EXECUTE resolve_session (login role stays off the hot path)', f.auth_resolve === false);
  add('cb_auth CAN EXECUTE adopt_principal (its only definer)', f.auth_adopt === true);
  add('cb_app cannot EXECUTE adopt_principal', f.app_adopt === false);
  add('cb_app cannot CREATE in cb_internal (cannot replace a definer body)', f.app_create_internal === false);
  add('cb_app cannot CREATE in public', f.app_create_public === false);
  add('cb_auth cannot CREATE in public', f.auth_create_public === false);

  // ── M3: the keyring reader ────────────────────────────────────────────────
  // current_grants() is evaluated INSIDE the content policies, and RLS evaluates policy expressions
  // with the QUERYING role's privileges. So the GRANT below is not hygiene: without it every read
  // and write of pages/content_chunks fails `42501 permission denied for function current_grants`,
  // a total outage of ingest and ask — and doctor, which connects as the owner, would otherwise
  // report green straight through it. The negative check (no PUBLIC) without the positive check
  // (cb_app CAN) is exactly the one-sided assertion that lets that ship.
  // The existence probe is its OWN query, deliberately. It used to sit in the same SELECT as the
  // has_function_privilege() calls below — and those RAISE undefined_function when the function is
  // absent, so the query threw before `exists` could be read. The check whose entire purpose is to
  // report "0007 was not applied" could never report it: the operator got a raw postgres error
  // instead. Same shape as the guards this file exists to catch.
  const cgExists =
    (await sql<{ exists: boolean }[]>`select to_regprocedure('public.current_grants()') is not null as exists`)[0]!
      .exists === true;
  add('current_grants() exists (migration 0007 applied)', cgExists,
    cgExists ? '' : 'Migration 0007 has not been applied to this database. Run `bun run migrate`.');

  // Each dependent check is still REPORTED when the function is missing, as a failure naming the
  // cause — not skipped, and not allowed to throw. A partially-migrated database is exactly when an
  // operator needs the most output, so the run continues past this block either way.
  const CG_DEPENDENT = [
    'cb_app CAN EXECUTE current_grants() (every content query evaluates it)',
    'PUBLIC cannot EXECUTE current_grants()',
    'cb_auth cannot EXECUTE current_grants() (login lane stays off the content plane)',
    'current_grants() is STABLE, not IMMUTABLE (an immutable one would be constant-folded into a cached plan)',
    'current_grants() is NOT SECURITY DEFINER',
    'current_grants() body is unchanged',
  ];

  if (!cgExists) {
    for (const name of CG_DEPENDENT) add(name, false, 'current_grants() does not exist — see the check above.');
  } else {
    const cg = (
      await sql<Record<string, boolean | string | null>[]>`select
        has_function_privilege('public','public.current_grants()','EXECUTE')       as pub_exec,
        has_function_privilege('cb_app','public.current_grants()','EXECUTE')       as app_exec,
        has_function_privilege('cb_auth','public.current_grants()','EXECUTE')      as auth_exec,
        (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='current_grants')                 as volatility,
        (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='current_grants')                 as secdef,
        (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='current_grants')                 as body_md5`
    )[0]!;

    add(CG_DEPENDENT[0]!, cg.app_exec === true,
      cg.app_exec === true ? '' : 'Without this, EVERY content read and write fails 42501. Re-run `bun run migrate`.');
    add(CG_DEPENDENT[1]!, cg.pub_exec === false);
    add(CG_DEPENDENT[2]!, cg.auth_exec === false);
    // 's' = STABLE. IMMUTABLE ('i') would let the planner constant-fold a zero-argument function at
    // PLAN time; client.ts uses `prepare: !isPooler`, so on a direct connection a cached generic plan
    // would carry one principal's grants into another principal's query.
    add(CG_DEPENDENT[3]!, cg.volatility === 's', `provolatile=${String(cg.volatility)}`);
    add(CG_DEPENDENT[4]!, cg.secdef === false);
    // snapshotDefiners only covers prosecdef functions, so this non-definer function appears in NO
    // fixture — pin its body here or a rewrite of the predicate is invisible to every check.
    add(CG_DEPENDENT[5]!, cg.body_md5 === '2ac149bb8dd7732a6a2af21165709efa',
      `md5(prosrc)=${String(cg.body_md5)} — if you changed the function deliberately, update this hash and review the diff as a security change`);
  }

  // The policies actually carry the clause. The fixture diff would catch a change too, but this
  // names the specific fail-open shape so the failure message is actionable, and doctor runs as the
  // owner so it structurally cannot test the policy's EFFECT — that is the leak canary's job.
  // rls-exempt: reads pg_policies (the policy TEXT) on the owner pool, never a content row. Auditing
  // the policy from inside the policy would be circular.
  const aclPolicies = await sql<{ tablename: string; qual: string | null; with_check: string | null }[]>`
    select tablename, qual, with_check from pg_policies
    where schemaname = 'public' and tablename in ('pages','content_chunks') and policyname like '%_ws'`;
  const missingAcl = aclPolicies.filter(
    (p) => !(p.qual ?? '').includes('current_grants') || !(p.with_check ?? '').includes('current_grants'),
  );
  add('content policies enforce acl && current_grants (qual AND with_check)', missingAcl.length === 0,
    missingAcl.length === 0
      ? ''
      : `missing on: ${missingAcl.map((p) => p.tablename).join(', ')}. A content policy without this clause makes ` +
        `every private page readable by every workspace member. Do NOT run \`doctor --update\`. Re-run ` +
        `\`bun run migrate\`, then confirm: select * from _migrations where filename = 'migrations/0007_acl_rls.sql';`);

  // D14's version floor, asserted nowhere until now. Below 0.8 there is no iterative scan, so
  // set_config('hnsw.iterative_scan', …) silently creates a placeholder GUC that accepts any string
  // and does nothing — D58's tenancy control, present in the code and absent from the server.
  const pgv = await sql<{ extversion: string }[]>`select extversion from pg_extension where extname = 'vector'`;
  const ver = pgv[0]?.extversion ?? '';
  const [vMaj, vMin] = ver.split('.').map(Number);
  add(`pgvector >= 0.8 (D14 — the floor that makes hnsw.iterative_scan real)`,
    ver !== '' && ((vMaj ?? 0) > 0 || (vMin ?? 0) >= 8), `installed ${ver || '(missing)'}`);

  // idx_chunks_fts backs the keyword arm. 0006 warns that an expression mismatch "does not error,
  // it silently falls back to a sequential scan" — and nothing checked it. Match on the indexed
  // expression, not just the name, since a same-named index over a different expression is the
  // failure being guarded against.
  const fts = await sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes where schemaname='public' and indexname='idx_chunks_fts'`;
  add('idx_chunks_fts exists and indexes to_tsvector(english, content)',
    (fts[0]?.indexdef ?? '').includes("to_tsvector('english'::regconfig, content)"),
    fts[0]?.indexdef ?? '(missing)');

  // The title arm's index, asserted on its EXPRESSION for the reason the M3 review found: 0009
  // shipped a btree on `lower(title)` while the arm filters with `to_tsvector(...) @@ tsquery`. The
  // name matched, the kind did not, and a btree cannot answer a tsquery — so the arm seq-scanned
  // `pages` on every ask while the index cost writes and served nothing. Nothing noticed, because
  // nothing asserted the definition. A name-only check would have passed then too.
  const titleFts = await sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes where schemaname='public' and indexname='idx_pages_title_fts'`;
  add('idx_pages_title_fts is a GIN index over to_tsvector(english, title)',
    (titleFts[0]?.indexdef ?? '').includes('USING gin') &&
      (titleFts[0]?.indexdef ?? '').includes("to_tsvector('english'::regconfig, COALESCE(title"),
    titleFts[0]?.indexdef ?? '(missing — run bun run migrate; migration 0011 creates it)');

  // The dead one must be GONE, not merely superseded. Leaving it costs two index writes per page
  // insert and update for a query shape nothing issues.
  const deadTitleIdx = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_indexes
    where schemaname='public' and indexname='idx_pages_title_prefix'`;
  add('the dead idx_pages_title_prefix btree has been dropped', (deadTitleIdx[0]?.n ?? 1) === 0,
    'migration 0011 drops it — it indexed lower(title) for a predicate that is full-text search');

  // listPages ordering and slug resolution. Both are read paths whose index went missing silently:
  // the first never had one, the second lost it when 0007 replaced UNIQUE(workspace_id, slug) with
  // two indexes that are PARTIAL on scope and therefore unusable for a scope-less lookup.
  for (const idx of ['idx_pages_ws_updated', 'idx_pages_ws_slug']) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_indexes where schemaname='public' and indexname=${idx}`;
    add(`${idx} exists`, (rows[0]?.n ?? 0) === 1, 'migration 0011 creates it');
  }

  // content_chunks.acl is a denormalized copy of pages.acl, kept in sync only by the ingest waist —
  // the composite FK locks workspace_id, NOT acl. After 0007 a drifted chunk is filtered
  // independently of its page, so search silently returns fewer hits and nothing errors.
  // rls-exempt: a cross-TENANT integrity count on the owner pool, deliberately. A scoped read sees
  // one workspace, so it could never answer "has any chunk anywhere drifted from its page" — which
  // is the only useful form of this question. Counts only; no content is read.
  const drift = await sql<{ n: number }[]>`
    select count(*)::int as n from content_chunks c join pages p on p.id = c.page_id
    where c.acl is distinct from p.acl`;
  add('no chunk acl has drifted from its page acl', (drift[0]?.n ?? -1) === 0,
    `${drift[0]?.n ?? '?'} drifted chunk(s) — these are filtered independently of their page, which shows up as missing search hits, not an error`);

  // page_sources.acl is the same denormalization with the opposite failure mode. A chunk that drifts
  // becomes INVISIBLE (a missing search hit); a source row that drifts toward a wider acl stays
  // visible after its page was made private — so the file a user believed they had locked down is
  // still downloadable. Same query shape, and worth its own line because the consequence differs.
  //
  // Guarded on the table's existence. Unguarded, this threw a raw 42P01 on any database below 0009
  // and — because results were accumulated and only rendered at the end — the operator saw NOTHING,
  // not even the checks that had already passed. The current_grants() checks above were already
  // written defensively; this one was not, which is the whole difference between "you have not
  // migrated" and an unexplained postgres error code.
  // rls-exempt: catalog probe on the owner pool — asks whether a table exists, reads no rows.
  const hasPageSources =
    (await sql<{ present: boolean }[]>`select to_regclass('public.page_sources') is not null as present`)[0]!.present;
  if (!hasPageSources) {
    add('no page_sources acl has drifted from its page acl', false,
      'page_sources does not exist — migration 0009 has not been applied. Run `bun run migrate`.');
  } else {
    // rls-exempt: same reason as the chunk drift count above — cross-tenant, owner pool, counts only.
    const srcDrift = await sql<{ n: number }[]>`
      select count(*)::int as n from page_sources s join pages p on p.id = s.page_id
      where s.acl is distinct from p.acl`;
    add('no page_sources acl has drifted from its page acl', (srcDrift[0]?.n ?? -1) === 0,
      `${srcDrift[0]?.n ?? '?'} drifted source row(s) — a widened one keeps the original file readable after its page was made private`);
  }

  // Index VALIDITY, which no other check here can see. All five index assertions below read
  // pg_indexes, whose columns are schemaname/tablename/indexname/tablespace/indexdef — there is no
  // validity column, so an INVALID index left by a cancelled CREATE INDEX CONCURRENTLY renders
  // there identically to a healthy one and passes both the name and the indexdef checks. It is
  // never used by the planner and still maintained on every write: strictly worse than the dead
  // index 0011 was written to remove. Remedy is one command, so detect and say so rather than
  // repair from a migration:  REINDEX INDEX CONCURRENTLY <name>;
  // rls-exempt: catalog read on the owner pool, no tenant rows.
  const invalid = await sql<{ names: string | null }[]>`
    select string_agg(c.relname, ', ' order by c.relname) as names
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not i.indisvalid`;
  const invalidNames = invalid[0]?.names ?? null;
  add('no INVALID indexes (a cancelled CREATE INDEX CONCURRENTLY leaves one)', invalidNames === null,
    invalidNames === null ? '' : `INVALID: ${invalidNames} — the planner ignores these but every write still maintains them. Fix with: REINDEX INDEX CONCURRENTLY <name>;`);

  // The acl non-empty CHECKs, by DEFINITION and not just by name. Nothing in this file queried
  // pg_constraint, which is exactly how four constraints that enforced nothing survived a 62-check
  // posture verifier: `array_length('{}',1)` is NULL and a CHECK passes on NULL, so `acl = '{}'` —
  // a row permanently invisible to every principal including its author — was accepted for the
  // whole life of 0007. Asserting the definition, not the name, is the same lesson the index checks
  // above learned when a same-named btree shipped where a GIN index was needed.
  const aclChecks = await sql<{ conname: string; def: string }[]>`
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint where conname like '%\_acl\_nonempty' order by conname`;
  const EXPECTED_ACL_CHECKS = ['chunks_acl_nonempty', 'page_sources_acl_nonempty', 'pages_acl_nonempty', 'quarantine_acl_nonempty'];
  const foundNames = aclChecks.map((r) => r.conname);
  add('all four acl non-empty CHECK constraints are present',
    EXPECTED_ACL_CHECKS.every((n) => foundNames.includes(n)),
    `found: ${foundNames.join(', ') || 'none'} — expected ${EXPECTED_ACL_CHECKS.join(', ')}`);
  const stillArrayLength = aclChecks.filter((r) => !r.def.includes('cardinality')).map((r) => r.conname);
  add('acl non-empty CHECKs use cardinality(), not array_length() (migration 0012)',
    aclChecks.length > 0 && stillArrayLength.length === 0,
    stillArrayLength.length ? `${stillArrayLength.join(', ')} still use array_length, which returns NULL for '{}' — a CHECK is SATISFIED when NULL, so these enforce nothing` : '');

  // ── Migrations current ───────────────────────────────────────────────────
  //
  // docs/plan.md:189 named "migrations current" as one of doctor v1's five checks and it was never
  // built. Everything else in this file probes an ARTIFACT of a specific migration —
  // current_grants() implies 0007, idx_pages_ws_slug implies 0011, cardinality() in the acl CHECKs
  // implies 0012, to_regclass('page_sources') implies 0009 — so a database missing a migration that
  // nothing here happens to touch reports GREEN. That is not hypothetical: this project has already
  // had a shared database sitting in a state no branch's doctor could describe.
  //
  // Three checks rather than one, because the remedies are three different actions: run migrate /
  // reconcile the branches / restore the file.
  const files = await collectFiles();
  // Guarded on the ledger's own existence, for the same reason the page_sources drift count above is:
  // `migrate:reset` drops the public schema, and a data-only restore can leave the tables without it.
  // The check whose entire job is reporting "this database's migration state is unknown" must not be
  // the one that throws 42P01 on it — a throw here costs every check BELOW this point.
  const hasLedger =
    (await sql<{ present: boolean }[]>`select to_regclass('public._migrations') is not null as present`)[0]!.present;
  const ledger = new Map(
    hasLedger
      ? (await sql<{ filename: string; checksum: string | null }[]>`select filename, checksum from _migrations`)
          .map((r) => [r.filename, r.checksum] as const)
      : [],
  );
  if (!hasLedger) {
    add('the _migrations ledger exists', false,
      '_migrations is absent, so NOTHING is known about this database\'s migration state. Run `bun run migrate` TWICE.');
  }

  const { pending, orphans, drifted } = classifyLedger(
    files.map((f) => ({ name: f.name, sha: sha256(readFileSync(f.path, 'utf8')) })),
    ledger,
  );
  add('every migration file on disk has been applied', pending.length === 0,
    pending.length
      ? `NOT APPLIED: ${pending.join(', ')}. Run \`bun run migrate\` TWICE (see the header of this file), then re-run doctor.`
      : `${files.length} files, all present in _migrations`);

  add('every applied migration still exists in this tree', orphans.length === 0,
    orphans.length
      ? `APPLIED BUT ABSENT FROM THIS TREE: ${orphans.join(', ')}. This database has had a migration ` +
        `applied that your branch does not contain. Checksums are immutable, so it can never be ` +
        `re-applied differently — reconcile the branches. Do NOT delete the ledger row.`
      : '');

  add('applied migrations match their recorded checksums', drifted.length === 0,
    drifted.length
      ? `${drifted.join(', ')}. An applied migration is immutable — restore the file (\`git checkout -- <path>\`) ` +
        `and put the change in a NEW migration.`
      : '');

  // ── ACL tag coverage ─────────────────────────────────────────────────────
  //
  // The other check docs/plan.md:189 named and never got. The grant-tag format is enforced by
  // acl_grants_tag_ck — on acl_grants, a table with ZERO readers and ZERO writers in all of src/ and
  // scripts/ — and NOT on pages.acl or content_chunks.acl, which every ingest writes. 0007:114 says
  // so outright: "GRANT_TAG_RE in src/core/context.ts is the only thing excluding that today."
  //
  // ONE copy of each pattern. They were written out per UNION branch, four times each, and the test
  // that pins them against GRANT_TAG_RE uses toContain — which is satisfied by ONE match, so three
  // branches could drift and `pages` could be censused under a different rule than its siblings with
  // every test green.
  const GRANT_TAG_SQL = '^(self|ws|team|role):[A-Za-z0-9_-]+$';
  const UNMINTABLE_SQL = '^(team|role):';

  // The CATALOG decides which tables carry an acl, not a hand-written list. The first version compared
  // a literal ACL_TABLES against the literal table names in its own UNION — two copies of the same
  // list, checked against each other — so a fifth acl-bearing table added by a later migration would
  // be absent from BOTH halves at once and doctor would report green while censusing nothing for it.
  // That is D95's own stated failure ("a database missing a migration nothing here touches reports
  // GREEN") reproduced one level up, and it is not hypothetical: page_sources and quarantine joined
  // this set in 0009, so the set has already grown once.
  //
  // rls-exempt: an information_schema catalog read on the owner pool. Column metadata, no rows.
  const aclTables = (
    await sql<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'acl' and data_type = 'ARRAY'
      order by table_name`
  ).map((r) => r.table_name).filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));

  // rls-exempt: not a query — the NAMES this census expects to find, compared against the catalog
  // above. A mismatch in either direction is the finding.
  const EXPECTED_ACL_TABLES = ['content_chunks', 'page_sources', 'pages', 'quarantine'];
  const unexpectedAcl = aclTables.filter((t) => !EXPECTED_ACL_TABLES.includes(t));
  const missingAclTables = EXPECTED_ACL_TABLES.filter((t) => !aclTables.includes(t));
  add('the acl-bearing tables are exactly the ones this census knows about',
    unexpectedAcl.length === 0 && missingAclTables.length === 0,
    unexpectedAcl.length
      ? `UNCENSUSED: ${unexpectedAcl.join(', ')} carry an acl column and are not in EXPECTED_ACL_TABLES, so ` +
        `the two checks below silently skip them. Add them here in the same change that adds the column.`
      : missingAclTables.length
        ? `MISSING: ${missingAclTables.join(', ')} — migration 0009 has not been applied. Run \`bun run migrate\`.`
        : `${aclTables.join(', ')}`);

  // Built ONLY over tables that exist. Unguarded, a bare `from page_sources` raised 42P01 on any
  // database below 0009 and — because a throw ends booleanChecks — took every check BELOW this point
  // with it, including cb_app NOBYPASSRLS, every-table-RLS-ENABLED and the zero-policy check. That is
  // the exact defect the page_sources drift count above was already fixed for; it came straight back
  // 110 lines lower. Table names come from the catalog and are re-validated against /^[a-z_]\w*$/.
  //
  // Per-table aggregates UNIONed, deliberately not `group by tbl`: a GROUP BY emits only tables that
  // HAVE rows, so with page_sources and quarantine empty it returns two rows and the coverage check
  // would fail on a healthy database. An aggregate with no GROUP BY returns exactly one row over zero
  // input rows, so every table always reports.
  //
  // rls-exempt: a cross-TENANT census of acl tag SHAPES on the owner pool. A scoped read could not
  // answer this even in principle — an unmintable tag makes its own row invisible to every principal
  // INCLUDING its author, so the rows this exists to find are exactly the rows cb_app cannot see.
  // Tag prefixes and COUNTS only; no content, no ids, no tag values.
  const census = aclTables.length
    ? await sql.unsafe<{ tbl: string; malformed: number; unmintable: number; total: number }[]>(
        aclTables
          .map((t) => `select '${t}' as tbl,
              count(*) filter (where tag !~ '${GRANT_TAG_SQL}')::int as malformed,
              count(*) filter (where tag ~ '${UNMINTABLE_SQL}')::int as unmintable,
              count(*)::int as total
            from ${t}, unnest(acl) tag`)
          .join(' union all '),
      )
    : [];

  // The two checks below are DRIFT detectors: on an empty corpus they are vacuous by necessity,
  // because doctor must be green immediately after migrate on a fresh database. Their vacuity control
  // therefore lives in test/acl-tag-format.test.ts, not here. Said out loud because this repo has
  // shipped vacuous assertions three times by not saying it.
  add('the acl census reported a row for every acl-bearing table',
    census.length === aclTables.length,
    census.map((r) => `${r.tbl}=${r.total}`).join(' ') || 'no acl-bearing tables exist');

  const malformed = census.filter((r) => r.malformed > 0);
  add('every acl tag matches the grant-tag format', malformed.length === 0,
    malformed.length
      ? `${malformed.map((r) => `${r.tbl}:${r.malformed}`).join(', ')}. The rule lives in THREE places — ` +
        `GRANT_TAG_RE (src/core/context.ts), acl_grants_tag_ck (0007, on a table with zero readers), and ` +
        `this check — and only the TypeScript one sits on the write path. Repair as the OWNER: a ` +
        `malformed tag can put the row out of cb_app's reach.`
      : '');

  // The check with the real value: these tags are WELL-FORMED and UNMINTABLE. resolveGrants' `extra`
  // parameter is dead at every call site, so no team:/role: tag ever enters a keyring — a row
  // carrying one is invisible to every principal including its author AND unrecoverable through the
  // app, because the same policy that hides it blocks the UPDATE that would repair it. Catching it
  // here is catching it while repair is still possible.
  const unmintable = census.filter((r) => r.unmintable > 0);
  add('no acl tag is unmintable (team:/role: before team scope ships)', unmintable.length === 0,
    unmintable.length
      ? `${unmintable.map((r) => `${r.tbl}:${r.unmintable}`).join(', ')}. Repair NOW, as the owner, across ` +
        `the page AND its content_chunks AND its page_sources row. If team scope is being introduced ` +
        `deliberately, THIS check is the gate: extend it in the same change that ships the write path ` +
        `and the keyring resolver.`
      : '');

  // scope/acl agreement — aclForScope's invariant (src/core/context.ts), asserted nowhere in the
  // database until now. `scope` NAMES a visibility policy and `acl` is what RLS actually reads; when
  // they disagree the label is decorative, which is precisely the regression D52 records. Also
  // surfaces case drift: owner_principal is raw text while selfGrant lowercases.
  //
  // rls-exempt: a cross-TENANT integrity COUNT on the owner pool, the same shape as the acl-drift
  // counts above. A scoped read cannot see a mis-scoped row — that is the definition of the defect.
  const [mismatch] = await sql<{ n: number }[]>`
    select count(*)::int as n from pages
    where scope not in ('private','workspace')
       or (scope = 'private'   and acl <> array['self:' || lower(owner_principal)])
       or (scope = 'workspace' and acl <> array['ws:'   || lower(workspace_id::text)])`;
  add('every page\'s acl agrees with its scope', (mismatch?.n ?? -1) === 0,
    (mismatch?.n ?? -1) === 0 ? '' :
      `${mismatch?.n} page(s) carry an acl that aclForScope would not have produced. Either the label ` +
      `or the enforced tag is wrong, and only one of them is what RLS reads.`);

  // Roles: NOBYPASSRLS, and no membership edge (RLS applicability follows role membership, so an
  // edge in either direction would hand cb_app the cb_auth USING(true) policies).
  const roles = await sql<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]>`
    select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('cb_app','cb_auth') order by 1`;
  for (const r of roles) {
    add(`${r.rolname} is NOBYPASSRLS`, r.rolbypassrls === false);
    add(`${r.rolname} is not SUPERUSER`, r.rolsuper === false);
  }
  add('cb_app and cb_auth both exist', roles.length === 2, `found ${roles.map((r) => r.rolname).join(', ') || 'none'}`);

  const edges = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_auth_members m
    join pg_roles a on a.oid = m.roleid join pg_roles b on b.oid = m.member
    where (a.rolname = 'cb_app' and b.rolname = 'cb_auth') or (a.rolname = 'cb_auth' and b.rolname = 'cb_app')`;
  add('no pg_auth_members edge between cb_app and cb_auth', (edges[0]?.n ?? 1) === 0);

  // A permissive PUBLIC policy with an unconditional qual would OR into cb_app and expose every
  // tenant to every tenant. The policy snapshot would catch a change, but this names the specific
  // fail-open shape so the failure message is actionable.
  const openPublic = await sql<{ tablename: string; policyname: string }[]>`
    select tablename, policyname from pg_policies
    where schemaname = 'public' and roles::text = '{public}'
      and (qual = 'true' or with_check = 'true')`;
  add(
    'no PUBLIC policy with an unconditional qual/with_check',
    openPublic.length === 0,
    openPublic.map((r) => `${r.tablename}.${r.policyname}`).join(', '),
  );

  // resolve_session must not be overloaded — a second signature could take request-controlled args.
  const overloads = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cb_internal' and p.proname = 'resolve_session'`;
  add('exactly one resolve_session (no overloads)', (overloads[0]?.n ?? 0) === 1);

  // Our own definers must pin search_path (a definer running with a caller-controlled search_path is
  // a privilege-escalation primitive) and must never carry PUBLIC EXECUTE.
  const ours = await sql<{ name: string; config: string | null; acl: string | null }[]>`
    select p.proname as name, p.proconfig::text as config, p.proacl::text as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname = 'cb_internal' order by 1`;
  add('all 5 cb_internal definers present', ours.length === 5, `found ${ours.length}`);
  for (const fn of ours) {
    add(`${fn.name}: search_path pinned to 'pg_catalog, public, pg_temp'`,
      (fn.config ?? '').includes('search_path=pg_catalog, public, pg_temp'), fn.config ?? '(unpinned)');
    // A bare `=X/owner` entry (no grantee before the '=') is the PUBLIC grant.
    //
    // NULL proacl is the trap, and this check used to fall straight into it. A function's proacl is
    // NULL until something GRANTs or REVOKEs on it, and NULL means THE DEFAULT ACL APPLIES — which
    // for a function is EXECUTE TO PUBLIC. So NULL is not "no grants", it is the single state this
    // assertion exists to catch. Coalescing it to '' made the regex find nothing and report ok: the
    // check was green precisely when the property was false. (The search_path assertion above gets
    // the same coalesce right by accident — '' fails its .includes(), so it goes red on NULL.)
    //
    // Reachable by dropping the REVOKE in ensureAuthFunctions, or by applying a signature change as
    // DROP+CREATE without re-running it: every role in the cluster gets EXECUTE on
    // cb_internal.membership_role / revoke_session / revoke_all_sessions, and doctor stayed green.
    add(
      `${fn.name}: no PUBLIC EXECUTE in acl`,
      fn.acl !== null && !/(^|[{,])=X\//.test(fn.acl),
      fn.acl ?? 'NULL — the DEFAULT acl applies, which is EXECUTE TO PUBLIC. Run migrate to re-apply the REVOKE.',
    );
  }

  // FORCE ROW LEVEL SECURITY would apply RLS even to the table owner, turning resolve_session into
  // a permanent 0-row return — every request 401s. A pg_policies snapshot cannot see this flag.
  const forced = await sql<{ relname: string }[]>`select relname from pg_class where relforcerowsecurity`;
  add('no table has FORCE ROW LEVEL SECURITY', forced.length === 0, forced.map((r) => r.relname).join(', '));

  // …and the OPPOSITE flag, which is the one that actually matters.
  //
  // This is the single largest tenant-isolation regression the posture can suffer, and until the M2
  // review nothing here could see it: `pg_policies` lists policies whether or not RLS is enabled on
  // the relation, so `ALTER TABLE content_chunks DISABLE ROW LEVEL SECURITY` leaves all four
  // snapshot fixtures byte-identical and every has_*_privilege boolean still true. Every tenant's
  // content becomes readable by cb_app and the auditor stays green.
  //
  // _migrations is exempt by design (see grantExisting): it is fully revoked from cb_app instead.
  const rlsOff = await sql<{ relname: string }[]>`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not c.relrowsecurity
      and c.relname <> '_migrations'
    order by c.relname`;
  add('every public table has RLS ENABLED', rlsOff.length === 0,
    rlsOff.length ? `RLS DISABLED on: ${rlsOff.map((r) => r.relname).join(', ')}` : '');

  // RLS enabled with no policy at all is fail-closed for cb_app (deny everything), which is safe but
  // is almost always a mistake — a table nobody can read reads as "the feature is broken", and the
  // fix is invariably to add a policy in a hurry. Surfacing it here beats discovering it at runtime.
  //
  // _migrations is the one legitimate case: it is deliberately policy-less AND fully revoked from
  // both roles, so deny-everything is the intended posture rather than an oversight.
  const noPolicy = await sql<{ relname: string }[]>`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and c.relname <> '_migrations'
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    order by c.relname`;
  add('no table is RLS-enabled with zero policies', noPolicy.length === 0,
    noPolicy.map((r) => r.relname).join(', '));

  // The embedding column's declared dimension must match what the app embeds with. A mismatch is a
  // hard insert error at ingest time, far from the cause. atttypmod carries the vector dimension.
  // rls-exempt: a pg_catalog lookup of the column's declared type on the owner pool. It reads no
  // tenant rows, and the whole point of doctor is to audit the posture from OUTSIDE the app role.
  const dim = await sql<{ dim: number | null }[]>`
    select atttypmod as dim
    from pg_attribute
    where attrelid = 'public.content_chunks'::regclass and attname = 'embedding'`;
  add(`content_chunks.embedding dimension === EMBEDDING_DIM (${config.EMBEDDING_DIM})`,
    dim[0]?.dim === config.EMBEDDING_DIM, `declared ${dim[0]?.dim ?? '(missing)'}`);

  return checks;
}

// ── Fixture diffing ───────────────────────────────────────────────────────

function fixturePath(name: string): string {
  return join(FIXTURES, `${name}.json`);
}

function diffFixture(name: string, actual: unknown, update: boolean): Check {
  const path = fixturePath(name);
  const actualJson = JSON.stringify(actual, null, 2);
  if (update) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(path, actualJson + '\n');
    return { name: `fixture ${name} (written)`, ok: true };
  }
  if (!existsSync(path)) {
    return { name: `fixture ${name}`, ok: false, detail: `missing — run \`bun run doctor --update\`` };
  }
  const expected = readFileSync(path, 'utf8').trim();
  if (expected === actualJson.trim()) return { name: `fixture ${name} matches`, ok: true };

  // Show the first differing line so the failure is actionable without opening a diff tool.
  const e = expected.split('\n');
  const a = actualJson.split('\n');
  let i = 0;
  while (i < Math.max(e.length, a.length) && e[i] === a[i]) i++;
  return {
    name: `fixture ${name} matches`,
    ok: false,
    detail: `first difference at line ${i + 1}:\n      expected: ${e[i] ?? '(end of file)'}\n      actual:   ${a[i] ?? '(end of file)'}`,
  };
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update');
  const sql = adminSql();
  const checks: Check[] = [];

  // STREAMED, not accumulated. Every check used to be buffered and rendered only after the last one,
  // so a single throw mid-run discarded every result that had already succeeded — the operator got
  // one raw postgres error and no idea which of the 60-odd checks had passed before it. Printing as
  // each verdict is reached means a crash costs you the checks AFTER it, not the ones before.
  const record = (c: Check): void => {
    checks.push(c);
    renderCheck(c);
  };

  record(diffFixture('expected-definers', await snapshotDefiners(sql), update));
  record(diffFixture('expected-grants', await snapshotTableGrants(sql), update));
  record(diffFixture('expected-column-grants', await snapshotColumnGrants(sql), update));
  record(diffFixture('expected-policies', await snapshotPolicies(sql), update));
  // booleanChecks prints its own as it goes (see `add`), so collect without re-printing.
  checks.push(...(await booleanChecks(sql)));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);

  if (update) {
    console.log('\nFixtures written. REVIEW THE DIFF AS A SECURITY CHANGE before committing —\n' +
      'regenerating these to make doctor green is how a real regression ships unnoticed.');
  }
  await closePools({ timeout: 5 });
  if (failed.length > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch(async (err) => {
    console.error('doctor failed:', err);
    await closePools({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
}
