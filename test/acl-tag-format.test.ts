// The grant-tag rule, and the vacuity control for doctor's acl-tag census.
//
// doctor's malformed/unmintable checks are DRIFT detectors: on an empty corpus they are vacuous by
// necessity, and doctor has to stay green immediately after `bun run migrate` on a fresh database. So
// the "can this rule actually reject anything?" half lives here, offline, where it does not depend on
// what happens to be in the database.
//
// The rule exists in THREE places and only one of them is on the write path:
//   * GRANT_TAG_RE            — src/core/context.ts, checked by buildContext on every request
//   * acl_grants_tag_ck       — migration 0007, on acl_grants: a table with ZERO readers and writers
//   * the acl census          — src/db/doctor.ts, over pages/content_chunks/page_sources/quarantine
// There is no way to import a TypeScript constant into SQL, so the copies are pinned by this test.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRANT_TAG_RE, resolveGrants, selfGrant, wsGrant } from '../src/core/context.ts';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const SQL_PATTERN = String.raw`^(self|ws|team|role):[A-Za-z0-9_-]+$`;

/** A tag no keyring can ever contain. Well-formed, and therefore invisible to every other guard. */
const isUnmintable = (tag: string): boolean => /^(team|role):/.test(tag);

describe('the grant-tag rule is one rule, in three places', () => {
  it('migration 0007 and doctor carry the SAME pattern as GRANT_TAG_RE', () => {
    // Source-compared rather than behaviour-compared: two regexes can agree on every case anyone
    // thought to test and still differ. The literal is the contract.
    expect(GRANT_TAG_RE.source).toBe(SQL_PATTERN);

    const migration = readFileSync(join(ROOT, 'src/db/migrations/0007_acl_rls.sql'), 'utf8');
    expect(migration, 'acl_grants_tag_ck no longer matches GRANT_TAG_RE — the DB and the app now ' +
      'disagree about what a grant tag is').toContain(SQL_PATTERN);

    const doctor = readFileSync(join(ROOT, 'src/db/doctor.ts'), 'utf8');
    expect(doctor, "doctor's acl census no longer matches GRANT_TAG_RE, so it would report rows as " +
      'malformed that buildContext accepts, or miss ones it rejects').toContain(SQL_PATTERN);
  });

  it('classifies every shape the census counts', () => {
    const P = '22222222-2222-4222-8222-222222222222';
    const W = '11111111-1111-4111-8111-111111111111';
    const cases: [tag: string, wellFormed: boolean, unmintable: boolean][] = [
      [selfGrant(P), true, false],
      [wsGrant(W), true, false],
      // WELL-FORMED and UNMINTABLE — the pair doctor's third check exists for. Nothing else in the
      // system objects to these: GRANT_TAG_RE accepts them, acl_grants_tag_ck accepts them, and the
      // acl-nonempty CHECK accepts them. They simply can never overlap a keyring.
      ['team:abc', true, true],
      ['team:platform-eng', true, true],
      ['role:admin', true, true],
      // Malformed: an unknown prefix, an empty suffix, a smuggled separator, and nothing at all.
      ['bad:x', false, false],
      ['self:', false, false],
      ['self:a,b', false, false],
      ['', false, false],
      ['ws:has space', false, false],
    ];
    for (const [tag, wellFormed, unmintable] of cases) {
      expect(GRANT_TAG_RE.test(tag), `GRANT_TAG_RE misjudged ${JSON.stringify(tag)}`).toBe(wellFormed);
      expect(isUnmintable(tag) && wellFormed, `unmintable misjudged ${JSON.stringify(tag)}`).toBe(unmintable);
    }
  });

  it('a keyring built today contains only self: and ws: tags', () => {
    // Necessary, but NOT sufficient as a forward guard — see the source scan below for why.
    const grants = resolveGrants('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');
    expect(grants).toHaveLength(2);
    expect(grants.every((g) => GRANT_TAG_RE.test(g))).toBe(true);
    expect(grants.filter((g) => isUnmintable(g))).toEqual([]);
    expect(grants.map((g) => g.split(':')[0]).sort()).toEqual(['self', 'ws']);
  });

  it('THE FORWARD GUARD: no call site passes resolveGrants a third argument', () => {
    // The behavioural assertion above CANNOT carry this property, and the first version of this test
    // assumed it could. `resolveGrants(principal, workspaceId, extra: readonly Grant[] = [])` takes
    // `extra` as an OPTIONAL third parameter, so a two-argument call in a test returns two tags
    // forever, no matter what any OTHER call site starts passing. On the day team scope ships, that
    // assertion would stay green while doctor's unmintable check began reporting every legitimately
    // team-scoped row as broken — with nothing having gone red first.
    //
    // What actually changes on that day is a CALL SITE, so that is what this scans. This is the
    // coupling doctor's unmintable check depends on: a team:/role: tag is well-formed, invisible to
    // every other guard, and unrepairable through the app once written.
    const offenders: string[] = [];
    let callSites = 0;

    for (const rel of new Bun.Glob('{src,scripts}/**/*.ts').scanSync(ROOT)) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      for (let at = src.indexOf('resolveGrants('); at !== -1; at = src.indexOf('resolveGrants(', at + 1)) {
        // Skip the declaration itself — its signature is the thing being guarded against.
        if (/(?:function|const|let|var)\s+$/.test(src.slice(Math.max(0, at - 24), at))) continue;
        callSites += 1;
        // Paren-balanced, not a regex: an argument can itself contain parens, brackets or braces.
        let depth = 0;
        let commas = 0;
        for (let i = at + 'resolveGrants'.length; i < src.length; i++) {
          const c = src[i];
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) break;
          } else if (c === ',' && depth === 1) commas++;
        }
        if (commas > 1) offenders.push(`${rel} (${commas + 1} args)`);
      }
    }

    // Anti-vacuity floor: `offenders` is empty both when every call site passes two arguments AND
    // when the scanner has gone blind. Those must not look alike (live-gate.test.ts learned this).
    expect(callSites, `the resolveGrants scanner found only ${callSites} call sites — it has gone blind`)
      .toBeGreaterThanOrEqual(8);
    expect(
      offenders,
      `these call sites pass resolveGrants a third argument, so a keyring can now carry team:/role: ` +
        `tags: ${offenders.join(', ')}. Team scope is shipping — extend doctor's unmintable check ` +
        `(src/db/doctor.ts) in THIS change, or it will start reporting live rows as broken.`,
    ).toEqual([]);
  });
});
