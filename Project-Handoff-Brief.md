# Meeting Intelligence System — Project Handoff Brief

**Repo/project naming note:** the product concept is "Meeting Intelligence System," but the actual repo, folder, Supabase project, and GitLab project are all named **good-wrap**. Use `good-wrap` for any file paths, package names, or repo references.

**Purpose of this document:** This is the full context and staged build plan for a personal meeting-intelligence tool. Use this as the starting brief. Work through the stages in order — each stage should be functional and testable before moving to the next.

---

## 1. Project Overview

Peter runs a high volume of meetings across different roles and initiatives and currently has no reliable way to retain or retrieve what was discussed. The goal is a system that:

1. Captures a meeting's transcript, participants, and metadata
2. Automatically extracts keywords, takeaways, and follow-up reminders immediately after the meeting
3. Delivers those takeaways via email, a chat-style ping, and a dashboard
4. Stores everything in a queryable database so Peter can later ask natural-language questions like *"what was that thing from two weeks ago about the budget?"* and get an answer with a source meeting cited
5. Eventually (later phase) proactively surfaces relevant history before an upcoming meeting — *"I have a meeting with Sarah — what do I need to bring up, and what did we cover last time?"*

This is being built **personal-first** (Peter is the only user right now) but the data model should be built as if other people (e.g., colleagues) could eventually use it too — normalize identities and ownership from day one rather than hard-coding a single-user assumption.

---

## 2. Important Technical Context — Read Before Building

**On Zoom's MCP server (do not skip this):**

Zoom does have a real, documented MCP offering — the **Zoom Meetings MCP Server** — with tools `search_meetings`, `get_meeting_assets`, `get_recording_resource`, and `recordings_list`. It requires a Zoom app registered in the Zoom App Marketplace, OAuth 2.0 with PKCE, and specific scopes (`meeting:read:assets`, `cloud_recording:read:content`, `cloud_recording:read:list_user_recordings`, `meeting:read:search`).

**However — and this matters for the architecture — MCP is pull-based only.** There is no push/webhook mechanism in Zoom's MCP layer. Zoom's own developer docs explicitly recommend using their REST API + webhooks for automation and backend services, and reserving MCP for interactive, AI-agent-driven use (e.g., asking Claude in a chat to fetch a specific transcript on demand).

**Implication:** The "automatically process the meeting the moment it ends" requirement cannot be built on MCP alone. It requires a Zoom webhook (`recording.transcript_completed`) hitting a backend service, which then calls Zoom's REST API to pull the transcript. MCP remains useful as an optional, secondary, interactive layer later (e.g., "hey Claude, pull my last meeting with X") — but it is not the ingestion mechanism.

**Current decision:** Live Zoom integration (webhook + API) is deferred to Stage 6. Until then, transcripts and metadata are entered manually (Stage 0) so the rest of the system can be built and proven out without depending on Zoom admin access.

---

## 3. Scope Decisions Already Made

| Decision | Choice |
|---|---|
| Who is this for | Peter first; data model architected so others could adopt it later |
| Build approach | Full custom web app (backend + database + dashboard), not a manual Claude Project workflow |
| Notification channels | Email + a chat-style ping + dashboard flag (all three) |
| Query experience | True natural-language Q&A across full transcripts (semantic search / embeddings), not just keyword search |
| Calendar-based proactive prep | Deferred to a later stage — build capture + query solidly first |
| Zoom transcript access | Manual paste for now (Stage 0); real Zoom webhook + REST API later (Stage 6) |
| Tech stack | See Section 5 |
| Frontend framework | Vue.js + Quasar (was React/Vite/Tailwind) |
| Version control | GitLab (org standard) |
| Database/backend host | Supabase, used as a plain Postgres + pgvector database — no Supabase Auth or Edge Functions; a custom backend still owns ingestion and Claude API calls |
| Dashboard delivery | Not a standalone app — plugs in as a new module/section inside an existing Vue/Quasar "hub" app Peter already has running |
| Auth | Reuses the hub's existing auth/session — no separate login gate to build |

---

## 4. Staged Build Plan

### Stage 0 — Manual capture (current starting point)

A simple way for Peter to paste in a transcript plus meeting metadata (meeting name, date, participants) that feeds into the same pipeline the live Zoom integration will eventually use. Can be a form on the dashboard or a small standalone script — the point is decoupling "getting data in" from everything downstream.

### Stage 1 — Data model

Postgres (Neon) with the `pgvector` extension. Draft schema:

```
users
  id, name, email, created_at
people
  id, email (unique, natural key), name
  -- normalized identity so the same person is recognized across meetings;
  -- this is what makes future "meeting with X" features possible without rework
meetings
  id, owner_id (fk users), zoom_meeting_id (nullable for manual entries),
  topic, start_time, duration_minutes, source ('manual' | 'zoom'), created_at
meeting_participants
  meeting_id (fk meetings), person_id (fk people)
transcripts
  id, meeting_id (fk meetings), raw_text, created_at
transcript_chunks
  id, transcript_id (fk transcripts), chunk_index, chunk_text,
  embedding vector(1536)  -- for semantic search
meeting_insights
  id, meeting_id (fk meetings), keywords jsonb, takeaways jsonb,
  follow_ups jsonb, generated_at
notifications_log
  id, meeting_id (fk meetings), channel ('email' | 'chat' | 'dashboard'),
  sent_at, status
```

### Stage 2 — Processing pipeline

Triggered by Stage 0's manual input (later, by Zoom's webhook in Stage 6):

1. Take the transcript + metadata
2. Call Claude API with a structured-output prompt to extract keywords, takeaways, and follow-ups → write to `meeting_insights`
3. Chunk the transcript, generate embeddings, write to `transcript_chunks`
4. Write meeting/participant records to `meetings`, `people`, `meeting_participants`

### Stage 3 — Immediate notification

Once Stage 2 completes, fire:

- An email with the takeaways/follow-ups
- A chat-style ping (tool TBD — see open decisions below)
- A dashboard flag marking the meeting as newly processed

### Stage 4 — Dashboard (module in the existing hub)

