# Auth setup (M2)

Two paths. **Local development needs no Google Cloud project** — use dev-login. The Google runbook
below is only required before the first real browser sign-in.

---

## 1. Local development (no Google Cloud)

`.env` needs the three connection strings + their passwords, a 32+ char `SESSION_SECRET`, and:

```bash
NODE_ENV=development
APP_BASE_URL=http://localhost:3000
DEV_AUTH=1
DEV_LOGIN=1
```

> `DEV_LOGIN=1` mints real sessions for any email with no verification. Five gates must ALL pass or
> **the app refuses to boot** — that is deliberate: a process that reached "listening" with this on
> in a real environment is dangerous. See "dev-login gating" below.

```bash
bun run migrate     # creates cb_app + cb_auth, applies schema + 0001, sets the grant matrix
bun run doctor      # 46 checks on the security posture — must be green before you trust anything
bun run start       # prints the exact redirect URI to register (only needed for the Google path)
```

### The three-call sequence

**dev-login alone is not enough.** On a fresh database, onboarding has no invite, no membership and
no domain to match, so you land *workspace-less* — and `/api/:op` correctly refuses to run without a
workspace. The bootstrap call is mandatory:

```bash
# 1. Mint a real session (1-hour TTL, no Google verification).
curl -s -c cookies.txt -X POST localhost:3000/auth/dev-login \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
# -> {"ok":true,"principal_id":"…","workspace_id":null,"role":null,"next":"POST /auth/workspaces"}

# 2. Create a workspace and become its owner.
curl -s -b cookies.txt -c cookies.txt -X POST localhost:3000/auth/workspaces \
  -H 'content-type: application/json' -d '{"name":"My Workspace"}'
# -> {"ok":true,"workspace_id":"…","principal_id":"…","role":"owner"}

# 3. Now the session is workspace-scoped.
curl -s -b cookies.txt -X POST localhost:3000/api/whoami \
  -H 'content-type: application/json' -d '{}'
```

### Bridging a browser session to the CLI / MCP

The ids returned above are exactly what the machine callers need:

```bash
export CB_CLI_PRINCIPAL=<principal_id>
export CB_CLI_WORKSPACE=<workspace_id>
bun run call whoami
```

There is **no `CB_CLI_ROLE` / `CB_MCP_ROLE`**. `assertMembership()` verifies the pair against
`workspace_members` and returns the authoritative role, so an env-supplied role is ignored by
design — the same D25 rule the HTTP resolver follows. A consequence worth knowing: `bun run call`
and `bun run mcp` now touch the database at startup, and fail loudly if the pair is not a real
membership.

### Purging dev principals

They are unverified identities and are easy to spot:

```sql
SELECT id, email FROM principals WHERE google_sub LIKE 'dev:%';
DELETE FROM principals WHERE google_sub LIKE 'dev:%';   -- cascades to their sessions/memberships
```

### dev-login gating (all five, or it will not boot)

| # | Gate | Why |
|---|---|---|
| 1 | `DEV_AUTH=1` | shared dev-auth switch |
| 2 | `DEV_LOGIN=1` | a session-minting route gets its own switch |
| 3 | `NODE_ENV` set **explicitly** | it defaults to `development`, so an unset value would pass |
| 4 | `NODE_ENV` ∈ {development, test} | allowlist, not a `!== production` blocklist |
| 5 | `APP_BASE_URL` explicitly set **and** loopback | its default is loopback, so it too would pass unnoticed |

Gate 2 off ⇒ the route simply does not exist (**404**, never 401 — a 401 would confirm it is there).
Any *other* gate failing while `DEV_LOGIN=1` ⇒ **boot throws**, naming every failing gate.

Gates 3 and 4 together are `isDevEnv(cfg)` in `src/config.ts`, and **the header stub
(`DEV_AUTH=1`) and the missing-secrets boot check now use the same function.** They used to test
only gate 4, which meant an unset `NODE_ENV` — the normal state in a container — satisfied them.
A deployment with `DEV_AUTH=1` carried in from a `.env` therefore started with the header-trusting
stub live *and* skipped the check for `SESSION_SECRET`/`DATABASE_AUTH_URL`/`GOOGLE_CLIENT_*`. If you
are writing a new dev-only gate, call `isDevEnv` — never `DEV_ENVS.has(cfg.NODE_ENV)` on its own.

