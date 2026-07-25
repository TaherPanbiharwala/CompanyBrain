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
token in a URL **fragment** so it never reaches a server log, a Referer header, or browser history,
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