Not a new standalone frontend — a new module/section inside Peter's existing Vue/Quasar "hub" app: meeting list, per-meeting takeaways view, filtering by date/participant, and the Stage 0 manual-entry form live here. Reuses the hub's existing auth/session rather than a separate login. See Section 8 for integration questions to resolve before this stage starts.

### Stage 5 — Natural-language Q&A

Peter's question gets embedded, compared against `transcript_chunks` via pgvector similarity search, relevant chunks are handed to Claude along with the question, and the answer is returned with the source meeting(s) cited.

### Stage 6 — Live Zoom connection (deferred)

Replace manual paste with the real thing:

- Register a Zoom app (General app) in the Zoom App Marketplace
- Scopes: `meeting:read:assets`, `cloud_recording:read:content`, `cloud_recording:read:list_user_recordings`, `meeting:read:search`
- Subscribe to the `recording.transcript_completed` webhook
- On webhook fire, call Zoom's REST API to pull transcript/participants/metadata, then feed into the existing Stage 2 pipeline unchanged
- Optionally, separately, connect Zoom's MCP server as a custom connector in Claude for ad hoc interactive queries (not part of the automated pipeline)

### Stage 7 — Proactive prep (Phase 2, deferred)

Calendar integration (Google Calendar / Outlook) to surface relevant history and open follow-ups before an upcoming meeting with a given person, using the `people` table built in Stage 1.

---

## 5. Tech Stack (updated 2026-07-14)

