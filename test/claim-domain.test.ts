// claimDomain — the domain-squat guard, unit-tested.
//
// It is a pure function, but until the M2 review its only coverage was two HTTP cases in the live
// suite, which meant all three of its arms vanished whenever the live gate was off. The arm that had
// NO coverage at all was the public-domain rejection — and that is the one whose failure is
// permanent: workspaces.domain is UNIQUE, so one bad claim of gmail.com would hand a single account
// every future Gmail login, forever.
import { describe, it, expect } from 'bun:test';
import { claimDomain } from '../src/auth/workspaces.ts';

describe('claimDomain', () => {
  it('no domain requested ⇒ null, whatever the verified hd says', () => {
    for (const d of [null, undefined, '']) {
      expect(claimDomain(d, 'acme.com')).toBeNull();
      expect(claimDomain(d, null)).toBeNull();
    }
  });

  it('a domain claim with NO verified hd is refused — this is the dev-login and consumer-Google case', () => {
    for (const hd of [null, undefined, '']) {
      expect(() => claimDomain('bigco.com', hd)).toThrow(/did not verify/i);
    }
  });

  it('a domain that does not match the verified hd is refused', () => {
    expect(() => claimDomain('theirs.com', 'mine.com')).toThrow(/does not match/i);
    // Near-misses must not squeak through.
    expect(() => claimDomain('bigco.com.evil.test', 'bigco.com')).toThrow();
    expect(() => claimDomain('sub.bigco.com', 'bigco.com')).toThrow();
  });

  it('matches case- and whitespace-insensitively, and returns the normalized form', () => {
    expect(claimDomain('  BigCo.COM ', 'bigco.com')).toBe('bigco.com');
    expect(claimDomain('bigco.com', 'BigCo.Com')).toBe('bigco.com');
  });

  it('a PUBLIC domain is refused even when the verified hd matches it EXACTLY', () => {
    // The dangerous case: a Workspace account genuinely provisioned on a consumer domain, or a
    // spoofed hd equal to gmail.com. Matching hd is necessary but not sufficient.
    for (const d of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com']) {
      expect(() => claimDomain(d, d)).toThrow(/public email domain/i);
    }
  });

  it('rejects with domain_not_verified in every failing case — one code, no oracle', async () => {
    const { OperationError } = await import('../src/api/errors.ts');
    const failures = [
      () => claimDomain('bigco.com', null),
      () => claimDomain('theirs.com', 'mine.com'),
      () => claimDomain('gmail.com', 'gmail.com'),
    ];
    for (const f of failures) {
      try {
        f();
        throw new Error('expected a throw');
      } catch (e) {
        expect(e).toBeInstanceOf(OperationError);
        expect((e as InstanceType<typeof OperationError>).code).toBe('domain_not_verified');
      }
    }
  });
});
