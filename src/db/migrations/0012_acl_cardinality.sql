-- The four acl non-empty CHECKs have never enforced anything. Replace array_length with cardinality.
--
-- `array_length('{}'::text[], 1)` returns NULL, not 0 — an empty array has no dimension 1 — and a
-- CHECK constraint is SATISFIED when its expression is NULL. So `acl = '{}'` has passed
-- pages_acl_nonempty since the day it shipped. `cardinality('{}')` is 0, and `0 >= 1` is false.
-- Confirmed against this server (PostgreSQL 17.6) before writing this file:
--     select (array_length('{}'::text[],1) >= 1) is null;  -- t
--
-- WHY THAT MATTERS, from 0007's own comment: an empty acl overlaps nothing, so the row is
-- "permanently invisible to every principal INCLUDING its author, with no error and no application
-- path to repair it (the same policy that hides it blocks rewriting it)". The constraint exists to
-- make that state impossible; it was decorative instead. Nothing writes an empty acl today
-- (aclForScope always returns one tag), so this closes a hole nothing has walked through yet.
--
-- WHY A NEW FILE: 0007 and 0009 are applied and checksum-immutable. Forward-only, as the README says.
--
-- WHY NO -- migrate:no-transaction: every statement here is a plain ALTER TABLE. The runner wraps
-- the file in one transaction, which is what we want — if any single ADD CONSTRAINT rejects a row,
-- the whole file rolls back and _migrations records nothing. Bare DROP CONSTRAINT with no IF EXISTS,
-- per 0004's house style: a missing constraint means the database is not in the state this file
-- assumes, and that should be loud. Adding the pragma would also route this through splitStatements,
-- which has no test coverage; a transactional file never touches it.
--
-- BEFORE APPLYING: ADD CONSTRAINT validates existing rows and takes ACCESS EXCLUSIVE while it scans.
-- Run this on the OWNER connection (DATABASE_ADMIN_URL), not cb_app — `acl && current_grants()` can
-- never match an empty acl, so a scoped count returns 0 while ADD CONSTRAINT, running as table owner
-- and RLS-exempt, still sees and rejects the rows:
--
--     select 'pages' as tbl, count(*) from pages where cardinality(acl) = 0 or acl is null
--     union all select 'content_chunks', count(*) from content_chunks where cardinality(acl) = 0 or acl is null
--     union all select 'page_sources',   count(*) from page_sources   where cardinality(acl) = 0 or acl is null
--     union all select 'quarantine',     count(*) from quarantine     where cardinality(acl) = 0 or acl is null;
--
-- Verified 0/0/0/0 on 2026-07-30 before this file was written. content_chunks is the large table; on
-- the current corpus the scan is instantaneous, which will stop being true with a real one.
--
-- EXPECTED doctor FIXTURE DELTA: none. No snapshot queries pg_constraint — which is precisely how a
-- constraint that enforced nothing survived a 62-check posture verifier. doctor.ts gains a
-- pg_constraint assertion in the same change so the next drop is loud.

ALTER TABLE pages          DROP CONSTRAINT pages_acl_nonempty;
ALTER TABLE pages          ADD CONSTRAINT pages_acl_nonempty CHECK (cardinality(acl) >= 1);

ALTER TABLE content_chunks DROP CONSTRAINT chunks_acl_nonempty;
ALTER TABLE content_chunks ADD CONSTRAINT chunks_acl_nonempty CHECK (cardinality(acl) >= 1);

ALTER TABLE page_sources   DROP CONSTRAINT page_sources_acl_nonempty;
ALTER TABLE page_sources   ADD CONSTRAINT page_sources_acl_nonempty CHECK (cardinality(acl) >= 1);

ALTER TABLE quarantine     DROP CONSTRAINT quarantine_acl_nonempty;
ALTER TABLE quarantine     ADD CONSTRAINT quarantine_acl_nonempty CHECK (cardinality(acl) >= 1);
