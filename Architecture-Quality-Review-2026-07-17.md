# Good Wrap — Architecture & Code Quality Review (2026-07-17)

A read-only architecture pass plus a small set of behavior-preserving refactors, done separately from (and in addition to) the prior full security/correctness audit in `CODE-AUDIT.md` (2026-07-15). That audit already fixed everything critical and moderate; this review looks specifically at duplication, dead code, and structural quality, and only acts on items that carry zero risk of changing what the app does.

**Headline finding: this is not a large or badly-architected codebase.** It's a personal-scale POC — roughly 4,000 lines of backend TypeScript (`src/`, `db/`) plus a ~3,200-line Vue 3/Quasar dashboard that its own `package.json` describes as a temporary standalone POC meant to be rewritten into Peter's existing "hub" app later (see `Project-Handoff-Brief.md` §8). The things that might look like red flags from a generic "senior engineer audit" checklist — no auth, no pagination, no test suite, two separate npm projects instead of a monorepo, a throwaway frontend — are documented, deliberate decisions for this stage, not oversights. Nothing here proposes undoing any of them.

## 1. Architecture

Two independent npm projects, joined only by an HTTP API (no shared tooling, no workspaces):

- **Root (`/`)** — Node/TypeScript, run via `tsx` (no build step). **Fastify 5** HTTP API, **Drizzle ORM** over `postgres` (Supabase-hosted Postgres + pgvector, used purely as a database — no Supabase Auth/Edge Functions), **`@anthropic-ai/sdk`** for extraction/QA, **`fastembed`** for fully local embeddings (no external embeddings API/cost).
- **`dashboard/`** — Vue 3 + Quasar + Vite SPA, deployed separately (Vercel), proxying `/api` to the Fastify server (Railway).

### Data flow

Four capture entry points — manual JSON (`POST /api/meetings`), file upload (`POST /api/meetings/upload`), a local folder auto-scan (`scanFolder.ts`, launchd job every ~20 min), and a Zoom webhook (`POST /api/webhooks/zoom`) — all converge on one shared function, `captureManualMeeting()` (`src/ingest/captureManualMeeting.ts`). It resolves/creates `people` rows (email as the strong dedup key, case-insensitive name-only fallback), inserts `meetings`/`meeting_participants`/`transcripts` in one DB transaction, and does not itself call Claude or generate embeddings.

Processing (`src/pipeline/processMeeting.ts`) then: calls Claude once (forced tool-use, `extractInsights.ts`) for keywords/takeaways/action items/follow-ups together; chunks the transcript (`chunkText.ts`) and embeds each chunk locally (`embedChunks.ts`, BAAI/bge-small-en-v1.5 via fastembed); and idempotently replaces the meeting's `meeting_insights`/`transcript_chunks` rows in one transaction (safe to re-run). A bounded, non-throwing retry (`MAX_UNDERGENERATION_ATTEMPTS = 3`) guards specifically against Claude returning an empty `actionItems`/`followUps` array, on top of the generic exponential-backoff `withRetry` used at the HTTP-call layer.

Review is suggest-then-approve, per category: takeaways are auto-approved (exactly 5, no review UI); Action Items (the owner's own tasks) and Follow-ups (other people's) each get their own review column, their own `reviewed_at` timestamp, their own independent Save button, and fire their own one-time notification the first time that category is saved. Reprocessing merges newly-generated items forward against previously-approved ones rather than discarding approvals (`mergeApprovedForward.ts`).

Approved action items can be pushed to Asana on demand (`src/integrations/asana.ts`); the push is idempotent (checked via a stored `asanaTaskGid` before ever calling Asana). Notifications (`src/notify/`) are pluggable per channel — `dashboardFlag` is real (the `notifications_log` row itself is the flag), `email`/`chat` are stubs pending a provider decision.

Natural-language Q&A (`POST /api/ask`) and the person-history summary (`POST /api/people/:id/summary`) both do the same pgvector-similarity-search-then-ask-Claude-to-cite-sources pattern, one scoped to a specific person's meetings.

### Full API/DB surface

All routes are registered in one file, `src/server/app.ts` (no separate router). All DB access funnels through `src/server/queries.ts`. Schema (`db/schema.ts`): `users`, `people`, `meetings`, `meeting_participants`, `transcripts`, `transcript_chunks` (with a `vector(384)` pgvector column), `meeting_insights` (JSON-array columns for takeaways/action items/follow-ups, addressed by array index rather than a normalized child table), `notifications_log`.

## 2. What's already well-built (worth knowing so it doesn't get "fixed" by accident)

