// Unit test for the migration runner's transaction-control guard (no DB). The runner wraps every
// file in one transaction, so a standalone BEGIN/COMMIT/END/ROLLBACK must be rejected — but PL/pgSQL
// constructs inside DO $$ … $$ (block begin / end $$; / end if;) must NOT be flagged.
import { describe, it, expect } from 'bun:test';
import { TXN_CONTROL, orderMigrations } from '../src/db/migrate.ts';

describe('TXN_CONTROL — rejects standalone transaction control (all PG synonyms)', () => {
  const matches = [
    'begin;',
    'BEGIN;',
    'begin transaction;',
    'BEGIN WORK;',
    'commit;',
    'COMMIT WORK;',
    'end;',
    'END;',
    'end transaction;',
    'rollback;',
    'ROLLBACK WORK;',
    'abort;',
    'start transaction;',
    'START TRANSACTION READ ONLY;',
    '   commit;  ',
  ];
  for (const s of matches) {
    it(`matches ${JSON.stringify(s)}`, () => expect(TXN_CONTROL.test(s)).toBe(true));
  }

  const nonMatches = [
    'end $$;', // dollar-quoted DO block terminator
    'end if;', // PL/pgSQL
    'end loop;', // PL/pgSQL
    'select 1;',
    'commit_log;', // identifier, not the verb
    "insert into t values ('begin;');", // verb only inside a literal, not standalone
    'create table beginner (id int);',
  ];
  for (const s of nonMatches) {
    it(`does not match ${JSON.stringify(s)}`, () => expect(TXN_CONTROL.test(s)).toBe(false));
  }
});

describe('orderMigrations — numeric-aware', () => {
  it('sorts 10_x after 2_x (not lexically)', () => {
    expect(orderMigrations(['0010_c.sql', '0002_b.sql', '0001_a.sql'])).toEqual([
      '0001_a.sql',
      '0002_b.sql',
      '0010_c.sql',
    ]);
  });
});
