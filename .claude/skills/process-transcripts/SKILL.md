---
name: process-transcripts
description: Scan the local transcript watch folder (TRANSCRIPT_WATCH_DIR), generate meeting insights yourself for each new .txt file, and upload the raw transcript + insights to Good Wrap. Use when asked to "process transcripts", "scan the folder", "run the folder scan", or when invoked headlessly by the scan-folder launchd job.
---

# Process transcripts

This replaces the old `scanFolder.ts` behavior of calling the Anthropic API
(`extractInsights.ts`) to generate meeting insights. Instead, **you** read
each transcript and generate the insights yourself, right here in this
session — that's the whole point: it moves this cost from the
`ANTHROPIC_API_KEY` billed API to your own Claude Code session/plan usage.
Everything else about the pipeline (chunking, embeddings, DB writes, the
review UI) is unchanged.

Run from the repo root (`good-wrap/`). Requires `TRANSCRIPT_WATCH_DIR`,
`GOODWRAP_API_BASE_URL`, and `LOCAL_WORKER_API_KEY` to be set in `.env` (see
`.env.example`).

## Steps

0. Read `GOODWRAP_API_BASE_URL` and `LOCAL_WORKER_API_KEY` yourself from the
   `.env` file (e.g. `grep '^GOODWRAP_API_BASE_URL=' .env` /
   `grep '^LOCAL_WORKER_API_KEY=' .env`, each followed by `cut -d= -f2-`) and
   use those literal values directly in every curl call below. Don't rely on
   `$GOODWRAP_API_BASE_URL`/`$LOCAL_WORKER_API_KEY` already being set as
   shell environment variables — when this skill runs headlessly via the
   launchd job, nothing exports `.env` into that process's shell, so those
   would be empty (`npm run scan-folder`'s own subcommands don't have this
   problem — they load `.env` themselves via `dotenv/config`, transitively
   imported through `src/db/client.ts`).

1. Run `npm run scan-folder -- pull-zoom`. This checks for any Zoom
   transcripts staged by the webhook handler (a meeting whose recording
   finished and whose transcript is ready) and writes each one as a `.txt`
   into the watch folder — same as if Peter had dropped it in by hand. Prints
   `{ "written": [filenames] }`.
   - If it fails outright (network error, missing env var, non-2xx
     response), note the failure in your final summary (step 6) but continue
     to the next steps regardless — a Zoom-pull hiccup must never block
     processing files already sitting in the folder.
   - An empty `written` array is normal (nothing new from Zoom this run), not
     an error.

2. Run `npm run scan-folder -- reconcile`. This un-claims any `.processing/`
   file whose claim has gone stale (a previous run died mid-file — a Claude
   usage session-limit hit or a network drop, both real failure modes seen
   in practice) by moving it back to the top-level watch folder, so the next
   step picks it up as a fresh candidate. It's always safe to re-process an
   unclaimed file this way, even if the dead run's upload had actually
   already succeeded before it crashed — the `sourceKey`/`zoomMeetingId`
   dedup checks in step 5c below turn a re-upload into a no-op instead of a
   duplicate meeting. Prints `{ unclaimed: [{filename, staleForMs}], failedCount }`.
   Note any `unclaimed` filenames and the `failedCount` (files already
   sitting in `failed/`, awaiting Peter's manual fix) for your final summary
   in step 6.

3. Run `npm run scan-folder -- list`. This prints a JSON array of candidate
   filenames. If it's empty, say so and stop — nothing to do (but still
   report the reconcile/failed counts from step 2 if either was nonzero).

4. Fetch context you'll need for insight generation, once per run (not per
   file), using the base URL from step 0:
   - `curl -s "<GOODWRAP_API_BASE_URL>/api/me"` → the owner's name. Action
     items are THIS person's own tasks; follow-ups are never attributed to
     them.
   - `curl -s "<GOODWRAP_API_BASE_URL>/api/people"` → known contacts from past
     meetings, for attributing a follow-up to someone mentioned but not
     present in the current meeting.
   - `curl -s "<GOODWRAP_API_BASE_URL>/api/companies"` → every known Flippen
     Group company (including "Flippen Group" itself, `isInternal: true`),
     each with a `slug`, `name`, and `aliases` — for classifying which
     company each meeting is about (see the **company** rule below).

