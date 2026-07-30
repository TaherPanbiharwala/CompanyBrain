# M3 handover

Written at the end of the session that built M3, for whoever picks it up next.

**Branch:** `claude/context-review-5957e4` · **Commits:** `aa8752a` (build + review), `634003a` (eval harness)
**State:** typecheck clean · 523 pass / 1 skip / 0 fail (live) · doctor 62/62 · migrations idempotent · top-8 unchanged

Read `DECISIONS.md` D66–D90 alongside this. This file explains the *session*; DECISIONS explains the
*choices* and is the thing that stays true after the code moves.

---

## 1. The goal, and what "done" meant

M3 is **the brain loop**: upload a real file → get a cited answer naming the position it came from →
be able to open that position.

Before this session the system could only ingest pasted text, its "hybrid" search was running on one
engine, and ingest was one-way (no delete, no replace, so every corpus reload died on
`already_exists`).

The founder's instruction shaped the plan more than anything else:

> "Before continuing further i need to perfect the pipeline… It has been proven in the gbrain and
> doesnt need to be proved right now. It should be able to ingest json, pdf, docs, excel sheets, etc
> and should use hybrid and rrf perfectly."

That was an explicit override of two prior reviews that wanted an eval harness built first. It was
followed. The mitigation for having no eval is `scripts/dump-top8.ts`: a committed snapshot of the
top-8 retrieval results for ten questions, captured **before** any retrieval change, so a ranking
regression shows up as a reviewable diff instead of a vibe.

---

## 2. How the session ran

Ten sequential tasks, each verified before the next started. Then a full pre-landing review. Then an
independent eval against a corpus the founder supplied.

| # | Task | Outcome |
|---|---|---|
| 1 | Capture `dump-top8` baseline | committed BEFORE touching the chunker |
| 2 | `RouterError` structure + retry | 13 tests |
| 3 | Extraction layer in a subprocess | 6 modules, 23 tests |
| 4 | Sanity gate | pure, no DB |
| 5 | Block chunker | added alongside `chunkText`, not replacing it |
| 6 | Migration 0009 + `page_sources` + `quarantine` | doctor 58/58, +8 leak-canary cases |
| 7 | `list_pages` / `delete_page` / `replace_page` | 19 tests |
| 8 | Four-arm hybrid search | measured at every step |
| 9 | Batched embedding + degrade + seams | found a live bug in `router.embed` |
| 10 | `pack.ts`, `search` op, locators, `ingest_file` | both plan gates verified live |

**Three review rounds.** `/autoplan` ×4 on the plan (before code). The NovaByte eval (mid-session).
`/review` with seven specialists (after code). Codex was unreachable in **all** of them
(`refresh_token_invalidated`) — so every finding in this session is single-model. `codex login`
restores cross-model coverage and is worth doing before the next review.

---

## 3. Files — what, and why

### New: extraction (`src/ingest/extract/`)

| File | Why it exists |
|---|---|
| `detect.ts` | Format from **magic bytes in the parent process**. An extension is attacker-supplied over HTTP; a PDF named `.txt` chunked as prose embeds binary noise at real cost. Detecting in the parent lets `unsupported_format` return without spawning. |
| `index.ts` | Orchestration + the security boundary. Drains stdout/stderr **before** awaiting exit (the pipe buffer is 64 KB; awaiting first deadlocks and looks like a timeout). Caps output, bounds the wait queue, kills the child before releasing its slot. |
| `worker.ts` | Rebinds `console.*` to stderr as its **first statement**, then frames its payload `CBX1\n<len>\n<json>`. Without both, a dependency's stray log makes a perfectly good file fail to parse, indistinguishable from a truncated write. |
| `html.ts` | ONE html→Block converter, shared with docx (mammoth already emits HTML). `div` is deliberately absent from the block regex — including it swallowed wrapper divs and lost every child. |
| `pdf.ts` | unpdf; one block per page; pages under a char floor counted as **skipped**, so a 40-page PDF that is 37 scans is not indistinguishable from a clean 3-page ingest. |
| `xlsx.ts` | Where the silent-corruption classes live — see below. |
| `docx.ts`, `text.ts` | mammoth → shared converter; plain/CSV/JSON. `text.ts` deliberately has **no speaker detection** (`Name:` also matches `Note:`, `TODO:`, `10:30:`, and would silently re-chunk an existing fixture). |

**The xlsx cases are worth understanding** — each is a way a spreadsheet lies quietly:
- Merged cells: SheetJS stores a merged value only top-left, so a header merged across A1:C1 reads
  `Line items | | |` and the columns below lose their names. Expanded before header detection.
- Dates: without `cellDates` a date is the serial `45123`, so "the invoice dated 12 March 2026"
  never matches — forever, with no error. Both forms emitted.
- Formulas with no cached value: SheetJS has no formula engine. Emitting blank would report success
  on lost data; counted as skipped instead.
