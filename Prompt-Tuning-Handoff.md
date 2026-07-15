**Update 2026-07-16 — resolved in-session, not in a new chat as originally planned:** Peter reviewed real generated output for a live meeting and confirmed action items/follow-ups were already good. The one change made: takeaways are no longer part of the approve/reject workflow — exactly 5 are generated, auto-approved, no "add your own" option, since Peter said selection wasn't needed for that category. Action items and follow-ups are unchanged (still 5-8, still reviewed/approved on the meeting detail page). `extractInsights.ts`'s prompt/schema, `queries.ts`'s `normalizeTakeaways`, `reviewMeeting.ts`, `api.ts`, and `MeetingDetail.vue` were all updated accordingly. The rest of this document (the original prompt text, design rationale, testing notes) is now historical — kept for reference but superseded by the current code.

---

# Extraction Prompt Handoff — Tuning for More Helpful Results

**Purpose of this doc:** Peter wants to tweak the Claude prompt that generates takeaways/action items/follow-up suggestions so the results are more helpful. This is the starting brief for that work in a new Cowork chat — it has the current prompt verbatim, how it's wired up, the design decisions behind it, and how to test a change.

---

## 1. Where this lives

All of it is in one file: **`src/pipeline/extractInsights.ts`**. This is Stage 2 of the pipeline — it runs right after a meeting is captured (or reprocessed), takes the transcript + metadata, and returns keywords/takeaways/action items/follow-ups.

It's called by `src/pipeline/processMeeting.ts`, which is called by `src/pipeline/runFullPipeline.ts`, which is what the dashboard's capture flow and "Reprocess meeting" button both trigger.

---

## 2. How it works, mechanically

One Claude API call per meeting, using **forced tool-use** (`tool_choice: { type: "tool", name: "record_meeting_insights" }`) rather than asking for JSON in prose. This guarantees the response is always well-formed structured data matching the schema below — no parsing/error-handling needed for malformed output.

Model: `claude-sonnet-5` by default, overridable via the `CLAUDE_MODEL` env var.

The four outputs it returns per call:
- **Keywords** — 5-10 free-text tags. Not part of the review workflow (see Section 4) — shown as-is, no approve/reject step.
- **Takeaways** — 5-8 candidate strings.
- **Action items** — 5-8 objects (`text`, `timing`) — things *the meeting owner* (Peter) needs to do himself.
- **Follow-ups** — 5-8 objects (`text`, `person` nullable, `timing`) — things *other people* need to do, or unconfirmed items worth a reminder.

After the API responds, the code stamps `approved: false` onto every takeaway/action item/follow-up itself (see the bottom of `extractInsights()`). The model never decides approval — that's a deliberate, purely human decision made later in the dashboard's review UI. Don't remove this stamping when tuning the prompt; it's separate from prompt quality.

---

## 3. The current prompt, verbatim

### System prompt

```
You extract structured notes from meeting transcripts, as a set of CANDIDATES for a human
reviewer to approve or discard — not a final, delivered summary. Ground every point in what
was actually said in the transcript — don't infer motivation, diagnose, or invent details not
present in the text. Distinguish action items (things the meeting owner needs to do
themselves) from follow-ups (things other people need to do, or unconfirmed items worth a
reminder) — don't put the same task in both categories. For each action item or follow-up,
only assign a timing (or, for follow-ups, a person) when the transcript actually supports it
— leave it null/"unspecified" rather than guessing. Since a human will filter the candidates
down to what's actually useful, always produce the requested 5-8 per category even if some
entries end up more marginal than others — under-generating is worse than over-generating here.
```

### User message (per call)

```
Meeting: {topic}
Meeting date: {meetingDate — ISO timestamp}
Participants: {comma-separated participant list}
Participant names (use exactly these for a follow-up's "person", or null): {participantNames}

Transcript:
{full transcript text}
```

`meetingDate` is passed in specifically so Claude has a "today" reference point to resolve relative language ("let's circle back next week") into the timing buckets. `participantNames` is the exact list from `meeting_participants` so a follow-up's `person` field can be attributed to a real name instead of the model inventing or mis-transcribing one.

### Tool schema field descriptions (these are read by the model as instructions, not just typing)

