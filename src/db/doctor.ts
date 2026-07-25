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
import { config } from '../config.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
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

async function snapshotPolicies(sql: postgres.Sql) {
  return sql`
    select tablename, policyname, coalesce(roles::text, '{public}') as roles, cmd,
           coalesce(qual, '(none)') as qual, coalesce(with_check, '(none)') as with_check
    from pg_policies where schemaname = 'public'
    order by 1, 2`;
}

// ── Explicit assertions ───────────────────────────────────────────────────

async function booleanChecks(sql: postgres.Sql): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

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
    add(`${fn.name}: no PUBLIC EXECUTE in acl`, !/(^|[{,])=X\//.test(fn.acl ?? ''), fn.acl ?? '(default)');
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

  checks.push(diffFixture('expected-definers', await snapshotDefiners(sql), update));
  checks.push(diffFixture('expected-grants', await snapshotTableGrants(sql), update));
  checks.push(diffFixture('expected-column-grants', await snapshotColumnGrants(sql), update));
  checks.push(diffFixture('expected-policies', await snapshotPolicies(sql), update));
  checks.push(...(await booleanChecks(sql)));

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    if (c.ok) console.log(`  ok   ${c.name}`);
    else console.log(`  FAIL ${c.name}${c.detail ? `\n       ${c.detail}` : ''}`);
  }
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
