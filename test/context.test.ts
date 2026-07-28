import { describe, it, expect } from 'bun:test';
import {
  buildContext,
  ContextError,
  visibleBy,
  resolveGrants,
  serializeGrants,
  selfGrant,
  wsGrant,
  aclForScope,
  GRANT_SEPARATOR,
} from '../src/core/context.ts';

const P = crypto.randomUUID();
const W = crypto.randomUUID();
const base = { principal: P, workspaceId: W, grants: resolveGrants(P, W), remote: false };

describe('buildContext — fail closed (DECISIONS D2)', () => {
  it('happy path: role defaults to member, grants copied', () => {
    const ctx = buildContext(base);
    expect(ctx.role).toBe('member');
    expect(ctx.grants).toEqual([`self:${P}`, `ws:${W}`]);
    expect(ctx.workspaceId).toBe(W);
  });

  it('throws unauthenticated on missing principal', () => {
    expect(() => buildContext({ ...base, principal: null })).toThrow(ContextError);
    try {
      buildContext({ ...base, principal: null });
    } catch (e) {
      expect((e as ContextError).code).toBe('unauthenticated');
    }
  });

  it('throws bad_principal on non-uuid principal', () => {
    try {
      buildContext({ ...base, principal: 'not-a-uuid' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ContextError).code).toBe('bad_principal');
    }
  });

  it('throws no_workspace on missing workspaceId', () => {
    try {
      buildContext({ ...base, workspaceId: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ContextError).code).toBe('no_workspace');
    }
  });

  it('throws bad_workspace on non-uuid workspaceId', () => {
    try {
      buildContext({ ...base, workspaceId: '123' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ContextError).code).toBe('bad_workspace');
    }
  });

  it('throws no_grant on empty keyring', () => {
    try {
      buildContext({ ...base, grants: [] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ContextError).code).toBe('no_grant');
    }
  });

  it('rejects a comma-smuggled grant tag (would inject an extra grant into the CSV GUC)', () => {
    try {
      buildContext({ ...base, grants: [`ws:${W},role:admin`] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ContextError).code).toBe('bad_grant');
    }
  });

  it('rejects malformed / empty / unknown-prefix grant tags', () => {
    for (const bad of ['', '   ', 'admin', 'ws:', 'role:has space', 'evil:tag']) {
      expect(() => buildContext({ ...base, grants: [bad] })).toThrow(ContextError);
    }
  });

  it('accepts the known grant shapes', () => {
    const grants = [`self:${P}`, `ws:${W}`, `team:${crypto.randomUUID()}`, 'role:admin'];
    expect(buildContext({ ...base, grants }).grants).toEqual(grants);
  });
});

describe('visibleBy — acl && grants overlap', () => {
  it('allows on overlap', () => expect(visibleBy([`self:${P}`], [`self:${P}`, `ws:${W}`])).toBe(true));
  it('denies when no overlap', () => expect(visibleBy(['ws:other'], [`ws:${W}`, `self:${P}`])).toBe(false));
  it('denies on empty acl (fail closed)', () => expect(visibleBy([], [`ws:${W}`])).toBe(false));
  it('denies on empty grants (fail closed)', () => expect(visibleBy([`ws:${W}`], [])).toBe(false));
});

describe('grant serialization', () => {
  it('joins on the shared separator', () => {
    expect(serializeGrants([`self:${P}`, `ws:${W}`])).toBe(`self:${P}${GRANT_SEPARATOR}ws:${W}`);
  });
  it('resolveGrants builds self + ws + extras', () => {
    expect(resolveGrants(P, W, ['team:t1'])).toEqual([`self:${P}`, `ws:${W}`, 'team:t1']);
  });

  // `acl && grants` is Postgres array overlap — byte equality, not a uuid comparison. UUID_RE
  // carries /i and `bun run call` / the MCP bridge take the principal verbatim from the env, so an
  // uppercase UUID would stamp `self:A1B2…` while the read path (resolve_session -> postgres.js)
  // yields `self:a1b2…`. Those never overlap: the author's own private page would be permanently
  // unreadable by everyone, with no error anywhere.
  it('grant tags are lowercased, so an uppercase env UUID still matches the read path', () => {
    const upper = P.toUpperCase();
    expect(selfGrant(upper)).toBe(`self:${P}`);
    expect(wsGrant(W.toUpperCase())).toBe(`ws:${W}`);
    expect(resolveGrants(upper, W.toUpperCase())).toEqual([`self:${P}`, `ws:${W}`]);
    // The tag a row carries and the tag a keyring holds must be built the same way.
    expect(aclForScope('private', { principal: upper, workspaceId: W })).toEqual([`self:${P}`]);
    expect(aclForScope('workspace', { principal: P, workspaceId: W.toUpperCase() })).toEqual([`ws:${W}`]);
  });
});
