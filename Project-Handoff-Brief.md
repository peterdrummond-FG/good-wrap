# Meeting Intelligence System — Project Handoff Brief

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
| Database/backend host | Supabase, used as a plain Postgres + pgvector database — no Supabase Auth or Edge Functions; a custom backend still owns auth, ingestion, and Claude API calls |

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

### Stage 4 — Dashboard

Vue.js + Quasar frontend: meeting list, per-meeting takeaways view, filtering by date/participant, and the Stage 0 manual-entry form lives here.

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
- Hosting choice for the backend/frontend (Vercel, Netlify, other)?
- Auth approach for the dashboard (even single-user, needs at least a login gate)?

Surface these to Peter when you reach the stage where they matter — no need to resolve them all upfront.

---

## 7. Immediate Next Step

Start with **Stage 1 (schema)** and **Stage 0 (manual capture form)** together, since Stage 0 needs somewhere to write to. Confirm the schema with Peter before running migrations, then build the manual-entry flow and processing pipeline (Stage 2) so there's an end-to-end path — paste a transcript in, see takeaways come out — before building the full dashboard around it.