---

## 2. Google Cloud runbook

Needed only for real browser sign-in.

1. **Create/select a project** at <https://console.cloud.google.com>.
2. **OAuth consent screen** → *External* (unless you have Google Workspace and only want internal
   users). Fill in app name, user support email, developer contact. Add scopes
   `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` — nothing else, so no
   verification review is required. While the app is in *Testing*, add yourself under **Test users**
   or sign-in will be refused.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
4. **Authorized redirect URIs** — paste the EXACT string the app prints at boot:
   ```
   [auth] register this redirect URI in Google Cloud Console: http://localhost:3000/auth/google/callback
   ```
   It must match character for character (scheme, host, port, path, no trailing slash). This is
   derived from `APP_BASE_URL`, which is the single source of truth — do not also set
   `OIDC_REDIRECT_URI` unless you intend to override it.
5. Copy the client ID and secret into `.env`:
   ```bash
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   ```
6. Changes can take a few minutes to propagate. Then visit `http://localhost:3000/auth/google`.

### Production

`APP_BASE_URL` must be **https** — that one value flips the session cookie to `Secure` and the
`__Host-` name prefix together. Add the production callback as a second authorized redirect URI, set
`TRUST_PROXY` if you are behind a proxy, and make sure `DEV_AUTH`/`DEV_LOGIN` are unset.

---

## 3. Troubleshooting

**Every lane suddenly refuses connections: `08006 econnrefused`, then `XX000 (ECIRCUITBREAKER) too
many authentication failures, new connections are temporarily blocked`** — Supabase's pooler
(Supavisor) has tripped a circuit breaker for the whole project, so `cb_app`, `cb_auth` **and**
`postgres` all fail at once even though nothing about your code changed. The tell that it is the
breaker and not your credentials: the error comes back from the pooler in Elixir tuple form
(`{:error, :econnrefused}`), meaning TLS and the pooler handshake succeeded and the pooler itself
could not reach the database.

It is preceded by a scatter of `28P01 Authentication credentials are invalid. Please reconnect with
fresh credentials to restore pool functionality` — **these are the leading indicator, not transient
network noise.** If you see two or three of them, stop and find the cause rather than retrying.

The cause we hit was `bun run migrate`: it used to issue `ALTER ROLE … PASSWORD` on every run, and a
SCRAM verifier is salted with fresh randomness, so re-setting the *same* password still writes a
*different* verifier and invalidates the pooler's cached credentials. Four runs in an afternoon was
enough to trip the breaker (DECISIONS D63). `migrate` now verifies the stored verifier first and
skips the `ALTER` when the password already matches — you should see
`= cb_app password already matches CB_APP_DB_PASSWORD; not re-setting it`.

**First, tell the two failure modes apart — they need opposite responses.** Both surface as `08006`,
and only one resolves by waiting:

```bash
nc -z -G 8 aws-1-<region>.pooler.supabase.com 5432 && nc -z -G 8 aws-1-<region>.pooler.supabase.com 6543
```

* **Ports CLOSED** — the pooler itself is unreachable. Network or a Supabase platform incident.
* **Ports OPEN, and the error is `{:error, :econnrefused}`** — that tuple is Supavisor's own Elixir
  error, so the pooler is healthy and cannot reach the **Postgres instance behind it**. That is a
  paused, stopped or restarting project. **Waiting will not fix it** — open the Supabase dashboard
  and restore/restart the project.
* **Ports OPEN, and the error names authentication** (`ECIRCUITBREAKER … too many authentication
  failures`, or a run of `28P01`) — that is the breaker, and it does reset on its own after several
  minutes. There is no client-side override, and retrying in a tight loop only feeds it.

While you are blocked either way, the offline suites still run in under a second:

```bash
bun test --env-file=<a copy of .env with the three DATABASE_* lines removed>
```

That skips every `describe.skipIf(!live)` suite cleanly instead of letting them fail on connect.

If it was *not* migrate, the other way to generate real auth failures is a password mismatch between
the role and its URL. Check without printing secrets:

