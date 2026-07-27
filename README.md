# Good Wrap

A personal meeting-intelligence system. It captures meeting transcripts (Zoom, manual upload, or a local watch folder), has Claude extract keywords, takeaways, action items, and follow-ups, stores everything in Postgres with local embeddings for semantic search, and surfaces it through a Vue dashboard — with per-user login, Zoom/Asana OAuth, and Asana task push built in.

Built personal-first for Peter Drummond at Flippen Group, but the data model normalizes identities and ownership from day one rather than hard-coding a single-user assumption.

## What it does

- **Capture** a meeting via manual entry, file upload, a local folder auto-scan, or a Zoom webhook (`recording.transcript_completed`) — all four converge on one shared capture path.
- **Extract** keywords, 5 takeaways, and 5–8 candidate action items/follow-ups per meeting via Claude, using forced tool-use for a reliable shape.
- **Review, suggest-then-approve**: takeaways auto-approve; action items (your own tasks) and follow-ups (other people's) each get their own review column and save independently.
- **Search semantically** across every transcript via local embeddings (no external embeddings API) — ask natural-language questions and get an answer with the source meeting cited.
- **Tag meetings by company** (Flippen Group's own portfolio companies, plus any vendor/company an admin adds) — Claude classifies from transcript content, defaulting to Uncategorized rather than guessing when unsure; always correctable by hand.
- **Push action items to Asana** on demand, idempotently, with per-user OAuth (falls back to a shared token if you haven't connected your own account) — and undo it (deletes the real Asana task, not just the local link).
- **Per-user login** via Supabase Auth (Google/Microsoft SSO), admin-invited teammates, and per-user Zoom/Asana connections so integration actions are attributed to the right person.

## Architecture

Two independent projects, joined only by an HTTP API:

- **Root (`/`)** — Node/TypeScript, run via `tsx` (no build step). Fastify HTTP API, Drizzle ORM over Postgres (Supabase-hosted, used purely as a database — no Supabase Edge Functions), `@anthropic-ai/sdk` for extraction/Q&A, `fastembed` for fully local embeddings.
- **`dashboard/`** — Vue 3 + Quasar + Vite SPA.

Deployed as: API on Railway, dashboard on Vercel, database on Supabase. Locally, the dashboard's dev server (`:5173`) proxies `/api` to the Fastify server (`:4000`) — see `dashboard/vite.config.ts` and `.claude/launch.json`.

For a much deeper architectural walkthrough (data flow, full route/table surface, known rough edges), see `Architecture-Quality-Review-2026-07-17.md` and `CODE-AUDIT.md`. `Project-Handoff-Brief.md` has the original planning brief and a running history of every stage as it was built.

## Repo layout

```
src/
  ingest/        capture entry points (manual, upload, Zoom webhook, folder scan) — all funnel through captureManualMeeting()
  pipeline/      Claude extraction, chunking/embedding, insight review & merge-forward on reprocess
  qa/            natural-language Q&A and per-person history summaries (pgvector similarity search + Claude)
  notify/        pluggable notification channels (dashboardFlag is real; email/chat are stubs)
  integrations/  Zoom, Asana, and per-user OAuth (src/integrations/oauth/)
  server/        Fastify app (all routes in app.ts), queries.ts (all DB access), auth.ts
db/
  schema.ts      Drizzle schema — source of truth for every table
dashboard/       Vue 3 + Quasar + Vite SPA (separate npm project, own package.json)
.claude/skills/process-transcripts/
                 local Claude Code skill that generates insights for folder-scanned transcripts
                 itself (billed to your Claude Code plan) instead of the paid Anthropic API
scripts/         the local transcript watch-folder automation — see below
```

## Getting started locally

1. `npm install` at the repo root, then `cd dashboard && npm install`.
2. `cp .env.example .env` and fill in real values — every variable is documented in place (Supabase connection info, Anthropic API key, Zoom/Asana OAuth apps, etc.). The schema in `db/schema.ts` is applied directly against the Supabase project rather than through `drizzle-kit` migrations so far (see `drizzle.config.ts`'s own comment).
3. Start the API: `npm run api` (Fastify on `:4000`, watches for changes).
4. Start the dashboard: `cd dashboard && npm run dev` (Vite on `:5173`, proxies `/api` to `:4000`).

Both are also wired up in `.claude/launch.json` if you're driving this from Claude Code's preview tools.

## The local transcript watch folder

`TRANSCRIPT_WATCH_DIR` (see `.env.example`) is a folder on your own Mac — drop a `.txt` transcript in, and it gets picked up, processed, and archived under `processed/<year>/week-<n>/`. The actual scanning/claiming/archiving mechanics are deterministic code (`src/ingest/scanFolder.ts`, exposed via `npm run scan-folder -- <list|claim|finish|reconcile|pull-zoom>`); insight generation runs through a local Claude Code session invoking the `.claude/skills/process-transcripts/SKILL.md` skill, not the billed API.

**This runs on a recurring loop inside a real Terminal window, not as a silent background daemon.** That's a deliberate choice, not a simplification: a macOS `launchd`-based background job was the original approach, but extensive testing (2026-07-23) found that launchd-spawned headless processes on this Mac have flaky, intermittent access to files under `~/Documents` — repeated `getcwd: cannot access parent directories: Operation not permitted` crashes, inconsistent even after granting the relevant binaries Full Disk Access — while the identical command run inside an interactive Terminal session worked every single time, with no exceptions. Rather than keep fighting that, the mechanism is:

- `scripts/scan-folder-job.sh` — one scan-and-process pass (runs the skill, then independently re-verifies the watch folder's real state afterward and logs an unambiguous `ALERT`/`OK` line — the skill's own free-text summary isn't trusted as the signal of whether work actually happened, since past runs have narrated things that weren't true).
- `scripts/scan-folder-loop.sh` — loops that job every 20 minutes, forever, meant to run inside a Terminal window you leave open (minimized is fine; closing it stops the loop).
- `scripts/scan-folder-terminal-launcher.applescript` — source for `~/Applications/GoodWrapScanFolder.app` (compiled with `osacompile`), a login item that opens Terminal and starts the loop automatically when you log in. Registered via `osascript`; removable from System Settings → General → Login Items & Extensions.

Logs land in `logs/scan-folder.log` — `grep ALERT` on it to find a run that didn't actually finish cleanly.

## Further reading

- `Project-Handoff-Brief.md` — the original planning brief and a running history of every build stage
- `Architecture-Quality-Review-2026-07-17.md` / `CODE-AUDIT.md` — deeper architecture and code-quality passes
- `Prompt-Tuning-Handoff.md` — notes on tuning Claude's extraction/classification prompts