- **keywords**: "5-10 short topical keywords or phrases capturing what this meeting was about."
- **takeaways**: "Exactly 5-8 candidate takeaways for a human to review and pick from: decisions made or important context worth remembering. Each under ~25 words, grounded in what was actually said — no inferred motivation. If the meeting genuinely doesn't support 8 distinct points, it's fine for some to be more minor/marginal — the reviewer will discard the ones that aren't useful, so err on the side of including a plausible candidate rather than omitting it."
- **actionItems[].text**: "A task the meeting owner (not another attendee) appears to need to do themselves, grounded in the transcript."
- **actionItems[].timing**: "When this action item should happen, relative to the meeting date given below. Use \"unspecified\" unless the transcript actually gives a timing signal. Don't guess a timing that wasn't at least implied."
- **actionItems** (array-level): "Exactly 5-8 candidate action items for the meeting owner to review and pick from — things the owner themselves seems to need to do (as opposed to follow-ups, which are for other people or unconfirmed items). Same reviewer-will-filter guidance as takeaways: include plausible candidates even if some are minor."
- **followUps[].text**: "A thing to follow up on that's either someone else's task, or an unconfirmed item worth double-checking later — grounded in the transcript."
- **followUps[].person**: "Which attendee this follow-up is waiting on or should be discussed with next, if the transcript makes that clear. Must exactly match one of the provided participant names — null if no specific person is identifiable, or if it's an unconfirmed item rather than someone else's task."
- **followUps[].timing**: "When this follow-up should happen, relative to the meeting date given below. Use \"unspecified\" unless the transcript actually gives a timing signal (e.g. \"let's touch base tomorrow\" -> tomorrow; \"circle back next week\" -> next_week; \"sometime this week\" -> this_week). Don't guess a timing that wasn't at least implied."
- **followUps** (array-level): "Exactly 5-8 candidate follow-ups for a human to review and pick from — things other people need to do, or unconfirmed items worth a reminder. Same reviewer-will-filter guidance as takeaways/action items."

---

## 4. Design decisions worth knowing before changing anything

- **Suggest-then-approve, not final output.** Takeaways/action items/follow-ups are deliberately over-generated (5-8 each) as candidates — Peter picks which to keep on the meeting detail page. This is why the prompt explicitly says "under-generating is worse than over-generating" — a weak suggestion just gets left unchecked, but a missed real one never gets seen at all. Any prompt tweak should keep this framing unless Peter wants to change the fundamental approach (e.g. moving to a smaller, higher-precision set instead of a wide, filterable one).
- **Grounding is the main hallucination guard.** "Don't infer motivation, diagnose, or invent details" and "only assign timing/person when the transcript actually supports it" are there because this is a personal record of real meetings — a plausible-sounding but wrong item is worse than a missing one.
- **Action items vs. follow-ups is Peter's own framing**, not an arbitrary category split: action items are what *he* needs to do; follow-ups are what *other people* need to do, or things that are still unconfirmed. Keep this distinction sharp if editing the prompt — the two schema fields' descriptions cross-reference each other for exactly this reason.
- **Keywords are out of scope for this tuning pass** (per Peter's earlier call) — they don't go through the approve/reject workflow, so they may not need the same treatment as the other three.
- The exact 5-8 range is hardcoded into both the schema descriptions and the system prompt. If Peter wants a different count (e.g. always exactly 6, or a range that scales with transcript length), both places need updating together.

---

## 5. How to test a prompt change

**Known limitation:** a Cowork sandbox session cannot reach `api.anthropic.com` directly (confirmed 2026-07-16 — DNS resolution fails, it's a network allowlist restriction). Testing a real prompt change against the live Claude API has to happen either via the Supabase MCP connector's own tools (which don't cover this), or — most reliably — on Peter's own machine.

To test on Peter's machine:
```
cd "good-wrap"
npm run process -- <meetingId>   # re-runs Stage 2 only for one meeting, prints the new insights_id
```
or reprocess from the dashboard (`npm run api` + `npm run dev` in `dashboard/`, then click "Reprocess meeting" on a meeting's detail page). Reprocessing is idempotent — it replaces that meeting's prior suggestions rather than duplicating them, so it's safe to iterate on the prompt and re-run against the same meeting repeatedly.

Meetings already in the database to test against (topics, as of 2026-07-16):
- "Teamalytics AI Team Checkin" — long, substantive, good test for a meeting with plenty of real signal.
- A short test/dashboard-layout meeting — good test for a low-signal meeting (checks whether the "5-8 even if marginal" instruction produces obviously weak filler on a thin transcript).
- An LLM-model-comparison meeting and a task-management-brainstorm meeting — two more mid-length real meetings for variety.

(Exact meeting IDs weren't recorded here since they're visible directly in the dashboard's meeting list — no need to hunt for UUIDs.)

---

## 6. Open questions for the next session

Peter said he wants "more helpful results" but hasn't specified what's currently falling short. Worth clarifying at the start of the next chat:
- Are current suggestions too generic/vague, too verbose, or focused on the wrong things?
- Is the issue more with takeaways, action items, or follow-ups specifically — or all three?
- Does Peter want fewer, higher-precision suggestions instead of the current wide-net 5-8 approach?
- Would concrete examples (few-shot) of a "good" vs. "bad" suggestion help steer style/tone?
- Any preference on suggestion length, phrasing style, or level of detail?
