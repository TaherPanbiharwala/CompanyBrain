# Migrations

`../schema.sql` is the **immutable baseline** and is applied first. Every schema change *after* the
baseline has shipped goes here as a new file — never by editing an already-applied file (the runner
checksums applied files and fails loudly on drift).

## Conventions

- **Filenames are zero-padded and ordered:** `0002_add_x.sql`, `0003_add_y.sql`. The runner sorts
  numeric-aware, but zero-pad anyway for readability.
- **One transaction per file** by default; the file is recorded atomically with its checksum.
- **Non-transactional DDL** (e.g. `CREATE INDEX CONCURRENTLY` on a populated table) must start with
  the pragma `-- migrate:no-transaction` on its own line, and must be individually idempotent
  (it can't be rolled back as a unit). Do not put a bare `BEGIN;`/`COMMIT;` in a file.
- **Forward-only.** There are no down migrations; the rollback path is Supabase PITR / backups
  (confirm they're enabled on the project). See DECISIONS "Migration conventions".
- **Adding a NOT NULL column to a populated table:** expand → backfill → contract (add nullable or
  with a default, backfill in batches, then `SET NOT NULL`) — never one unbatched `UPDATE`.
- **New tables:** ship their RLS `ENABLE` + `CREATE POLICY` in the same file. Supabase's automatic-RLS
  trigger enables RLS with no policy (default-deny for `cb_app`); a table without its policy will
  silently return empty.