- Header row **detected**, not assumed to be row 0. Guessing wrong repeats a title into 500 chunks
  and makes every embedding near-identical.

### New: the ingest waist

- **`blocks.ts`** — the `Block` / `Locator` contract. Locators are **spans**, not points: with
  overlap a chunk routinely covers pages 7–8, which `{page: 7}` cannot express.
- **`sanity.ts`** — pure, so it is trivially testable. Counts **code points**, not UTF-16 units;
  a unit-based ratio classifies good Hindi as binary, which for an India-first product is rejecting
  the target market's documents.
- **`embed.ts`** — batching. Results are written to **preallocated absolute offsets**, never pushed,
  because batches finish out of order. Writing this test found a live bug in `router.embed`: it
  sorted by provider index, which *hides* a duplicated index; assigning leaves a detectable hole.
- **`file.ts`** — the file waist. Takes **bytes**, never a path (see D83). Refuses duplicates
  *before* embedding, with a predicate that mirrors the partial indexes exactly (see D89).
- **`lifecycle.ts`** — list/delete/replace. Addresses by **page ID** because D68 made slugs
  non-unique within a workspace.
- **`pack.ts`** — the generic pack as data, plus an extraction-prompt template with an unused
  **vocabulary slot**, reserved now because retrofitting it later invalidates every stored extraction.

### New: migrations

- **`0007_acl_rls.sql`** — the milestone's headline. `acl && current_grants()` becomes the enforced
  predicate. Defines `current_grants()` **in-file**, because `ensureAuthFunctions` runs *after* the
  migration loop and a policy referencing a function that does not exist yet fails 42883.
- **`0009_multiformat.sql`** — locators, source columns, `page_sources`, `quarantine`.
- **`0011_search_indexes.sql`** — review follow-up. Drops the dead btree, adds the GIN index the
  title arm actually needs, plus two missing read-path indexes. Uses `-- migrate:no-transaction`,
  and **was the first file ever to do so** — which is how D88 was found.
- **`0008` / `0010` `.disabled`** — down paths that are deliberately *asymmetric*. 0010 drops the
  indexes and CHECK (things that can block a legitimate ingest) and drops **nothing that holds
  data**, because `page_sources.bytes` is the only copy of every uploaded file.

### Changed: the notable ones