- **One shared capture path** for all four ingestion sources (`captureManualMeeting()`) — swapping or adding a source later doesn't require touching anything downstream.
- **N+1 avoided** in `listMeetings`/`getPersonDetail` via batched `inArray` fetches stitched together with in-memory `Map`s, not per-row queries.
- **Two-layer Zoom webhook idempotency** — an explicit pre-insert `SELECT` dedup check, backed by a DB-level partial unique index on `zoom_meeting_id` as a race-condition backstop.
- **Reprocess-safe merge-forward** (`mergeApprovedForward.ts`) — a prior real bug (reprocessing discarding approvals) fixed at the data layer, not just the UI.
- **Per-category `reviewed_at` split** — fixes a real notification-starvation bug that a single meeting-level flag couldn't represent once review became per-category.
- **`useReviewCategory.ts`** — an existing Vue composable that already eliminated one whole class of duplication (the review-state/dirty-tracking/save logic behind both review columns). This review extends the same idea one layer further (see §3.B below) rather than introducing a new pattern.
- **Centralized display formatting** — `reviewStatus.ts`, `urgency.ts`, `formatDate.ts`, `dateBuckets.ts`, `personColor.ts` are each single-purpose, reused, and documented with exactly which components share them. No duplication found here.
- **`getMeetingOwner()`/`getCurrentUser()` consolidation** (`queries.ts`) — added specifically after a real bug caused by two call sites independently re-deriving "who owns this meeting" and drifting apart. A good example of duplication being caught and fixed for a real reason, not speculatively.

## 3. Findings addressed in this pass

### A. Duplicated RAG retrieval scaffolding

`src/qa/askQuestion.ts` and `src/qa/personSummary.ts` independently implemented the same pgvector retrieval query (differing only by an optional `join meeting_participants ... where person_id = ...`), the same excerpt-formatting loop, and the same "extract cited meeting IDs → dedupe → build sources" logic.

**Fix:** extracted `src/qa/retrieveChunks.ts` (retrieval + excerpt formatting + cited-sources dedup, parameterized by an optional `personId`) and `callToolOnce()` in `src/util/claude.ts` (the one-shot forced-tool-use `messages.create` + unwrap shape both files shared). Each file kept its own tool schema, system prompt, and "no chunks found" message — the genuinely different parts.

### B. Duplicated async-mutation-handler wiring in the review columns

`MeetingActionItemsReview.vue` and `MeetingFollowUpsReview.vue` each hand-rolled ~5 near-identical async handlers (toggle-done, delete, save, regenerate, +send-to-asana) with the same try/catch/finally/loading-key/error/resync shape, differing only in which `api.ts` function was called and the toast copy.

**Fix:** added `useKeyedAsyncAction()` (`dashboard/src/composables/`), used once per button "kind" (matching the original one-ref-per-kind behavior exactly, so concurrent operations on different items still don't interfere). `onSave`/`onRegenerate`'s specific endpoint calls and toast copy stayed inline — only the boilerplate wiring moved.

### C. Duplicated participant-list editor markup

`CaptureForm.vue` and `MeetingEditDialog.vue` rendered an identical name/email row + remove button + "Add participant" loop.

**Fix:** extracted `ParticipantListEditor.vue` (`v-model` over a `{name, email}[]` array), with a `preventEmptyList` prop to preserve CaptureForm's original "keep at least one row" rule, which MeetingEditDialog never had.

### D. Confirmed-dead code

- `src/server/queries.ts` — removed a `.filter((t) => t.approved)` in `listMeetings` that could never remove anything (takeaways are unconditionally constructed with `approved: true`).
- `dashboard/src/api.ts` — removed the unused `keywords?: string[]` field from `SubmitReviewInput` (keywords are updated exclusively through the separate `updateMeetingInsights` path; grepped all callers to confirm nothing set it).
- `.env.example` — replaced a real email address with a placeholder.

## 4. Accepted risks — explicitly not touched in this pass

These are real, but fixing any of them changes observable behavior, not just code quality, so they're documented rather than acted on:

- **No auth, no request-body schema validation, no pagination** on any endpoint. Deliberate for a personal-use, single-user POC (`Project-Handoff-Brief.md`); each becomes a real requirement once this is reachable by more than Peter's own machine or the hub-integration (§8 of that doc) happens.
- **JSONB-array-as-column model for `action_items`/`follow_ups`** — every single-item mutation (done/delete/asana-push) reads the whole array, mutates by index in JS, and writes the whole array back. This is a genuine lost-update race under concurrent edits to the same meeting, though irrelevant at today's single-user scale. Worth revisiting (normalized child table, or at least an optimistic-concurrency check) before multi-user use.
- **Synchronous Claude + local-embedding work inside `POST /api/meetings`/`upload` request handlers.** Already has decoupled error handling (a processing failure doesn't lose the captured meeting), but the request stays open for however long Claude + fastembed take. Would need a real job queue if meeting volume or latency became a problem — the Zoom webhook path already had to solve this (reply 200 immediately, process detached) because Zoom's own timeout forced it.
- **No ESLint/Prettier config anywhere in the repo.** Worth adding for long-term maintainability, but introducing new tooling/dependencies is out of scope for a zero-behavior-change pass — flagged here as a follow-up, not done.

## 5. Verification

`npx tsc --noEmit` (repo root) and `npx vue-tsc -b` (`dashboard/`) both pass clean after every change above — the same "done" bar this codebase has used throughout its history. No test suite exists to run (none of this repo has one), and the sandbox this review ran in has no network route to `api.anthropic.com` or the Supabase pooler, so live end-to-end behavior (asking a question, toggling/deleting/saving/regenerating a review item, capturing/editing a meeting's participants) should get a quick manual click-through on Peter's own machine before this is considered fully verified.
