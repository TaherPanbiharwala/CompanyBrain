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

// isPublicDomain had ZERO test coverage until `noUnusedLocals` surfaced that this file IMPORTED it
// and never called it. It is the second layer under D11: it decides whether a workspace may claim a
// domain, and a false negative auto-joins every Gmail user on the planet into one workspace.
describe('isPublicDomain — the domain-auto-join gate (D11)', () => {
  it('blocks the consumer providers, including the ones that alias each other', () => {
    for (const d of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'icloud.com',
                     'me.com', 'proton.me', 'protonmail.com', 'yahoo.com', 'aol.com']) {
      expect(isPublicDomain(d)).toBe(true);
    }
  });

  it('allows a real company domain — the whole point of the feature', () => {
    for (const d of ['acme.com', 'anthropic.com', 'corp.co.uk']) {
      expect(isPublicDomain(d)).toBe(false);
    }
  });

  it('normalizes case and whitespace before matching, so `  GMAIL.COM ` cannot slip through', () => {
    expect(isPublicDomain('  GMAIL.COM ')).toBe(true);
    expect(isPublicDomain('GoogleMail.Com')).toBe(true);
  });

  it('every entry in the list is already lowercase and trimmed', () => {
    // The lookup lowercases the INPUT, not the set — so an entry stored as `Gmail.com` would be
    // unreachable and silently permit the domain it was added to block.
    for (const d of PUBLIC_EMAIL_DOMAINS) expect(d).toBe(d.trim().toLowerCase());
  });

  it('does NOT match on a subdomain or a lookalike suffix', () => {
    // Documents the actual contract: exact match only. Safe because the domain always arrives from a
    // verified Google `hd` claim, never from user input — if that ever changes, this test is the
    // place the assumption is written down.
    expect(isPublicDomain('mail.gmail.com')).toBe(false);
    expect(isPublicDomain('notgmail.com')).toBe(false);
  });
});
