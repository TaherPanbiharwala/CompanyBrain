# Deploying company-brain

The app runs on **Railway**. This file exists because the deployment was originally configured
entirely through the Railway dashboard, which means it lived in one place — a web UI — and could not
be reproduced, reviewed, or recovered from the repository. `railway.json` now captures the build and
run shape; the secrets stay in the dashboard, where they belong.

## What is in the repo vs. what is in the dashboard

| | Where | Why |
|---|---|---|
| Build command, start command, healthcheck, restart policy | `railway.json` | Reviewable, versioned, survives an account being lost |
| Environment variables and secrets | Railway dashboard | Secrets must never be committed |
| Database | Supabase (external) | Not managed by Railway |

**`railway.json` overrides the dashboard** for the fields it declares. If the two disagree, the file
wins on the next deploy — so the file has to be right before it is pushed.

## The build command is not optional

```
bun install --frozen-lockfile && bun run build:web
```

`bun run build:web` is the load-bearing half. `src/index.ts:101` calls `assertWebBuildPresent()`,
which **refuses to start** when `APP_BASE_URL` is not loopback and `web/dist/index.html` is missing.
Nixpacks will not run it on its own: it looks for a `build` script and this project's is named
`build:web`, so a deploy without an explicit build command boots to a crash rather than to a
half-working app. That is the correct behaviour — a server that served the API but 404'd the entire
UI would be worse — but it means the build command must be stated.

`--frozen-lockfile` makes a deploy fail rather than silently resolve a different dependency tree than
the one tested. CI pins Bun to `1.3.14` (`.github/workflows/ci.yml:35`); Railway picks its own Bun
version, so the two can drift. That drift is not currently pinned anywhere and is worth knowing about
before debugging a "works locally, fails on Railway" report.

## Environment variables the app refuses to boot without

`assertDeploymentSafe()` (`src/boot.ts:31`) runs at import time and throws rather than starting
degraded. Off loopback — which every Railway deploy is — it requires:

| Variable | Why it is fatal if missing |
|---|---|
| `TRUST_PROXY` | Railway puts a proxy in front of the app, so `req.ip` becomes the proxy's address. The `/auth/*` rate limiter is keyed on it, so without this the 30-per-5-minute budget collapses into ONE shared bucket for every user on the platform — 31 requests from one anonymous client takes sign-in offline for everybody. Set to `1` for Railway (one proxy hop), or `0` if nothing is in front. |
| `APP_BASE_URL` | Must be `https` and non-loopback. On plain http the session cookie loses both `Secure` and the `__Host-` prefix, letting any sibling subdomain set a `cb_session` for the parent domain — session fixation. |
| `SESSION_SECRET` | ≥ 32 characters. Signs and verifies sessions. |
| `DATABASE_AUTH_URL` | The login lane's connection. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Without them the app boots, `/health` reports ok, and every login fails — some only *after* the user has already authenticated at Google, which is the worst place to discover a missing variable. |

The last four are skipped when `NODE_ENV` is `development` or `test`. **`NODE_ENV` must be set
explicitly to `production` on Railway** — an unset value defaults to `development`, which skips that
whole block. `CONTEXT.md` §6.1 records this exact gate being broken and re-fixed three times.

Also required for the app to function (not boot-gated): `DATABASE_URL`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `CHAT_MODEL`. `PORT` is injected by Railway and read at `src/config.ts:5`.

## Migrations are NOT run automatically

`railway.json` declares no pre-deploy command, so a schema change does not apply itself on deploy.
Run it deliberately, against the production `DATABASE_ADMIN_URL`:

```bash
bun run migrate && bun run migrate && bun run doctor
```

Twice on purpose — `src/db/doctor.ts:9` notes the idempotency regression a single run cannot catch.
`doctor` must be green before the deploy that depends on the new schema.

This is deliberate rather than an omission. An automatic migration on every deploy means a rollback
of the code does not roll back the schema, and `migrate.ts` enforces checksum immutability
(`:655-678`), so one edited-after-apply migration file bricks every future deploy. Keeping it manual
keeps the one-way door visible.

## Single instance only

Rate limiting is an in-memory `Map` in one process (`src/auth/ratelimit.ts:20-57`), and the upload
admission gate is process-local (`src/ingest/extract/index.ts`). **Both silently stop working as
intended above one replica** — two instances means two independent counters, so the real limit
doubles, and the memory ceiling the upload gate enforces applies per instance rather than per
service. Do not raise the replica count without moving both to a shared store.

## Verifying a deploy

```bash
curl -s https://<your-app>/health
```

Expect `{"status":"ok"}`. Then confirm the UI actually built — a boot with no `web/dist` should have
crashed, but a stale one will not have:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<your-app>/
```

Expect `200` and HTML, not a JSON 404. `/health` going green while `/` 404s is the exact
silent-failure shape `assertWebBuildPresent()` exists to prevent.
