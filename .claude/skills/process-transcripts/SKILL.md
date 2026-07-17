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

1. Run `npm run scan-folder -- list`. This prints a JSON array of candidate
   filenames. If it's empty, say so and stop — nothing to do.

2. Fetch context you'll need for insight generation, once per run (not per
   file):
   - `curl -s "$GOODWRAP_API_BASE_URL/api/me"` → the owner's name. Action
     items are THIS person's own tasks; follow-ups are never attributed to
     them.
   - `curl -s "$GOODWRAP_API_BASE_URL/api/people"` → known contacts from past
     meetings, for attributing a follow-up to someone mentioned but not
     present in the current meeting.

3. For each candidate filename, one at a time:

   a. Run `npm run scan-folder -- claim "<filename>"`. This locks the file
      and prints `{ "rawText": "...", "parsed": {...} | null }`.
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

   c. POST the result:
      ```
      curl -s -X POST "$GOODWRAP_API_BASE_URL/api/meetings/upload-processed" \
        -H "Content-Type: application/json" \
        -H "x-worker-key: $LOCAL_WORKER_API_KEY" \
        -d '{"topic": "...", "startTime": "...", "durationMinutes": ..., "participants": [...], "transcript": "...", "insights": {"keywords": [...], "takeaways": [{"text": "..."}], "actionItems": [{"text": "...", "urgency": "..."}], "followUps": [{"text": "...", "person": null, "urgency": "..."}]}}'
      ```
      (`takeaways`/`actionItems`/`followUps` entries take no `approved`
      field — the server stamps that itself.)

   d. On a `2xx` response: `npm run scan-folder -- finish "<filename>" processed`.
      On any failure (claim error, malformed transcript, non-2xx response):
      `npm run scan-folder -- finish "<filename>" failed --error "<what went wrong>"`.

4. Report a one-line summary: how many processed, how many failed and why.
