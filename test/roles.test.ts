import { describe, it, expect } from 'bun:test';
import { hasRole, isRole } from '../src/api/roles.ts';

describe('hasRole — owner ⊃ admin ⊃ member', () => {
  it('owner satisfies every role', () => {
    expect(hasRole('owner', 'owner')).toBe(true);
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('owner', 'member')).toBe(true);
  });
  it('admin satisfies admin + member, not owner', () => {
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('admin', 'member')).toBe(true);
    expect(hasRole('admin', 'owner')).toBe(false);
  });
  it('member satisfies only member', () => {
    expect(hasRole('member', 'member')).toBe(true);
    expect(hasRole('member', 'admin')).toBe(false);
    expect(hasRole('member', 'owner')).toBe(false);
  });
  it('unknown granted role denies (fail-closed)', () => {
    expect(hasRole('superuser', 'member')).toBe(false);
    expect(hasRole('', 'member')).toBe(false);
  });
  it('Object.prototype key as a role denies without throwing (prototype-chain guard)', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      expect(hasRole(k, 'member')).toBe(false);
      expect(hasRole(k, 'admin')).toBe(false);
    }
  });
});

describe('isRole', () => {
  it('recognizes the three roles only', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('admin')).toBe(true);
    expect(isRole('member')).toBe(true);
    expect(isRole('root')).toBe(false);
  });
});