| File | Change and why |
|---|---|
| `search/hybrid.ts` | Rewritten. Four arms, weighted RRF, per-page cap, duplicate collapse, cosine blend. The `LIMIT` moved **below** the joins — above them, a row the joins discard had already consumed a result slot. |
| `search/rrf.ts` | `rrfFuseWeighted` added; `rrfFuse` becomes the all-weights-1 case, so every existing test stays byte-identical (D65: extend, don't replace). |
| `ai/router.ts` | Structured `RouterError`, retry **inside `fetchJson` only** (so the ask-path query embedding is covered, and a retry can never wrap a mutating op), per-attempt deadlines, index-assigned embeddings, rerank + expansion seams. |
| `answer/prompt.ts` | Locators added to the evidence header, allow-listed — a sheet name is **file-controlled**, unlike a slug. Degraded-retrieval notice on a nonce line. |
| `api/dispatch.ts` | `ok_degraded` outcome; `dims: { format }` re-checked against a closed list before logging. |
| `api/server.ts`, `index.ts` | Upload route parses its own body **after** both guards; the app-wide 100kb parser skips that one path. |
| `db/migrate.ts` | `narrowGrants` revokes for the new tables (existence-guarded); `splitStatements` for the no-transaction path. |
| `db/doctor.ts` | `page_sources` acl-drift count; four index assertions — on the **expression**, since a name-only check is what let a dead index ship. |
| `ingest/chunk.ts` | `chunkBlocks` + byte-based `estimateTokens` added; `chunkText` untouched. Splitter made linear (was O(n²), and the file path feeds it inputs 25× larger). |

**Nothing was deleted.** One dead re-export (`formatLocator` from `file.ts`) and one inert lint
directive were removed during review; no file was dropped.

---

## 4. Decisions — the short form

Full reasoning is in `DECISIONS.md`. Grouped by the problem they solve:

**Permissions became real (D66–D70).** The enforced predicate lives in the RLS policy and nowhere
else. Private slugs are unique **per author** because unique-index checks bypass RLS and a collision
error was an enumeration oracle. Grant tags are lowercased because array overlap is byte equality.

**Storing files (D71–D73).** Bytes live in Postgres, not Supabase Storage, because Storage policies
read a Supabase login this app does not have — the only workable credential bypasses all RLS.
`quarantine` is a full tenancy-plane table because a rejected upload's **filename** is as sensitive
as the upload.

**Lifecycle (D74–D76).** Address by ID; every miss is `not_found` (distinguishing them rebuilds the
oracle). Who may destroy is an **app-layer** rule with nothing beneath it — stated as such, with
tests, because the database will not catch a regression. `delete_page` relies on the FK cascade
*because* an explicit child delete runs under RLS and would leave drifted rows behind.

**Search (D77–D79).** OR the terms; fuse the tiers as separately weighted arms. A relevance floor
and autocut were both **measured and rejected** — numbers in DECISIONS.

**AI plumbing (D80–D82).** Batched embedding defended twice. Losing the embedder degrades to
keyword-only and **says so** three ways. Rerank and expansion are real seams, switched off, and the
defaults are the decision.

**API surface (D83–D86).** `ingest_file` takes bytes and there is no path parameter, ever. Locator
components are allow-listed. `format` is a logged dimension — a scoped, stated exception to D28.

**What the review found (D87–D90).** The subprocess was not secret-free. The no-transaction pragma
had never worked. A dedup check must mirror its index exactly. Two guards had been weakened by
shapes their authors did not anticipate.

---

## 5. Two patterns worth carrying forward

**A guard that describes the right thing without observing it will pass forever.** The extraction
test asserted the source *contained* `env: { PATH:`. True continuously, while every secret leaked.
`live-gate` looked for the string `liveOrFail`, so `liveOrFail(...) && HAVE` sailed past it. The
`no-transaction` pragma existed and had never run. **When you write a guard, break the thing on
purpose and confirm it goes red.** Every guard touched in this session was verified that way.

**A mechanism that must bypass permissions becomes a way to ask about invisible data.** Unique
indexes, error messages, and `not_found` vs `permission_denied` all leak by construction unless
deliberately blunted. D68, D69, D73 and D74 are four instances of the same shape.

---

## 6. Where to pick up

### Open, ranked

1. **Team scope (M5).** The single biggest unlock. 36 of the NovaByte dataset's 105 pages are
   team-scoped and cannot be loaded, which blocks 54 of 68 visibility cases and 39 of 58 qrels rows.
   The dataset ships `docs/enabling-team-scope.md` with five located touch points. The one most
   likely to be missed: `src/auth/resolver.ts` builds the keyring without unioning team grants, so
   without that change a team page is invisible to **everyone including its author** — a dead row
   that typechecks.

2. **"Readable" ≠ "publishable".** Surfaced by the injection suite and **not solved**. Grep confirms
   no notion of it exists: `answerQuestion(ctx, question)` knows who is *asking* and has no
   parameter for who will *read* the output. So a request to draft a company-wide FAQ can include
   private material the asker may legitimately read. Suggested shape: an optional `audience` that
   filters retrieval to chunks whose ACL is a superset — enforce structurally rather than asking the
   model to be careful. Two open questions: is this M3 scope or later, and does it belong on `ask`
   or on a future `draft`/`publish` op?

3. **`UNIQUE (page_id, ord)` on `content_chunks`.** `replacePage`'s chunk delete runs under RLS, so a
   chunk whose acl has drifted survives and becomes an invisible duplicate. A unique index makes it
   loud. Real tradeoff: a 23505 the caller cannot diagnose from their own view. Task chip exists.

4. ~~**MCP has no rate limiter.**~~ **CLOSED at M4 (D94).** The per-principal budget moved to
   `dispatchOp` rung 0, so REST and MCP are metered by one instance. Note the CLI is reached but not
   effectively metered — `FixedWindowLimiter` is per-process and `call.ts` is one-shot — which is
   accepted and recorded in D94 rather than fixed. Spend *accounting* remains open (M5, D18).

5. **`README.md` is stale.** Does not mention the five new ops, `src/ingest/extract/`, or the upload
   route's separate body cap.

### Known limits of what is green

- **No cross-model review.** Codex was logged out for the entire session.
- **Of 19 critical review findings, 8 were verified empirically**; the rest were fixed on careful
  reading. Solid, but that is a real difference in confidence.
- **The A17 eval is saturated** — 14 chunks, 10 questions, scoring 1.000 before any change. It can
  show a *shape* but cannot justify a tuned constant. The arm weights are round on purpose.
- **Extraction fixtures are generated**, so a generated PDF is the easiest PDF in existence.
  Two-column layouts, page-spanning tables and Devanagari are where real extraction fails and are
  untested.
- **`bun run doctor` may need `--update`** after any schema change — review that diff as a security
  change, never reflexively.

### Commands

```bash
bun run typecheck
bun run migrate && bun run doctor
CB_REQUIRE_LIVE_TESTS=1 bun run test     # a SKIP here is a failure, by design
bun run dump:top8 --check                # retrieval regression guard
DATASET=~/Desktop/novabyte-test-dataset bun run eval:novabyte
bun run ingest-file ./some.pdf --slug my-doc
```

`.env` at the repo root is a **symlink to the main worktree**. It is gitignored. Never copy or print it.