5. For each candidate filename, one at a time:

   a. Run `npm run scan-folder -- claim "<filename>"`. This locks the file
      and prints `{ "rawText": "...", "parsed": {...} | null, "sourceKey": "..." }`.
      - If `parsed` is non-null, it already has `topic`, `startTime`,
        `durationMinutes`, `participants` (Peter's fixed export format was
        matched — trust these values, don't second-guess them).
      - If `parsed` is `null`, the file doesn't match that fixed format.
        Read `rawText` yourself and infer `topic` (a short title),
        `startTime` (ISO timestamp — use the file's own content if it states
        a date, otherwise use now), and `participants` (array of
        `{"name": "..."}`) directly. Do not call any external API for this —
        just read the text.
      - The transcript body to store is `parsed.transcript` when `parsed` is
        non-null, otherwise the full `rawText`.
      - `sourceKey` is already computed for you (a deterministic hash of
        `rawText`) — carry it through unchanged into the upload payload in
        step (c) below. Don't recompute or alter it.
      - If `parsed.zoomUuid` is present, this file came from the `pull-zoom`
        step — carry it through unchanged as `zoomMeetingId` in the upload
        payload in step (c) below (omit the field entirely otherwise).
      - If `parsed.hostEmail` is present (also only for a Zoom-pulled file,
        whose PARTICIPANTS section is intentionally empty), use
        `participants: [{"email": "<parsed.hostEmail>"}]` in step (c)'s
        payload instead of `parsed.participants` — this gets a real matched
        `people` row by email rather than a bare name string.

   b. Generate the 4 categories from the transcript body, following these
      rules exactly (same bar as the API-based path used for every other
      capture method):

      - **keywords**: 5-10 short topical keywords/phrases capturing what the
        meeting was about.
      - **takeaways**: exactly 5 FINAL decisions or important context, shown
        to the user directly with no further filtering — pick the 5 that
        genuinely matter most; don't pad to 5 with marginal ones if fewer
        clearly stand out. Each under ~25 words, grounded in what was
        actually said.
      - **actionItems**: 5-8 CANDIDATE tasks for the MEETING OWNER
        (from `/api/me`) to do themselves — a human reviews these
        afterward. Real transcripts rarely state these as clean, formal task
        language — look specifically for the owner's casual first-person
        commitments: "I'll look into...", "I will work on...", "I'm going
        to...", "let me...", "I need to...", or a hedged, in-progress update
        like "I already started spitballing some ideas on that". The owner
        may also accept/confirm a task someone else hands them — that
        counts too, even if their reply doesn't restate the full task. Each
        item: `{text, urgency}`.
      - **followUps**: 5-8 CANDIDATE things any OTHER participant needs to
        do, or unconfirmed items worth a reminder. NEVER the meeting owner's
        own task, even one they mention offhand — that belongs in
        actionItems. A follow-up's task can belong to someone who wasn't in
        the meeting at all (e.g. "we need to check with Ray about X") — see
        the person rule below. Each item: `{text, person, urgency}`.
      - **urgency** (actionItems and followUps): `"high"`/`"medium"`/`"low"`
        based on genuine signals in the transcript. Default to `"medium"`
        rather than forcing high/low without real support. `"high"` only for
        genuinely urgent/blocking/time-critical language ("urgent", "ASAP",
        "critical", "blocker"). `"low"` only for explicitly low-priority
        language ("no rush", "whenever", "nice to have").
      - **person** (followUps only): a meeting participant's exact name, OR
        — if the transcript mentions someone who wasn't in the meeting
        needing follow-up — match them against the known-contacts list from
        `/api/people` (even a first-name-only mention) and use their exact
        full name from that list. Use `null` if there's no clear,
        unambiguous match, if it's ambiguous, or if it's an unconfirmed item
        rather than someone's task. Never invent a name not in either list.
        Never assign the owner as the person.
      - Before finalizing, re-read actionItems and followUps side by side:
        anything about the owner's OWN work belongs in actionItems, not
        followUps, and shouldn't appear in both. If actionItems looks thin,
        that's a sign to look harder for the owner's first-person language,
        not a sign they have nothing to do — always aim for the full 5-8 in
        both actionItems and followUps; under-generating is worse than
        over-generating for these two categories (not for takeaways, which
        stays exactly 5).
      - **company**: which ONE of the companies from `/api/companies` (step
        4) this meeting is actually about — use its `slug`. Match on the
        company's `name`, its `aliases`, attendee affiliations, or clear
        subject-matter context (e.g. product/program names unique to one
        company), not just a passing one-word mention. If the meeting is
        Flippen Group's own internal business (not about running any one
        portfolio company specifically), use whichever entry has
        `isInternal: true`. Use `"unknown"` only when the transcript
        genuinely gives no usable signal either way — prefer a genuine best
        guess over defaulting to unknown. This never overrides a company
        Peter has already set by hand on the meeting detail page (the
        server enforces that, not this skill).

   c. POST the result (using the literal base URL and key read in step 0,
      not shell variable references):
      ```
      curl -s -X POST "<GOODWRAP_API_BASE_URL>/api/meetings/upload-processed" \
        -H "Content-Type: application/json" \
        -H "x-worker-key: <LOCAL_WORKER_API_KEY>" \
        -d '{"topic": "...", "startTime": "...", "durationMinutes": ..., "participants": [...], "transcript": "...", "insights": {"keywords": [...], "takeaways": [{"text": "..."}], "actionItems": [{"text": "...", "urgency": "..."}], "followUps": [{"text": "...", "person": null, "urgency": "..."}], "company": "some-slug-or-unknown"}, "sourceKey": "<value from claim>", "zoomMeetingId": "<parsed.zoomUuid, only if present>"}'
      ```
      (`takeaways`/`actionItems`/`followUps` entries take no `approved`
      field — the server stamps that itself. Omit `zoomMeetingId` entirely
      when `parsed.zoomUuid` wasn't present.) Write the JSON body to a temp
      file first (e.g. `/tmp/upload-payload.json`) and POST with `-d
      @/tmp/upload-payload.json` rather than inlining a large transcript
      directly on the command line.

      If the response includes `"alreadyCaptured": true`, this was a safe
      no-op — the meeting already existed from a prior run's upload that
      succeeded before that run crashed (see step 2), or (for a Zoom file)
      was already captured under its `zoomMeetingId`. Note it in your
      summary as "confirmed" rather than "created", but treat it the same as
      any other 2xx response for the `finish` step below.

   d. On a `2xx` response: `npm run scan-folder -- finish "<filename>" processed --date "<startTime>"`,
      using the exact same `startTime` value already sent in the upload
      payload — this files the archived transcript under the *meeting's*
      own date, not whatever day the batch happened to run, so a backlog of
      differently-dated meetings processed in one sitting still lands in
      the right week folders. (If `startTime` isn't available for some
      reason, omit `--date` — `finish` falls back to the file's own
      modification time.)
      On any failure (claim error, malformed transcript, non-2xx response):
      `npm run scan-folder -- finish "<filename>" failed --error "<what went wrong>"`
      (no `--date` here — `failed/` stays flat).

6. Report a one-line summary: how many Zoom transcripts were pulled in step 1
   (or that the pull failed/Zoom wasn't connected), how many processed, how
   many failed and why, how many were reconciled/retried in step 2 (and of
   those, how many turned out to be `alreadyCaptured` no-ops vs. freshly
   created), and the `failedCount` from step 2.
