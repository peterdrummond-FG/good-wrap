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
