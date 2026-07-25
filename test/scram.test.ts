// scramMatches() is what makes `bun run migrate` genuinely re-runnable (D63).
//
// This test needs no database on purpose: the function it covers exists because the DATABASE went
// away. An unconditional `ALTER ROLE … PASSWORD` on every migrate run rewrites the SALTED verifier
// even when the password is unchanged, which invalidates Supabase's pooler credential cache; enough
// of those 28P01s trip Supavisor's circuit breaker and it stops accepting connections on EVERY
// lane — app, auth and admin. Four migrate runs in one afternoon was enough to do it.
//
// KNOWN LIMITATION, stated rather than papered over: makeVerifier() below composes the same
// primitives in the same order as scramMatches(), so a SHARED misreading of RFC 5802 would pass
// green. That is mitigated three ways and one of them is not offline:
//   1. The `pbkdf2 known-answer` test pins PBKDF2-HMAC-SHA256 against a published vector, which
//      catches the likeliest composition errors (wrong dkLen, wrong digest).
//   2. The failure is FAIL-SAFE by construction. If the derivation is wrong, scramMatches can only
//      ever return FALSE against a real Postgres verifier — it cannot accidentally return true, since
//      that would require a wrong derivation to collide with the right one. A wrong answer therefore
//      re-sets the password (the old behaviour), it never skips a needed change.
//   3. The only fully independent check is against a verifier Postgres itself wrote, which needs a
//      live database — test/m2-auth.test.ts carries it as a live assertion.
import { describe, it, expect } from 'bun:test';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { scramMatches } from '../src/db/migrate.ts';

/** Build a Postgres SCRAM-SHA-256 verifier exactly as the server stores it. */
function makeVerifier(password: string, iterations = 4096, salt = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

describe('scramMatches', () => {
  it('pbkdf2 known-answer: the primitive underneath is PBKDF2-HMAC-SHA256 at dkLen 32', () => {
    // Published vector (P="password", S="salt", c=1, dkLen=32). Pinning it here means a change to
    // the digest or the derived-key length — the two parameters a reader is most likely to get
    // wrong, and the two that would make every comparison silently fail — is caught offline.
    expect(pbkdf2Sync('password', Buffer.from('salt'), 1, 32, 'sha256').toString('hex'))
      .toBe('120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
  });

  it('accepts the password the verifier was built from', () => {
    expect(scramMatches(makeVerifier('correct horse battery staple'), 'correct horse battery staple')).toBe(true);
  });

  it('rejects a different password', () => {
    const v = makeVerifier('the-real-one');
    expect(scramMatches(v, 'the-real-one!')).toBe(false);
    expect(scramMatches(v, '')).toBe(false);
    expect(scramMatches(v, 'The-Real-One')).toBe(false);
  });

  it('is TRUE across two independently salted verifiers for the same password — the whole point', () => {
    // Two verifiers for one password are byte-different (fresh random salt each time). Comparing the
    // verifier STRINGS would therefore report "changed" on every run, which is precisely the bug:
    // migrate would keep rewriting a password that was already correct.
    const a = makeVerifier('same-password');
    const b = makeVerifier('same-password');
    expect(a).not.toBe(b);
    expect(scramMatches(a, 'same-password')).toBe(true);
    expect(scramMatches(b, 'same-password')).toBe(true);
  });

  it('honours the iteration count stored in the verifier, not a hardcoded one', () => {
    // Supabase and vanilla Postgres can ship different password_encryption iteration defaults, and
    // 4096 is only the current common value. Deriving with the wrong count yields a false NEGATIVE,
    // which fails safe (it re-sets the password) but reintroduces the churn.
    const v = makeVerifier('iters-matter', 8192);
    expect(scramMatches(v, 'iters-matter')).toBe(true);
  });

  it('returns null — "do not know", so the caller sets the password — on a shape it cannot parse', () => {
    // null is NOT false: false means "wrong password, rewrite it", null means "cannot verify". Both
    // lead to an ALTER, but only null must never be reported as a mismatch.
    for (const bad of [
      'md5abc123',                                   // legacy md5 verifier
      '',                                            // no password set
      'SCRAM-SHA-256$notanumber:c2FsdA==$a:b',       // non-numeric iterations
      'SCRAM-SHA-256$4096:$a:b',                     // empty salt
      'SCRAM-SHA-256$0:c2FsdA==$a:b',                // zero iterations
      'SCRAM-SHA-1$4096:c2FsdA==$a:b',               // wrong mechanism
    ]) {
      expect(scramMatches(bad, 'anything')).toBeNull();
    }
  });

  it('does not throw on a well-shaped verifier with undecodable key material', () => {
    // Defensive: a truncated StoredKey must be a boolean/null verdict, never an exception that
    // aborts a migration midway.
    expect(() => scramMatches('SCRAM-SHA-256$4096:c2FsdA==$!!!:!!!', 'x')).not.toThrow();
  });
});