```bash
bun -e "const p=u=>decodeURIComponent(new URL(u).password); console.log('app', p(process.env.DATABASE_URL)===process.env.CB_APP_DB_PASSWORD, '| auth', p(process.env.DATABASE_AUTH_URL)===process.env.CB_AUTH_DB_PASSWORD)"
```

`decodeURIComponent` is load-bearing: `new URL(u).password` returns the PERCENT-ENCODED field, so a
password containing `@`, `:`, `/` or `#` (all of which must be encoded to appear in a URL at all)
would compare unequal to the raw env value and report a mismatch that does not exist.

Both must print `true` — `migrate` sets each role's password from the `CB_*_DB_PASSWORD` variable,
so if either disagrees with the password embedded in its URL, every connection on that lane fails
authentication and the breaker is only a matter of time.

**`redirect_uri_mismatch`** — the string in Google Cloud does not match what the app sends. Compare
it against the exact line printed at boot. Most often a trailing slash, `http` vs `https`, or a port.

**Login appears to work, but the next request is 401 (Safari especially)** — the session cookie is
being dropped. `__Host-` requires `Secure` + `Path=/` + no `Domain`, and Safari refuses `Secure`
cookies over plain-HTTP localhost. Both the prefix and the `Secure` flag derive from whether
`APP_BASE_URL` is https, so they cannot disagree; if you are on `http://localhost`, the cookie is
plain `cb_session` and this should not happen. Check that `APP_BASE_URL` matches how you are
actually reaching the app.

**`400 no_workspace` forever** — you are signed in but have no workspace. That is the expected state
after a first login on a fresh database. `POST /auth/workspaces` (see the sequence above).

**`409 account_conflict`** — this email already belongs to a *different* Google account. It happens
when a placeholder principal was created with one identity and a different one later signs in with
the same address. Inspect, then decide:

```sql
SELECT id, email, google_sub, created_at FROM principals WHERE email_normalized = 'you@example.com';
-- To let the new Google account adopt it, clear the old binding FIRST (this is destructive —
-- the old identity can no longer sign into that row):
UPDATE principals SET google_sub = NULL WHERE id = '<the-row-id>';
```

**`Pool identity mismatch: connected as "postgres" but expected "cb_auth"`** — `DATABASE_AUTH_URL`
is pointing at the wrong role (the admin and auth URLs differ by only a few characters). This check
exists because that mistake would otherwise run every pre-auth query as the RLS-*bypassing* owner
while every test still passed.

**`SESSION_SECRET must be at least 32 characters`** — only raised on the first cookie sign/verify,
so the offline unit suite still runs without it. Generate one:
```bash
bun -e "console.log(crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,''))"
```

**`bun run doctor` fails after a schema change** — read the diff before regenerating. `--update`
rewrites the fixtures, and doing that reflexively is precisely how a real privilege regression ships
unnoticed. Treat a fixture bump as a security change.

**Iterating on a migration** — applied migrations are checksum-immutable, so any edit after a
successful apply fails the next `bun run migrate`. While developing:
```bash
CB_CONFIRM_RESET=<your-supabase-project-ref> bun run migrate:reset --yes-destroy   # DESTROYS ALL DATA
bun run seed:a17     # re-create the principal + workspace, and RE-EXPORT the CB_CLI_* it prints
bun run load:a17     # reload the corpus
```
Three things worth knowing:

* `CB_CONFIRM_RESET` is the Supabase **project ref** (the `<ref>` in the `postgres.<ref>` username of
  `DATABASE_ADMIN_URL`), not the database name. Every Supabase project's database is called
  `postgres`, so confirming on the name asked you to type the same word for a scratch project and for
  the one holding your corpus.
* The reseed step is **mandatory** and is easy to miss: reset drops the schema, so the seeded
  principal is gone, and `bun run load:a17` now calls `assertMembership()` and aborts with
  "Not a member" if you reuse the old `CB_CLI_*` values.
* It prints real row counts and pauses for 5s before dropping. Ctrl-C works.

Freeze a migration once `bun run doctor` is green.

**`checksum drift` on an applied file — you almost never need to destroy anything.** Applied files
are content-hashed, so editing one (even a comment) fails the next `bun run migrate`. This has
already happened once in this repo's history: commit `3722422` edited an applied `schema.sql` and
`9c8ad3e` reverted it byte-for-byte. Two paths, and the destructive one is almost never right:

1. **The edit was a mistake** — revert it (`git checkout -- <file>`) and put the change in a new
   `src/db/migrations/NNNN_*.sql`.
2. **The edit is semantically inert** (a comment or whitespace fix) **and the database already
   matches** — re-point the ledger. Read `git diff <file>` first and satisfy yourself it changes no
   DDL, then take the exact hash the error message prints:
   ```sql
   UPDATE _migrations SET checksum = '<the sha256 from the error>' WHERE filename = '<file>';
   ```
   **Never set it to NULL.** A NULL checksum exempts that file from immutability permanently, and
   `migrate` now refuses to run rather than trust an unverified file.

`migrate:reset` is not the answer to drift. `.gitattributes` pins `*.sql` to LF so a checkout can
never manufacture drift on its own.

---

## 4. Inviting someone (M2)

`create_invite` is an admin-only operation on the normal dispatch surface. M2 sends no email — you
copy the link.

```bash
bun run call create_invite '{"email":"teammate@example.com","role":"member"}'
```

The response contains the token **exactly once** — only its SHA-256 hash is stored, so it can never
be read back. If you lose it, revoke the invite and issue a new one.

You cannot invite someone at a role above your own: an `admin` minting an `owner` invite is refused
with `insufficient_role`. That check is app-layer (the database will happily store `role='owner'`,
since `cb_app` holds table-level INSERT on `invites`), which is why it has a dedicated test.

The invitee redeems it by POSTing the token — **not** by clicking the URL. `acceptUrl` carries the
token in a URL **fragment** so it never reaches a server log or a Referer header (it IS kept in the
browser's own history — fragments always are; the guarantee is that it does not leave the machine),
and the page that reads that fragment ships with the M5 UI. Until then:

```bash
curl -s -b cookies.txt -X POST localhost:3000/auth/invites/accept \
  -H 'content-type: application/json' -d '{"token":"<the token>"}'
```

Wrong token, expired, already accepted, and addressed-to-someone-else all return the same generic
`404 invite_invalid` — telling them apart would confirm that a given invite exists.

## 5. Removing someone

M2 ships no removal endpoint (`cb_app` deliberately holds no DELETE on `workspace_members`), so
removal is an admin action. **In a workspace with a claimed domain, deleting the membership alone is
not enough** — the next Google sign-in from that domain auto-joins them straight back. Record a block
in the same transaction:

```sql
BEGIN;
DELETE FROM workspace_members WHERE workspace_id = '<ws>' AND principal_id = '<principal>';
INSERT INTO workspace_domain_blocks (workspace_id, principal_id, reason)
VALUES ('<ws>', '<principal>', 'left the company 2026-07');
COMMIT;
```

The block outlives the membership row, which is the entire point. Both `cb_app` and `cb_auth` can
only read it — a login lane able to clear its own block would not be a block.

## 6. Before you deploy anywhere that is not localhost

The app **refuses to start** rather than run in a silently-unsafe shape. Off loopback you must set:

| Setting | Why it is a hard failure, not a warning |
|---|---|
| `TRUST_PROXY` | Unset behind a proxy makes `req.ip` the *proxy's* address, collapsing the `/auth/*` limiter to ONE bucket for the whole fleet — 31 anonymous requests take sign-in offline for every user. Set `loopback`, a hop count, or `0` if nothing fronts the app. |
| `APP_BASE_URL` **https** | Plain http off loopback costs both `Secure` and the `__Host-` prefix at once, letting any sibling subdomain set a `cb_session` for the parent domain. |
| `SESSION_SECRET` (≥32), `DATABASE_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | All default to empty. Without them the process boots, `/health` reports ok, and login fails — some paths only **after** the user has already authenticated at Google. |

## 7. Running the security tests in CI

Live suites skip when the database env is absent, which is right on a laptop and wrong in CI: a
missing connection string would let the entire cross-tenant canary report green having asserted
nothing.

```bash
CB_REQUIRE_LIVE_TESTS=1 bun test
```

With that set, a live suite that *would* have skipped **fails** instead. `test/live-gate.test.ts`
additionally scans the suite files, so a live suite added later cannot quietly opt out of the flag.
