# Screen inventory

The plan for M5 was organised by phase and by operation, never by screen — so it never said what the
landing surface is, whether ask and pages are one screen or two, or what a first-time user sees
before a returning one. This is that missing page. Route, primary action, and which states are
actually **reachable** on each surface.

Reachability matters more than it sounds. Enumerating "six states per surface" everywhere produces
dead code and false confidence: on `ask` there is no permission-denied state at all, because RLS
filters silently and the user simply gets a thinner answer. That is the same shape as the M4 review's
"seven guards that did not guard" — a checklist satisfied without the thing being true.

## Routes

| Route | Screen | Owner | Primary action |
|---|---|---|---|
| `/` | Sign in · Create workspace · Home | SPA | depends on session (below) |
| `/invites/accept#token=…` | Accept invite | SPA | Redeem the token |
| `/api` | Service index (JSON) | server | — |
| `/api/_ops` | Op catalog (JSON) | server | — |
| `/auth/google`, `/auth/google/callback` | OIDC | server | — |

`/` renders one of three screens rather than redirecting, because the session state is only knowable
from the server: the cookie is httpOnly, so there is nothing for the client to read. `whoami`'s
outcome IS the router.

| whoami | Screen |
|---|---|
| `200` | **Home** |
| `401 unauthenticated` | **Sign in** |
| `400 no_workspace` | **Create workspace** |

`no_workspace` is an **onboarding state, not an error**. The server is deliberate about this — a
valid session with no active workspace returns 400, not 401, because the session is fine and the
user simply has nowhere to act yet. Rendering it as a failure is the most likely way to make a first
sign-in feel broken.

## Sign in

Primary: **Continue with Google**. On a deployed instance it is the only way in — dev-login is gated
to loopback by five separate checks server-side, so the local form renders only on a loopback host.

Reachable states: idle · submitting (dev form) · error.
Not reachable: empty, permission-denied, partial.

## Create workspace

Primary: **Create workspace**. Secondary, and not a footnote: open an invite you were sent. For
everyone except the first person at a company, the invite is the normal path.

Deliberately does **not** send `domain`. Claiming a domain requires a verified Google `hd` on that
very session; dev-login has none, so attaching it to creation would 400 `domain_not_verified` on the
most common local path. Domain claiming belongs in workspace settings with the requirement explained.

Reachable: idle · submitting · error (`domain_not_verified`, `already_exists`, `rate_limited`).

## Accept invite

Primary: redeem, automatically. The token arrives in the URL **fragment**, which never reaches a
server — that is why `invites.ts` builds the link that way, keeping the token out of access logs,
proxy logs and the Referer header.

The state that matters: **recipient is not signed in yet**, which is the normal case. Reading the
fragment and then redirecting to Google drops it permanently, and the token was shown exactly once.
So it is stashed in `sessionStorage` before any redirect and re-read after, then cleared on both
success and failure — a consumed or expired token will never start working, so retrying it forever
would be worse than failing.

Reachable: working · needs-sign-in · accepted · invalid/expired/used.
All failure modes render **identically**, inheriting `invite_invalid`'s deliberate
indistinguishability from the server. A more helpful message would confirm to a stranger whether a
given invite ever existed.

## Home

Primary (Phase 1): **ask a question**. Upload is the secondary action and the empty-state primary.

Carries the **scope line**: *"Searching everything you can see: your private pages + everyone at
{Workspace}."* Permanent chrome, not a conditional banner. It replaces the "N results hidden from
you" idea, which could not be built — no endpoint returns a filtered count, and `list_pages`
documents that an empty result means "no more from here", not "the workspace is empty" — and should
not be, because a count of what you cannot see leaks the volume of private content. Stating the
boundary declaratively is always true, leaks nothing, and grows to `… + Engineering, Sales` when
teams land, with no redesign.

Derived from the real keyring (`whoami.grants`), so it cannot claim access the request context does
not carry.

### States on Home, once Phase 1 lands

| State | Reachable? | Treatment |
|---|---|---|
| Empty brain | yes | Drop zone as the primary action. Sample questions come **after** the first upload, generated from what was ingested — questions on an empty brain guarantee the first interaction is a failed search |
| Answer with citations | yes | Numbered chips → source panel |
| **Answer with zero citations** | yes | **Distinct container.** `parseAnswerJson` turns unparseable model output into the whole answer with `citations: []`, and `scrubMarkers` removes any visual trace — so confident prose with no sources would otherwise look identical to a cited answer |
| `degraded: 'keyword_only'` | yes | Banner **above** the answer: vector search unavailable, results may be incomplete |
| Upload partially extracted | yes | Inline on the page row with real numbers. A 40-page PDF where 37 pages were scans looks exactly like a clean 3-page ingest otherwise |
| Duplicate upload | yes | `already_exists` → offer to open the existing page |
| Rate limited | yes | Countdown from `retry-after` |
| Permission denied | **no** on ask/search — RLS filters silently. **yes** on `delete_page`/`replace_page` | — |
| Stale/revoked citation | **not in Phase 1** — within one response `answer.ts` resolves `cited` server-side, so a citation cannot dangle. Real once conversations persist | Struck-through chip, identical for deleted and access-revoked, or it becomes an oracle |

## Not yet designed

Admin (invites, members, teams) and the operator surface land in M5b. They are **two audiences, not
one**: a tenant admin manages their workspace; a fleet operator reads `doctor`. `doctor` connects
with owner database credentials, so its output cannot sit behind a workspace-admin route — a
customer's office manager is not the SRE. That is what the "two visual systems" amendment means in
practice, and the split has to exist before either is built.