- **Database:** Postgres via Supabase, with the `pgvector` extension for embeddings — used purely as a database (no Supabase Auth or Edge Functions in the pipeline), one database handles both structured data and semantic search
- **ORM:** Drizzle (works against any Postgres connection string, including Supabase's)
- **Backend:** Node/TypeScript service — handles auth, ingestion, Claude API calls, and serves the dashboard's API. Hosting choice still open (see Section 6)
- **AI:** Claude API for keyword/takeaway/follow-up extraction and for the Q&A layer
- **Frontend:** Vue.js + Quasar for the dashboard
- **Version control:** GitLab (org standard)

Previous draft of this section specified Neon + React/Vite/Tailwind — superseded by Peter's 2026-07-14 stack decision above.

---

## 6. Open Decisions Still Needed

- Which chat tool for the Stage 3 "chat-style ping" (Slack, Teams, something else)?
- Hosting choice for the backend (Vercel, Netlify, other)? Frontend is no longer a separate hosting decision — it ships as part of the existing hub app.
- ~~Auth approach for the dashboard~~ — resolved: reuses the hub's existing auth (see Section 8).

Surface these to Peter when you reach the stage where they matter — no need to resolve them all upfront.

---

## 7. Immediate Next Step

Start with **Stage 1 (schema)** and **Stage 0 (manual capture form)** together, since Stage 0 needs somewhere to write to. Confirm the schema with Peter before running migrations, then build the manual-entry flow and processing pipeline (Stage 2) so there's an end-to-end path — paste a transcript in, see takeaways come out — before building the full dashboard around it.

---

## 8. Hub Integration (added 2026-07-14)

Peter confirmed the Stage 4 dashboard will not be a standalone app — it plugs into an existing Vue/Quasar "hub" app he already runs, reusing that hub's existing auth/session instead of building a new login gate.

This doesn't block Stages 0–3 (backend/schema/pipeline work is unaffected either way), but before Stage 4 starts, gather from Peter:

- **Repo layout:** Is the hub a monorepo Peter wants this module added into directly, or a separate repo that will import/consume this as a package or micro-frontend?
- **Module convention:** How does the hub currently add a new section — a new route + nav entry in an existing Vue Router config, a plugin/module system, something else?
- **State management:** Does the hub use Pinia (or Vuex) already, and should meeting-intelligence state live in the hub's existing store or its own?
- **Design system:** Does the hub have shared Quasar components/theme meeting-intelligence should reuse, or a component library to pull from?
- **Auth mechanics:** How does the hub expose the current user/session to a new module (a composable, injected store, cookie/JWT the backend should validate)? This determines how the backend authenticates API calls coming from the hub.
- **API surface:** Does the hub's frontend already have a convention for calling backend services (a shared API client, base URL config), or will meeting-intelligence's backend be a net-new service the hub just points at?

---

## 9. Stage 1 Status: DONE (2026-07-14)

Schema is live on the "good-wrap" Supabase project (org: peterdrummond-FG-SB). Applied as two migrations via the Supabase MCP connector:

- `enable_vector_extension` — enables `pgvector` in the `extensions` schema
- `stage1_core_schema` — creates the 3 enums, all 8 tables, foreign-key indexes on every FK column (per Supabase's Postgres best-practices guide — Postgres doesn't auto-index FKs), and enables RLS on every table with no policies defined (safe because the backend will connect via the service role / direct connection, which bypasses RLS — this is just a defense-in-depth guard against accidental exposure if the Data API is ever turned on for these tables)

Verified via `list_tables` (all 8 tables present with correct columns/FKs) and `get_advisors`:

- Security: only "RLS enabled, no policy" INFO notices, which is expected/by design. One pre-existing WARN (`rls_auto_enable` — a `SECURITY DEFINER` event-trigger function callable by anon/authenticated) was found on the "good-wrap" project, but it predates this work and isn't something this migration introduced — flagged to Peter, not modified.
- Performance: only "unused index" INFO notices, expected since the tables are brand new with zero rows.

Not yet done: no GitLab remote push (see Section 8 workflow — Peter pushes from his own machine), and no rows/data yet (that comes with Stage 0/2).

**GitLab repo:** `peterdrummond-fg-group/good-wrap` — https://gitlab.com/peterdrummond-fg-group/good-wrap (private). Same "good-wrap" naming as the Supabase project. No commits or issues pushed yet as of 2026-07-14 — Peter still needs to push the Stage 1 files from his own machine (see Section 8 GitLab workflow above).

**GitLab MCP connector:** connected and working as of 2026-07-14 (server `19.2.0-pre`). Scope confirmed: search, issues, merge requests, pipelines, work items, code search. Does not support creating repos or pushing files/commits — that stays a manual step on Peter's machine.

---

## 10. Stage 2 & 3 Status: BUILT, not yet live-tested (2026-07-15)

Code is written and typechecks cleanly (`npx tsc --noEmit`), but hasn't been run end-to-end yet because it needs two secrets only Peter can supply (see `.env.example`): `ANTHROPIC_API_KEY` and a working `DATABASE_URL`. (A third secret, an embeddings API key, was originally planned but dropped — see below.) Once those are in `.env`, run:

```
npm install
npm run pipeline -- <meetingId>   # Stage 2 + Stage 3 in one go
```

or the two stages separately (`npm run process -- <meetingId>`, then `npm run notify -- <meetingId>`).

**Stage 2 — processing pipeline** (`src/pipeline/`):
- `extractInsights.ts` — calls Claude (model configurable via `CLAUDE_MODEL`, defaults to `claude-sonnet-5`) using forced tool-use so the output is always valid structured JSON: 5-10 keywords, 3-8 takeaways, 0-8 follow-ups, all grounded in the transcript (no inferred motivation, matching the "don't hallucinate" principle from the July 14 prompt-caching conversation captured in the second test meeting).
- `embedChunks.ts` — generates embeddings **entirely locally**, no API key (see "Embeddings decision" below).
- `chunkText.ts` — splits transcripts on blank-line turn boundaries (~1500 chars/chunk) rather than cutting mid-sentence.
- `processMeeting.ts` — orchestrates the above, writes to `meeting_insights` and `transcript_chunks`. Idempotent: re-running for the same meeting replaces prior output instead of duplicating rows, so it's safe to re-run after a prompt tweak.

**Stage 3 — notifications** (`src/notify/`):
- Pluggable `Notifier` interface (`notifier.ts`) so each channel logs a consistent `notifications_log` row.
- `channels/dashboardFlag.ts` — real, not a stub: the `notifications_log` row itself is the dashboard flag Stage 4 will query for "newly processed" meetings.
- `channels/email.ts` and `channels/chat.ts` — **stubs**. Which email provider and which chat tool (Slack/Teams/other) are still open decisions (Section 6) — rather than block on that choice, these print what would be sent and log status `pending` (not `sent`, since nothing is actually delivered yet). Swap in a real provider call and flip the return value to `sent` once one is chosen.
- `sendNotifications.ts` — reads the latest `meeting_insights` row for a meeting and fires all three channels.

**Embeddings decision (2026-07-15):** Originally planned to use Voyage AI (Anthropic's recommended embeddings partner) at 1536 dimensions. Peter asked not to add another paid API/subscription for this. Switched to fully local embeddings via `fastembed` (BAAI/bge-small-en-v1.5, ONNX Runtime, 384-dim) — no account, no API key, no per-call cost. First run downloads the model (~130MB) and caches it; every run after is offline. `db/schema.ts`'s `transcript_chunks.embedding` column was changed from `vector(1536)` to `vector(384)` to match (safe — the table had zero rows). Note: `@xenova/transformers` was tried first and rejected — it pulls in `sharp` (an image-processing library with native binaries) as a hard dependency even for text-only use, and that failed to install in this session's sandbox; `fastembed` has no such dependency and installed cleanly. The actual embedding call (`FlagEmbedding.init(...)`) hasn't been run on Peter's own Mac yet — it needs the `@anush008/tokenizers-darwin-universal` native binary, which the package does publish, but this wasn't verified outside the sandbox (the sandbox is linux-arm64, which that pinned dependency version doesn't ship a binary for, so the smoke test there is inconclusive by architecture, not a real failure). Worth a quick check the first time Stage 2 actually runs.

**Also considered and rejected (2026-07-15):** Peter asked about two GitHub tools as possible alternatives to building Stage 5 ourselves — `Graphify-Labs/graphify` (turns a codebase/doc folder into a queryable knowledge graph via tree-sitter, explicitly *not* vector-based) and `grapeot/semantic-search-skill` (a Python CLI skill for AI coding agents to search local files, defaults to OpenAI's paid embeddings API). Neither fits: both are designed as interactive tools for a coding agent to search flat files/repos, not as libraries embedded in a running app to answer end-user questions against an ever-growing database of meeting transcripts. Adopting either would mean introducing a Python toolchain into an all-TypeScript project and giving up the pgvector approach already partly built. Continued with the existing plan (Stage 2's chunking/embeddings + Stage 5's pgvector similarity search).

**Not yet done:** live test against the Supabase DB (blocked on Peter adding the env vars above), picking real email/chat providers, GitLab push of this code (same manual-push workflow as Stage 0/1).

---

**Adaptation check (2026-07-15):** before treating fastembed as a drop-in, checked its source (`node_modules/fastembed/lib/cjs/fastembed.js`) rather than assuming. Two findings: (1) `passageEmbed`/`queryEmbed` already add the `"passage: "`/`"query: "` prefixes BGE models need for asymmetric retrieval internally — no extra work needed, our wrapper functions get this for free by using the right method for each case. (2) the model silently truncates input at 512 tokens with no error — `chunkText.ts`'s target chunk size was reduced from ~1500 to ~800 characters to keep real headroom under that limit for dense spoken dialogue, rather than risk quietly-truncated embeddings with no error signal. Also corrected a doc mistake: the model cache defaults to a `local_cache/` folder in the project root (now gitignored), not the OS temp dir as originally written.

## 11. Stage 5 Status: BUILT, not yet live-tested (2026-07-15)

`src/qa/askQuestion.ts` — embeds the question locally (same `fastembed` model as Stage 2, using its asymmetric `queryEmbed` rather than `passageEmbed`), runs a raw pgvector cosine-distance (`<=>`) query against `transcript_chunks` joined back to `transcripts`/`meetings` for the top 8 matches, then hands the matched excerpts to Claude via forced tool-use. Claude returns both an answer and which of the provided `meeting_id`s it actually drew from, so `sources` only lists meetings genuinely cited rather than every chunk that happened to be nearby. Run via `npm run ask -- "your question here"`. Depends on the same `ANTHROPIC_API_KEY`/`DATABASE_URL` env vars as Stage 2, plus at least one meeting having been through Stage 2 already (there's nothing to search otherwise).

---

## 12. Stage 4 Status: POC BUILT (typechecks + builds clean), not yet live-tested (2026-07-15)

Per Peter's direction: build a temporary **standalone** dashboard now, to be rewritten to fit inside the hub app later once the shape of the pages is agreed on (see Section 8 — those integration questions still need answers before that rewrite happens). Deliberately not wired into the hub yet.

**Backend API** (`src/server/`, part of the main `good-wrap` package): a small Fastify server, no auth (personal-use-only POC), exposing:
- `GET /api/meetings` — list, with participants and a processed/not-processed flag
- `GET /api/meetings/:id` — full detail: insights, participants, transcript
- `POST /api/meetings` — Stage 0 capture (calls the same `captureManualMeeting` the chat-paste workflow and CLI use)
- `POST /api/meetings/:id/process` — runs Stage 2 + 3 (`runFullPipeline`)
- `POST /api/ask` — Stage 5 Q&A

Run with `npm run api` (defaults to port 4000, override with `PORT`).

**Frontend** (`dashboard/`, a separate Vite project — deliberately not part of the root `package.json`, since this whole folder is meant to be thrown away/absorbed into the hub, not maintained long-term): Vue 3 + Quasar, matching Peter's actual hub stack so the eventual rewrite is porting components, not learning a new framework. Four pages: meeting list, meeting detail (keywords/takeaways/follow-ups as chips and lists, collapsible full transcript, a "Process this meeting" button if Stage 2 hasn't run yet), the Stage 0 capture form, and a Stage 5 "Ask" page. Run with `cd dashboard && npm install && npm run dev` (port 5173, proxies `/api` to the backend on port 4000).

**Verification done:** `npx tsc --noEmit` (backend) and `npx vue-tsc -b && vite build` (frontend) both pass clean; the built frontend serves correctly via `vite preview`. **Not yet done:** visual/interactive check in an actual browser, and a live run against the real Supabase DB (same blocker as Stages 2/3/5 — needs `ANTHROPIC_API_KEY` and `DATABASE_URL` in `.env`). Once those are in place: `npm run api` in one terminal, `cd dashboard && npm run dev` in another, then open http://localhost:5173.

---

## 13. Session Update: Dashboard Restyle, Auto-Processing, Retry Logic, GitLab Backup (2026-07-15)

Everything below is live-tested in an actual browser (not just typechecked) against Peter's real running dev servers, and is now pushed to GitLab (see below).

**Dashboard restyled to match Peter's Figma reference** (a "BotBuzz" AI-chat app): dark theme, purple accent (`#7c6fee`), card-style panels. `dashboard/src/styles/theme.css` overrides Quasar's dark-mode CSS variables; `dashboard/src/App.vue` is a `q-layout` with a slim header and a left nav drawer (logo, Dashboard/Capture/Ask nav items with active-pill styling).

**Dashboard home page (`Dashboard.vue`) restructured into 3 simultaneous panels**, all visible at once rather than separate routes:
- **Meetings** (`MeetingsPanel.vue`) — flat list, Capture button in the header
- **Meetings Overview** (`MeetingsOverviewPanel.vue`) — grouped by Today/Yesterday/This Week/Older, shows each meeting's top 3 takeaways
- **Follow-ups** (`FollowUpsPanel.vue`) — grouped by Tomorrow/This Week/Next Week/Other, shows who each follow-up is with and which meeting it came from

Panels fill the viewport height and scroll internally (not the whole page). Width is resizable via nested Quasar `q-splitter`s (drag in the gap between panels — no separate resize handle needed, `q-splitter` already shows a `col-resize` cursor on hover). Order is changeable via a small unlabeled `drag_indicator` icon in each panel's own top-left corner (native HTML5 drag-and-drop). Panel order and splitter widths persist to `localStorage` (legitimate here since this is a real browser app the user reopens, not a Claude.ai artifact).

**Ask page is now a real multi-turn chat UI** (`q-chat-message` bubbles). Along the way, fixed a genuine Vue reactivity bug worth remembering: pushing a plain object into a `ref` array and mutating it later (e.g. filling in the answer after the API responds) does *not* trigger a re-render — the object has to be wrapped in `reactive()` at creation time.

**Follow-ups are now structured**, not plain strings: `FollowUpItem { text, person, timing }` (`db/schema.ts`). `extractInsights.ts` passes Claude the meeting's actual date and real participant names, and only fills in `person`/`timing` when the transcript genuinely supports it (verified live: Claude correctly attributed a follow-up to a named participant and correctly tagged "tomorrow" based on the transcript, without guessing when it shouldn't).

**Meetings now auto-process immediately on capture.** `POST /api/meetings` (`src/server/app.ts`) calls `captureManualMeeting` then `runFullPipeline` in its own try/catch, so a processing failure (e.g. a flaky Claude API call) never fails the capture itself — the meeting is still safely saved, just flagged `processed: false` with a `processingError`. The dashboard's capture form shows a warning toast in that case. A manual **"Reprocess meeting"** button remains on the meeting detail page regardless of processed state, as a fallback / re-run option. `src/ingest/cli.ts` (the manual capture CLI) got the same auto-process behavior for consistency. This mirrors exactly what Stage 6's future Zoom webhook will do — no changes needed there later.

**Added retry-with-backoff** (`src/util/retry.ts`, `withRetry()` — up to 2 retries, 1s/2s delay) around both external calls in the Stage 2 pipeline: `extractInsights.ts`'s Claude API call and `embedChunks.ts`'s local embedding calls. Triggered by the process endpoint intermittently returning a 400 that succeeded immediately on a plain retry with identical input — a transient blip, not a real bug. While in there, also fixed a related latent bug in `embedChunks.ts`: the cached model-init promise wasn't cleared on failure, so a single transient failure loading the local embedding model would have permanently broken every future call until the server restarted.

### GitLab backup: DONE (2026-07-15)

This repo is now pushed to `gitlab.com/peterdrummond-fg-group/good-wrap`, `main` branch (commit `7cc2710` at time of writing). Local `master` tracks `origin/main`, so plain `git pull`/`git push` work going forward. Gotchas hit along the way, worth knowing if this ever comes up again:

- GitLab no longer accepts your account password for `git push` over HTTPS — it needs a **Personal Access Token** (`write_repository` scope), used as the password when prompted.
- The GitLab repo already had a separate, unrelated commit history from an earlier session where files (`schema.ts`, `drizzle.config.ts`, `Project-Handoff-Brief.md`, `package.json`) had been uploaded directly through GitLab's web UI, outside of any local git clone. Merging this local repo into that required `git pull origin main --no-rebase --allow-unrelated-histories`. Peter resolved the resulting add/add conflicts by deleting the stale files via GitLab's web UI and re-running the merge, which then went through clean.
- Nine empty (0-byte) `smoke_*.ts` placeholder files at the project root are harmless leftover junk from earlier debugging sessions — not committed, safe to delete by hand whenever convenient.
- `.gitignore` now also excludes recurring stray build artifacts that have shown up in `dashboard/src` (vue-tsc debug dumps like `App.vue.js`/`AskPage.vue.js`, stale compiled `main.js`/`api.js`/`router/index.js` shadowing the real `.ts` sources, and Vite's `vite.config.ts.timestamp-*.mjs` temp files). If these reappear, they're tool noise, not something to fix or commit.
- Your global git identity isn't set (commits are auto-attributing to `peterdrummond@Peters-MacBook-Pro.local`) — worth running `git config --global user.name "Peter Drummond"` and `git config --global user.email "peter.drummond@flippengroup.com"` at some point so future commits use your real identity instead of the auto-detected one.

### Still open / not yet done

- **Hub integration** (Section 8) — the dashboard is still a standalone POC, not yet merged into Peter's actual hub app. Those integration questions (repo layout, module convention, state management, design system, auth mechanics, API surface) are still unanswered.
- **Real email/chat notification providers** (Section 6) — `channels/email.ts` and `channels/chat.ts` are still stubs that log `pending`, not `sent`.
- **Stage 6** (live Zoom webhook) and **Stage 7** (proactive prep) — both still deferred, untouched since the original brief.
- No auth on the dashboard/API yet — still fine for a personal-use POC, but a blocker before this becomes multi-user or hub-embedded.

### Quick start for a new session

```
cd "good-wrap"
npm install                          # root (backend/pipeline)
npm run api                          # starts Fastify backend on :4000

# in a second terminal
cd dashboard
npm install
npm run dev                          # starts Vite dashboard on :5173, proxies /api to :4000
```

Needs `ANTHROPIC_API_KEY` and `DATABASE_URL` in `.env` (see `.env.example`) — both already set up on Peter's machine as of this session. Open `http://localhost:5173` for the dashboard.

---

## 14. Session Update: Suggest-Then-Approve Review Workflow, Per-Panel Save, Full Code Audit (2026-07-15/16)

This is the most recent, most load-bearing update — read this section fully before touching the review/notification code. Two companion docs live alongside this one: `Prompt-Tuning-Handoff.md` (superseded/resolved in-session, kept for history — the extraction prompt was reviewed against real output and confirmed good, no changes needed) and `CODE-AUDIT.md` (a full code audit; critical + moderate items are fixed as of this section, low-priority items are listed as still open below).

### 14.1 The review workflow, as it stands today

Meetings no longer get final takeaways/action items/follow-ups straight out of Claude. The flow is now suggest-then-approve, but with **different rules per category**:

- **Takeaways**: Claude generates exactly 5 (not a range), and they're auto-approved — no checkbox, no selection UI, no "add your own" input. Peter validated the extraction prompt against real meeting output and confirmed 5 well-chosen takeaways is sufficient; if this ever needs revisiting, ask what's now falling short before changing the prompt (see `feedback_good_wrap_build_decisions` memory).
- **Action Items** (things Peter himself needs to do — no separate owner field) and **Follow-ups** (things other people need to do, or reminders of unconfirmed items — keeps a `person` field): Claude generates 5-8 candidates each, all initially unapproved. Peter checks which ones to keep on the meeting detail page, can add his own via a free-text "add your own" row per column, and each category **saves and is reviewed completely independently of the other**.

**Meeting detail page (`dashboard/src/views/MeetingDetail.vue`) layout:** three columns side by side under "Review suggestions" — Takeaways, Action Items, Follow-ups. Each has its own pencil icon that toggles an edit mode revealing a "Regenerate {category}" button (re-runs the full Claude extraction but only overwrites that one category — see `src/pipeline/regenerateCategory.ts`). Action Items/Follow-ups additionally show checkboxes + an add-your-own input while in "needs review" state (or while pencil-toggled open), and collapse to a plain bulleted list of approved items once that specific category has been reviewed. Metadata editing (topic/date/participants/keywords) is a completely separate "Edit" button/view, deliberately kept independent from the review columns.

**Per-panel Save (added this session, replacing an earlier single "Save selections" button):** Action Items and Follow-ups each have their own Save button, directly in their column. It's disabled/grayed until that panel's working copy (checkbox states + any added items) differs from what's currently saved — tracked via a JSON-snapshot baseline (`actionItemsBaseline`/`followUpsBaseline`, compared via `actionItemsDirty`/`followUpsDirty` computeds in `MeetingDetail.vue`). Saving one panel only ever sends that one category to the backend (`submitMeetingReview`/`POST /api/meetings/:id/review`) and never touches the other panel's in-progress unsaved state. Regenerating one category similarly only resets that category's local working copy, never the other's.

**Schema (`db/schema.ts`, `meeting_insights` table) as it stands today:**
```
id, meeting_id,
keywords jsonb (string[], always automatic, no review),
takeaways jsonb (SuggestionItem[] — always exactly 5, always approved:true),
action_items jsonb (ActionItem[] — {text, timing, approved}),
follow_ups jsonb (FollowUpItem[] — {text, person, timing, approved}),
action_items_reviewed_at timestamptz (null until Action Items' own Save button used at least once),
follow_ups_reviewed_at timestamptz (null until Follow-ups' own Save button used at least once),
generated_at
```
Note there is **no single `reviewed_at` column anymore** — it was split into the two category-specific columns above on 2026-07-15 (migration `split_reviewed_at_per_category`) specifically because per-panel saving meant one shared flag could no longer answer "has *this* category been reviewed." The dashboard's 3-state badge (`pending`/`needs_review`/`reviewed`, `computeReviewStatus` in `src/server/queries.ts`) now reports "reviewed" only once **both** action_items_reviewed_at and follow_ups_reviewed_at are set.

**Notifications** (`src/notify/sendNotifications.ts`, `src/pipeline/reviewMeeting.ts`): fire once per category, the first time *that category's* reviewed-at moves from null to set — not once per meeting. Each notification re-reads the whole `meeting_insights` row, so it includes whatever's currently approved across all categories at that moment. Practical implication Peter should know: if Action Items is reviewed/saved today and Follow-ups isn't touched until next week, that's two separate notifications, not one combined one — this was an explicit, accepted trade-off (see the code audit below) rather than an oversight.

**Regenerating a category** (`src/pipeline/regenerateCategory.ts`) re-runs the full Claude extraction call but only persists the one requested category (takeaways/actionItems/followUps), leaving the other two + keywords untouched. For Action Items/Follow-ups, regenerating also resets *that* category's own reviewed-at back to null (so the dashboard badge correctly reflects "needs another look" instead of still claiming reviewed with stale unapproved candidates underneath). Never fires notifications.

**Dashboard 4-panel home page** (`Dashboard.vue`): Meetings, Meetings Overview, Follow-ups, Action Items — each its own resizable/reorderable panel (nested `q-splitter`s, order+split-ratio persisted to `localStorage`). `ActionItemsPanel.vue` mirrors `FollowUpsPanel.vue`'s structure (grouped Tomorrow/This Week/Next Week/Other) but has no `person` field since action items are always Peter's own.

### 14.2 Full code audit — done, critical + moderate fixed, low still open

A full read-only code audit was run across backend, frontend, and security (`CODE-AUDIT.md` at the repo root has the full writeup). All **critical** and **moderate** items are now fixed:

- Stale compiled `.js` files shadowing real `.ts`/`.vue` sources — fixed via `noEmit: true` in `dashboard/tsconfig.json` + broadened `.gitignore` (`dashboard/src/**/*.js`). **Peter still needs to run a one-time local cleanup** — see the exact commands given at the end of that conversation turn (`git rm --cached dashboard/src/dateBuckets.js`, `find dashboard/src -name "*.js" -delete`) if not already done.
- Per-panel notification gap and the keywords-only-call-marks-reviewed bug — fixed via the per-category `action_items_reviewed_at`/`follow_ups_reviewed_at` split described in 14.1.
- Regenerate leaving a stale "Reviewed" badge — fixed (regenerate now resets that category's own reviewed-at).
- Reprocessing silently discarding all previously-approved items — fixed with a confirmation dialog (`confirmReprocess()` in `MeetingDetail.vue`) before the "Reprocess meeting" button runs; the first-time "Process this meeting" button (nothing to lose yet) still runs with no prompt.
- Metadata edit save silently wiping unsaved review checkbox changes — fixed (`refreshMeetingKeepingReviewEdits()` replaces a full `load()` after a metadata-only save).
- Missing indexes on FK columns — added (`meeting_insights.meeting_id`, `transcripts.meeting_id`, `transcript_chunks.transcript_id`, `notifications_log.meeting_id`, `meeting_participants.person_id`), and `db/schema.ts` now declares them via `index()` so the schema file matches the live DB (worth knowing: while doing this, discovered the live DB already had equivalently-named indexes on most of these columns that `db/schema.ts` had never documented — a pre-existing DB/schema-file drift, now reconciled, duplicates dropped).
- Wide-open CORS (`origin: true`) — locked to `http://localhost:5173` (`src/server/app.ts`). **Will need revisiting** the moment the dashboard/API are reachable from anywhere but Peter's own machine (e.g. the Railway/Vercel hosting from Section 13) — that origin isn't in the allow-list yet.

**Still open — low-priority items from the audit, not yet fixed (Peter's next ask):**
- `listMeetings`'s dead `.filter((t) => t.approved)` on takeaways (can never remove anything now that takeaways are always auto-approved).
- `SuggestionItem.approved` type is vestigial for takeaways (always true, nothing can set it false).
- `meetings.zoomMeetingId` has no unique constraint (future duplicate-webhook risk once Stage 6 lands).
- `.env.example` has a real value (`DEFAULT_OWNER_EMAIL=peter.drummond@flippengroup.com`) instead of a placeholder.
- `SubmitReviewInput.keywords` (frontend type) is declared but no current caller sends it — dead field.
- Two orphaned, unrouted dashboard views (`MeetingList.vue`, `FollowUpsOverview.vue`) — self-documented as intentionally inert.
- No Fastify request-body schema validation — malformed input relies on downstream code throwing, caught per-route as a 400 with the raw error message exposed (fine for a personal tool talking only to its own dashboard).
- Known accepted risks (not bugs, just flagged): no auth anywhere in the API (deliberate for this personal POC), prompt-injection surface via transcript text sent to Claude (limited in practice by forced tool-use constraining output to a fixed schema).

**Also confirmed fixed independently of the audit:** the double-encoded `follow_ups` JSON quirk on meeting `a9d6e15d` (flagged 2026-07-16) is no longer present — that row now stores a proper array, likely resolved by a reprocess at some point.

### 14.3 Verification done this session

`npx tsc --noEmit` (root/backend) and `npx vue-tsc -b` (dashboard) both pass clean after every change described above. Live click-through in an actual browser has **not** been done in this sandbox (same network restriction as always — no direct route to `api.anthropic.com` or the Supabase pooler from here); worth a quick pass on Peter's machine, especially: saving Action Items and Follow-ups independently and confirming each other's in-progress edits survive, regenerating a category and confirming the *other* category's unsaved local edits survive, and triggering the reprocess confirmation dialog.

### 14.4 Quick start (unchanged from Section 13, still accurate)

```
cd "good-wrap"
npm install                          # root (backend/pipeline)
npm run api                          # starts Fastify backend on :4000

# in a second terminal
cd dashboard
npm install
npm run dev                          # starts Vite dashboard on :5173, proxies /api to :4000
```

Needs `ANTHROPIC_API_KEY` and `DATABASE_URL` in `.env` — already set up on Peter's machine. Open `http://localhost:5173`. Note: the backend's CORS is now locked to `http://localhost:5173` specifically (see 14.2) — if the dev server is ever run on a different port, update `src/server/app.ts`'s allow-list to match.

---

## 15. Session Update: Deployment, Dashboard Layout, Timing Buckets (2026-07-16)

**Deployed:** dashboard now runs live at `good-wrap.vercel.app` (Vercel), API at `good-wrap-production.up.railway.app` (Railway). Backend CORS allow-list (`src/server/app.ts`) extended to include the Vercel production origin by default, plus an optional comma-separated `ALLOWED_ORIGINS` env var (documented in `.env.example`) so a Vercel preview-deployment URL can be added on Railway without a code change/redeploy. Push workflow: local `main` tracks a `github` remote (`github.com/peterdrummond-FG/good-wrap`) — this is what Vercel/Railway actually auto-deploy from — with `origin` (GitLab) kept in sync as a secondary push, not the deploy source.

**Dashboard reduced from 4 columns to 3:** Meetings | Meetings Overview | a combined Action Items (top) / Follow-ups (bottom) column, via a new `ActionFollowUpStack.vue` component (a `q-splitter` in `horizontal` — i.e. top/bottom — mode). The stacked pair always keeps that relative order and drags as one unit between the 3 column positions; only the split ratio between Action Items and Follow-ups within the stack is independently resizable. Column order + all split ratios persist to `localStorage` under new keys (the shape changed from 4 panels to 3, so old saved layouts reset once rather than being force-migrated). All sizing stays percentage-of-container with `min-width`/`min-height: 0` added throughout so the whole layout scales with the browser window instead of assuming any fixed pixel size.

**Action Items / Follow-ups now bucket by Today / Tomorrow / This Week / Next Week / Other** (previously just Tomorrow / Next Week / Other, with "this_week" and "unspecified" both silently folded into Other) — mirrors Meetings Overview's Today/Yesterday/This Week/Older section-label style, per Peter's request. This required adding `"today"` as a new `FollowUpTiming` value (`db/schema.ts`, mirrored in `dashboard/src/api.ts`) — previously the earliest bucket was "tomorrow", so same-day items had nowhere to go but "unspecified". `extractInsights.ts`'s Claude tool schema and prompt guidance for both `actionItems` and `followUps` were updated to include `"today"` in the enum with an example (e.g. "let's circle back before we wrap up today" → today). `timing` is stored as plain `jsonb`, not a Postgres enum column, so this needed no DB migration — just the TS type, the extraction schema, `queries.ts`'s `VALID_TIMINGS` validation set, and `MeetingDetail.vue`'s `timingLabel()` display helper. Not backfilled: meetings processed before this change may have same-day items sitting in "unspecified" rather than "today" — only affects future extractions, no reprocess needed unless Peter wants those old items reclassified.

**Verification:** `npx tsc --noEmit` (root) and `npx vue-tsc -b` (dashboard) both pass clean. A local production build (`vite build`) also compiles clean when pointed at a scratch `outDir` — the default `dashboard/dist` target failed to clear in this sandbox only, a stale-permissions artifact unrelated to the code change. No live browser click-through in this sandbox (same `api.anthropic.com`/Supabase network restriction as prior sessions) — worth confirming on Peter's machine that dragging the Action Items/Follow-ups split and reordering the 3 columns behaves as expected, and that a fresh extraction actually produces a "today" item when the transcript supports it.

---

## 16. Session Update: Urgency Replaces Timing, Follow-ups-by-Person, Colored Person Tags (2026-07-16)

Timing-based grouping (Today/Tomorrow/This Week/Next Week/Other, added earlier the same day in Section 15) was replaced entirely with **urgency** (High/Medium/Low), per Peter's direct follow-up request — he wanted suggested action items/follow-ups triaged by how urgent they are, not by when the transcript implied they'd happen.

**Schema/prompt:** `FollowUpTiming` became `Urgency = "high" | "medium" | "low"` (`db/schema.ts`, mirrored in `dashboard/src/api.ts`) on both `ActionItem` and `FollowUpItem`. `extractInsights.ts`'s Claude tool schema/prompt now asks for urgency instead of timing — "high" only for genuinely urgent/blocking language, "low" for explicitly deprioritized items, "medium" as the default absent any real signal (no "unspecified" bucket needed this time, since every item gets a real, sortable value). `queries.ts`'s legacy-shape normalization (`normalizeUrgency`) defaults anything missing/invalid to "medium" — same treatment old pre-migration rows got for `timing`/`unspecified` previously. No DB migration needed (still plain jsonb).

**Dashboard panels:** `ActionItemsPanel.vue` now groups High/Medium/Low instead of by time. `FollowUpsPanel.vue` gained a second grouping mode — a small Urgency/Person toggle in the panel header (`q-btn-toggle`), per Peter's "follow-up by person" ask. Person mode groups alphabetically by name with a final "Unassigned" bucket for follow-ups with no identifiable person, and shows a small urgency pill per item (since grouping no longer conveys it in that mode); Urgency mode keeps the existing "with {person}" caption instead.

**Colored person tags (bonus ask):** new `dashboard/src/personColor.ts` deterministically hashes a person's display-name string to one of 8 palette colors, and `dashboard/src/components/PersonTag.vue` renders a small colored-dot + name chip. Applied everywhere a participant/follow-up person name appears: Follow-ups "with {person}" captions and by-person group headers, `MeetingsPanel.vue`'s participant list, and `MeetingDetail.vue`'s participant caption and follow-up rows (both the review checklist and the collapsed approved view). Since these hash the name string itself (not a person id — that's all the API surfaces at this display layer), the same name reads as the same color everywhere consistently.

**Meeting detail review columns:** suggestions are now sorted most-urgent-first (`sortByUrgency` in the new `dashboard/src/urgency.ts`, shared across `ActionItemsPanel.vue`/`FollowUpsPanel.vue`/`MeetingDetail.vue`) instead of whatever order Claude returned them in — applies to both the review checklist and the collapsed approved-items view. `sortByUrgency` returns a new array without touching item identity, so checkbox `v-model` bindings on the underlying `reactive()` objects are unaffected by the display reorder.

**Not backfilled:** meetings processed before this change have `urgency` missing entirely from their stored JSON (they only ever had `timing`) — `normalizeUrgency` treats that the same as any other invalid/missing value and defaults to "medium," so old approved items will show up under the Medium bucket until reprocessed. This mirrors exactly how the "today" timing value was left un-backfilled in Section 15's change earlier the same day.

**Verification:** `npx tsc --noEmit` (root) and `npx vue-tsc -b` (dashboard) both pass clean. `vite build` also compiles clean pointed at a scratch `outDir` (160 modules transformed, up from 154 — the two new `urgency.ts`/`personColor.ts` utils plus `PersonTag.vue`). No live browser click-through possible in this sandbox — worth checking on Peter's machine that the Urgency/Person toggle switches cleanly, that a fresh extraction actually produces varied urgency values (not everything defaulting to "medium"), and that person-tag colors read clearly against the dark theme.

**Follow-up same day:** Peter asked for Action Items specifically (not Follow-ups) to drop urgency ranking entirely — `ActionItemsPanel.vue` no longer groups by High/Medium/Low at all; it's now a flat list (API's natural newest-meeting-first order) with a small copy-to-clipboard button per row (`navigator.clipboard.writeText`, click uses `.stop.prevent` so it doesn't also trigger the row's link-to-meeting navigation). Scoped to the dashboard panel only, per Peter's choice — the meeting-detail review column still sorts Action Items suggestions by urgency during review. `urgency` is still stored/extracted for action items (used for Follow-ups' logic and the review column) — it's just no longer surfaced in this one panel.

**Two bugs found and fixed live the same day, both in `extractInsights.ts`:**

1. `(result.actionItems ?? []).map is not a function` — forced tool-use is supposed to guarantee Claude's response matches the JSON schema, but that's not a hard guarantee; hit live where `actionItems` came back as something other than an array, and `?? []` only guards `null`/`undefined`, not "defined but the wrong type." That crashed the *entire* extraction (losing keywords/takeaways/follow-ups too, not just the one bad field). Fixed with a `toArray()` helper that coerces defensively per-field (`Array.isArray` check, falls back to `[]` with a `console.warn` if not) so one malformed category can't take down the others.
2. **Root cause of a meeting getting 0 action items despite clearly having several:** Claude was never told which participant name is "the meeting owner" — the prompt only said "things the owner needs to do themselves" in the abstract, so when the owner (Peter) was also listed as a participant, Claude filed his own tasks as follow-ups attributed to him by name instead of as action items. Confirmed by querying the actual stored row: `action_items: []`, `follow_ups` full of items like "Work on the LLM prompt design..." tagged `"person": "Peter Drummond"`. Fixed by adding `ownerName: string` to `ExtractInsightsInput`, stating it explicitly in the user message ("Meeting owner: {name} — this is who Action Items are for..."), and strengthening the system prompt's distinguishing paragraph to say a task belonging to the owner always goes in Action Items even if the owner is also a listed participant. Both callers (`processMeeting.ts`, `regenerateCategory.ts`) now join `meetings.owner_id` → `users.name` to supply it. Also added real `minItems: 5, maxItems: 8` JSON-schema constraints on both `actionItems`/`followUps` arrays (previously only prose said "Exactly 5-8") as a structural backstop, not a replacement for the owner-name fix.

Neither bug is backfilled — a meeting already stuck with 0 action items (e.g. "TA Coaching Help Tool Touchbase," Jul 15) needs its "Reprocess meeting" button clicked to regenerate with the fix; this discards prior approvals on that meeting per the existing reprocess-confirmation dialog. `npx tsc --noEmit` and `npx vue-tsc -b` both pass clean after these changes.

**Architectural follow-up (same day, Peter's request):** the owner bug above happened because "who is the meeting owner" was resolved independently in two places (`processMeeting.ts`, `regenerateCategory.ts`), each doing its own `meetings.owner_id → users` join — exactly the kind of duplication that risks drifting out of sync again the moment a third consumer (e.g. a real email/chat notification sender, once a provider is chosen) needs the same answer and re-derives it its own way instead of reusing the existing logic. Consolidated into one place:

- `queries.ts` gained `getMeetingOwner(meetingId)` — the single source of truth for "who owns this meeting," now used by both `processMeeting.ts` and `regenerateCategory.ts` instead of each having its own inline join. Any future feature needing this (real email/chat senders included) should call this rather than re-deriving it.
- `queries.ts` also gained `getCurrentUser()` — resolves whoever `DEFAULT_OWNER_EMAIL` points at. Backs a new `GET /api/me` route (`app.ts`), which exists purely to make that existing implicit assumption *visible* rather than buried in an env var nothing surfaces — this is explicitly NOT real auth, still a personal-use POC with zero access control.
- Dashboard: `dashboard/src/api.ts` gained `fetchCurrentUser()`/`CurrentUser`, and `App.vue`'s sidebar now shows "Signed in as {name}" underneath the nav (fetched on mount, silently hidden if `/api/me` 404s rather than surfacing an error for something this minor).

This doesn't add multi-user support or real auth — it makes the current single-user assumption explicit and gives it exactly one code path, so the fix is a straightforward swap (not a rewrite) once Stage 4's hub integration (Section 8) replaces this with the hub's real session. `npx tsc --noEmit`, `npx vue-tsc -b`, and a scratch-`outDir` `vite build` all pass clean.
