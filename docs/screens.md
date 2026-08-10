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

Primary: redeem, on an explicit click — **never automatically**. (This line used to say "redeem,
automatically", which was the pre-D98.7 behaviour and contradicted this file's own state table below;
`AcceptInvite.tsx:109` sets a `confirm` status and the accept fires only from the button at `:200-206`.)
The token arrives in the URL **fragment**, which never reaches a
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
| Duplicate upload | yes | `already_exists` → explain, and name the two ways out (different slug, or replace). **NOT "open the existing page"**: `PageList` rows are not *navigable* — they carry selection checkboxes but no link — and no page-detail screen exists, so that treatment had nowhere to go. Revisit when a detail view lands — `get_page` already returns the document |
| Rate limited | yes | Countdown from `retry-after` |
| Permission denied | **no** on ask/search — RLS filters silently. **yes** on `delete_page`/`replace_page` | — |
| Stale/revoked citation | **not in Phase 1** — within one response `answer.ts` resolves `cited` server-side, so a citation cannot dangle. Real once conversations persist | Struck-through chip, identical for deleted and access-revoked, or it becomes an oracle |

## Invite (admin only) — `/`, the "Invite" tab

Shipped in M5a; `web/src/components/Invite.tsx`, rendered as a Home tab.

**Hidden entirely from members rather than shown and 403'd.** The op is admin-only, so rendering a
control that always fails would be a worse lie than not rendering it.

| State | Reachable | Treatment |
|---|---|---|
| Default | yes | Leads with the **domain auto-join** note. Most admins would otherwise send links one at a time forever, not knowing that anyone with a verified Google account at a claimed domain already joins on first login (`workspaces.ts:153-170`) |
| Invite created | yes | The one-time link with a copy button and an explicit **shown once** warning. The token is stored only as a hash, so this really is the only time it exists |
| `insufficient_role` | **no** — the tab is not rendered for members | — |

### Accept invite — `/invites/accept#token=…`

| State | Reachable | Treatment |
|---|---|---|
| Not signed in | yes, and it is the NORMAL case | Stash the fragment token in `sessionStorage` **before** redirecting to Google; a fragment does not survive that navigation and the token is single-use |
| Signed in, token held | yes | **Confirm step — "Join this workspace? / Not now".** Never automatic: accepting sets `active_workspace_id`, so a zero-click accept let a link move a signed-in user's active tenant and send their next upload into someone else's workspace |
| Joined | yes | Confirms, and offers **Switch back to {previous}** via `/auth/workspaces/:id/activate`. Without it an unintended accept was recoverable only by signing out |
| Missing/expired/used token | yes | One message for all three. Distinguishing them turns the screen into an oracle for whether a token is live |

The inviting workspace's **name is deliberately not shown before acceptance** — reading an invite
before redeeming it would let anyone probe a token and learn whether it is valid and whose it is. The
copy says what accepting *does* instead.

## Pages — the batch-management bar

Landed in `07aee51`, after this inventory was last revised, and undocumented here until 2026-08-10.
Rows in `PageList` carry a selection checkbox (`PageList.tsx:23-25`) feeding a batch bar with three
actions — delete, make private, share with workspace (`:95-134`) — backed by `delete_page`'s
`pageIds` arm and `rescope_pages`. Before it existed the app had **no delete affordance at all**
(recovering from a bad upload meant one `curl` per page) and scope was fixed at ingest forever.

| State | Reachable | Treatment |
|---|---|---|
| Nothing selected | yes | Bar hidden; rows are plain |
| Selection active | yes | Bar names the count and the three actions |
| Delete confirm | yes | A `confirm()` at `PageList.tsx:61`. Irreversible, no trash, and the stored original file is the last copy — the confirm is the cheapest thing between a misclick and unrecoverable loss |
| Partial success | yes | *"N pages were left alone"* (`:137-150`). Deliberate: 3 pages you did not author must not stop the other 247, and a generic error would send the user back to retry the whole batch |

Note the upload scope picker still tells users their choice "cannot be changed later"
(`Upload.tsx:275-277`). That was true when written and this surface made it false — see
[`docs/m5b.md`](m5b.md) §3.1.

## Page detail — not built, and `get_page` is why it is now cheap

`get_page` (M5a) returns a page's full text by id or slug, bounded and with a `truncated` flag. It is
**agent-facing only today**: nothing in `web/` calls it, and `PageList` rows are not navigable.

That leaves one gap open that the op's own rationale names — *a UI could show that a document existed
and never show the document*. The backend work is done; what remains is a route, a screen, and making
the list rows clickable. Fold it into M5b alongside members and teams.

| State | Treatment when built |
|---|---|
| Loaded | Full text, scope badge, chunk count, and the `truncated` notice when the read hit its bound |
| `not_found` | Same message for "no such page" and "you cannot see it" — distinguishing them makes the screen an existence oracle, exactly as migration 0007's two partial indexes exist to prevent |
| `chunkCount: 0` | Already flagged in `PageList`: the page exists but is unsearchable |

## Not yet designed

Scope, evidence and ranking for everything below live in [`docs/m5b.md`](m5b.md); note the backend
halves of two of them are already shipped (`list_members` and `get_page` are registered ops with no
web caller), which this section used to imply otherwise.

Members, teams and the operator surface land in M5b. They are **two audiences, not
one**: a tenant admin manages their workspace; a fleet operator reads `doctor`. `doctor` connects
with owner database credentials, so its output cannot sit behind a workspace-admin route — a
customer's office manager is not the SRE. That is what the "two visual systems" amendment means in
practice, and the split has to exist before either is built.
