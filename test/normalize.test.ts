// email_normalized is the invite-matching key AND a UNIQUE column, so these cases decide both
// "does the right person match this invite" and "can two people collide into one row".
import { describe, it, expect } from 'bun:test';
import { normalizeEmail } from '../src/auth/normalize.ts';
import { isPublicDomain, PUBLIC_EMAIL_DOMAINS } from '../src/auth/blocklist.ts';

describe('normalizeEmail — Gmail', () => {
  it('lowercases and strips dots', () => {
    expect(normalizeEmail('John.Doe@Gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmail('j.o.h.n@gmail.com')).toBe('john@gmail.com');
  });
  it('cuts everything from the first plus', () => {
    expect(normalizeEmail('johndoe+@gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmail('john+foo+bar@gmail.com')).toBe('john@gmail.com');
  });
  it('folds googlemail.com to gmail.com so one human is one row', () => {
    expect(normalizeEmail('x+y@googlemail.com')).toBe('x@gmail.com');
    // The alias fold must happen BEFORE dot stripping, or these two would not converge.
    expect(normalizeEmail('j.doe@googlemail.com')).toBe(normalizeEmail('jdoe@gmail.com'));
  });
});

describe('normalizeEmail — every other domain', () => {
  it('lowercases but preserves dots and plus (they are real mailboxes elsewhere)', () => {
    expect(normalizeEmail('John.Doe@acme.com')).toBe('john.doe@acme.com');
    expect(normalizeEmail('a.b+c@acme.com')).toBe('a.b+c@acme.com');
  });
  it('lowercases the domain for everyone', () => {
    expect(normalizeEmail('user@CORP.COM')).toBe('user@corp.com');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@corp.com  ')).toBe('user@corp.com');
  });
  it('two different humans at different domains never collide', () => {
    expect(normalizeEmail('foo@a.com')).not.toBe(normalizeEmail('foo@b.com'));
  });
});

describe('normalizeEmail — rejects', () => {
  it('throws on input that cannot be a mailbox', () => {
    for (const bad of ['', 'nodomain', '@gmail.com', 'user@', '+@gmail.com', '.@gmail.com']) {
      expect(() => normalizeEmail(bad)).toThrow();
    }
  });
  it('output always satisfies the DB CHECK (email_normalized = lower(email_normalized))', () => {
    for (const raw of ['John.Doe@Gmail.com', 'A.B+C@ACME.COM', 'x@GoogleMail.com']) {
      const n = normalizeEmail(raw);
      expect(n).toBe(n.toLowerCase());
    }
  });
});
