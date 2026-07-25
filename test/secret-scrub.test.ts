// `bun run migrate` must never print a database password, including when it fails.
//
// The leak is subtle enough to be worth spelling out. The password is passed as a BIND PARAMETER into
// a session GUC, so it never appears in the SQL we send — that much was already right. But the DO
// block then does `format('%L', current_setting(...))`, which expands the literal server-side before
// EXECUTE, and PostgreSQL reports a failing EXECUTE with the FULLY EXPANDED statement in its CONTEXT
// and INTERNAL QUERY fields. postgres.js copies those onto the error as enumerable own properties, so
// the top-level `console.error('migration failed:', err)` prints them.
import { describe, it, expect } from 'bun:test';
import { runWithSecret } from '../src/db/migrate.ts';

const SECRET = 'hunter2-the-real-cb-app-password';

/** The shape postgres.js produces: PostgresError does Object.assign(this, parsedFields). */
function fakePgError(): Error & Record<string, unknown> {
  const err = new Error('permission denied to create role') as Error & Record<string, unknown>;
  err.name = 'PostgresError';
  err.code = '42501';
  err.where = `SQL statement "alter role cb_app login password '${SECRET}'"\nPL/pgSQL function inline_code_block line 5 at EXECUTE`;
  err.internal_query = `alter role cb_app login password '${SECRET}'`;
  err.query = `do $$ ... $$;`;
  return err;
}

/** Minimal stand-in for postgres.Sql — only `unsafe` is exercised, and it always throws. */
function throwingSql(err: Error) {
  return { unsafe: async () => { throw err; } } as unknown as Parameters<typeof runWithSecret>[0];
}

describe('runWithSecret', () => {
  it('strips the password from every field postgres.js exposes', async () => {
    const err = fakePgError();
    let caught: (Error & Record<string, unknown>) | null = null;
    try {
      await runWithSecret(throwingSql(err), 'do $$ ... $$;', 'cb_app role DDL');
    } catch (e) {
      caught = e as Error & Record<string, unknown>;
    }
    expect(caught).not.toBeNull();

    // The whole serialized error — which is what console.error prints — must not contain it.
    const serialized = [caught!.message, ...Object.values(caught!).map(String)].join('\n');
    expect(serialized).not.toContain(SECRET);

    // …and it must still be diagnosable: the cause and the code survive.
    expect(caught!.message).toBe('permission denied to create role');
    expect(caught!.code).toBe('42501');
    expect(String(caught!.where)).toContain('redacted');
    expect(String(caught!.where)).toContain('cb_app role DDL'); // says WHICH statement
  });

  it('the unredacted error would have leaked it — the fixture is not strawman', async () => {
    // Guards against the test passing because the fixture never contained the secret.
    const raw = fakePgError();
    const serialized = [raw.message, ...Object.values(raw).map(String)].join('\n');
    expect(serialized).toContain(SECRET);
  });

  it('passes a successful statement through untouched', async () => {
    const sql = { unsafe: async () => undefined } as unknown as Parameters<typeof runWithSecret>[0];
    await expect(runWithSecret(sql, 'select 1', 'noop')).resolves.toBeUndefined();
  });
});
