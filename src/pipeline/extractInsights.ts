// Stage 2: Claude extraction — keywords, takeaways, action items, follow-ups.
//
// Uses forced tool-use (tool_choice) rather than asking Claude to return JSON
// in prose, so the output is always well-formed and doesn't need a
// hand-rolled JSON parser with error handling for malformed responses.
//
// STRUCTURE (reworked 2026-07-16, then reverted the same day): action items
// kept coming back empty — confirmed by 3 identical-input attempts all
// returning 0 — while follow-ups (bundled in the same call) reliably
// succeeded. First fix split action items into their own separate Claude
// call. On reflection (Peter pushed back — right call) that conflated two
// changes at once: the split AND materially stronger action-item wording,
// so there was never a clean test of whether the split itself was necessary
// versus the wording alone being enough. Splitting three ways (one call per
// category) would have been worse — follow-ups and takeaways have never
// once failed, so isolating them has no evidence behind it, only cost.
//
// Reverted to ONE combined call, keeping the stronger action-item wording
// plus an explicit self-check instruction (re-read actionItems vs followUps
// before finalizing; treat a thin actionItems list as a signal to look
// harder, not as a real answer) and the non-throwing under-generation retry
// below. If this single-call version still comes back with empty action
// items on real transcripts, THAT would be actual evidence the split is
// needed — not before.

import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "../util/env";
import { withRetry } from "../util/retry";
import type { ActionItem, FollowUpItem, SuggestionItem } from "../../db/schema";

export interface ExtractInsightsInput {
  topic: string;
  participants: string;
  transcript: string;
  // ISO timestamp of the meeting itself — general grounding context so
  // Claude knows when "today"/"this week" language in the transcript is
  // relative to.
  meetingDate: string;
  // Attendee names as recorded in the DB (see meeting_participants), so
  // Claude can attribute a follow-up to an actual participant rather than
  // inventing or mis-transcribing a name.
  participantNames: string[];
  // The meetings.owner_id user's name (see db/schema.ts) — i.e. who "Action
  // Items" are for. Added 2026-07-16 after a live bug: without this, Claude
  // has no way to know which participant name is "the meeting owner" from
  // an abstract "things the owner needs to do themselves" phrasing, so it
  // defaulted to filing the owner's own tasks as follow-ups attributed to
  // them by name instead of as action items.
  ownerName: string;
}

// Action items/follow-ups are suggest-then-approve (2026-07-16) — Claude
// proposes 5-8 candidates per category and Peter picks which to keep on the
// meeting detail page, so those come back with approved: false; nothing is
// pre-approved by the model there.
//
// Takeaways are NOT part of that workflow (changed 2026-07-16, per Peter:
// "no need to select takeaways — what's being generated is good enough") —
// exactly 5 are generated and all come back approved: true, no review step.
// They keep the same {text, approved} shape as before purely so the rest of
// the codebase (DB column, notification payload, etc.) doesn't need a
// separate type — approved is just always true for this category now.
export interface ExtractInsightsResult {
  keywords: string[];
  takeaways: SuggestionItem[];
  actionItems: ActionItem[];
  followUps: FollowUpItem[];
}

// Raw shapes Claude's tool call returns, before `approved: false` is stamped
// onto every action item/follow-up by this module.
type RawActionItem = { text: string; urgency: FollowUpItem["urgency"] };
type RawFollowUp = { text: string; person: string | null; urgency: FollowUpItem["urgency"] };

interface RawExtractionResult {
  keywords?: string[];
  takeaways?: string[];
  actionItems?: RawActionItem[];
  followUps?: RawFollowUp[];
}

// Shared urgency schema fragment — identical for action items and follow-ups.
const URGENCY_PROPERTY = {
  type: "string" as const,
  enum: ["high", "medium", "low"],
  description:
    "How urgent this is, independent of when it might happen. Use \"high\" only for genuinely " +
    "urgent/blocking/time-critical items (explicit language like \"urgent\", \"ASAP\", " +
    "\"critical\", \"blocker\", or clear high-stakes framing). Use \"low\" for explicitly " +
    "low-priority items (\"no rush\", \"whenever\", \"nice to have\"). Use \"medium\" as the " +
    "default for everything else — don't force high or low without a real signal.",
};

const RECORD_INSIGHTS_TOOL: Anthropic.Tool = {
  name: "record_meeting_notes",
  description:
    "Record the extracted keywords, takeaways, action items, and follow-ups for this meeting " +
    "transcript.",
  input_schema: {
    type: "object",
    properties: {
      keywords: {
        type: "array",
        items: { type: "string" },
        description:
          "5-10 short topical keywords or phrases capturing what this meeting was about.",
      },
      takeaways: {
        type: "array",
        items: { type: "string" },
        description:
          "Exactly 5 takeaways: the decisions made or important context most worth remembering " +
          "from this meeting. Each under ~25 words, grounded in what was actually said — no " +
          "inferred motivation. These are shown directly with no human filtering step " +
          "afterward, so pick the 5 that genuinely matter most rather than padding out to 5 " +
          "with marginal ones.",
      },
      actionItems: {
        type: "array",
        minItems: 5,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "A task the meeting owner appears to need to do themselves, grounded in the " +
                "transcript.",
            },
            urgency: URGENCY_PROPERTY,
          },
          required: ["text", "urgency"],
        },
        description:
          "5-8 candidate action items for the MEETING OWNER (named in the user message) to " +
          "review and pick from — their own tasks only, never someone else's. See the system " +
          "prompt for how to spot these in casual speech.",
      },
      followUps: {
        type: "array",
        minItems: 5,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "A thing to follow up on that's either someone else's task, or an unconfirmed " +
                "item worth double-checking later — grounded in the transcript. Never the " +
                "meeting owner's own task — those belong in actionItems instead.",
            },
            person: {
              type: ["string", "null"],
              description:
                "Which attendee this follow-up is waiting on or should be discussed with next, if " +
                "the transcript makes that clear. Must exactly match one of the provided " +
                "participant names, and must NEVER be the meeting owner — null if no specific " +
                "person is identifiable, or if it's an unconfirmed item rather than someone else's " +
                "task.",
            },
            urgency: URGENCY_PROPERTY,
          },
          required: ["text", "person", "urgency"],
        },
        description:
          "5-8 candidate follow-ups for a human to review and pick from — things other people " +
          "need to do, or unconfirmed items worth a reminder.",
      },
    },
    required: ["keywords", "takeaways", "actionItems", "followUps"],
  },
};

const SYSTEM_PROMPT =
  "You extract structured notes from a meeting transcript. Ground every point in what was " +
  "actually said — don't infer motivation, diagnose, or invent details not present in the " +
  "text. The user message names the meeting owner.\n\n" +
  "Four categories, each with its own rule:\n" +
  "- keywords: 5-10 short topical keywords or phrases capturing what this meeting was about.\n" +
  "- takeaways: exactly 5 FINAL decisions or important context, shown to the user directly with " +
  "no further filtering afterward — pick the 5 that genuinely matter most; don't pad out to 5 " +
  "with marginal ones if fewer than 5 clearly stand out.\n" +
  "- actionItems: 5-8 CANDIDATE tasks for the MEETING OWNER to do themselves, for a human " +
  "reviewer to approve or discard afterward. Real transcripts rarely state these as clean, " +
  "formal task language — look specifically for the owner's casual first-person commitments: " +
  "phrases like \"I'll look into...\", \"I will work on...\", \"I'm going to...\", \"let me...\", " +
  "\"I need to...\", or even a hedged, in-progress-sounding update like \"I already started " +
  "spitballing some ideas on that\" or \"I'm in the middle of...\". The owner may also be given a " +
  "task by someone else in the room that they then accept, confirm, or start describing — " +
  "that's an action item too, even if their own reply doesn't repeat the task in full.\n" +
  "- followUps: 5-8 CANDIDATE things any OTHER participant needs to do, or unconfirmed items " +
  "worth a reminder, for the same human reviewer. NEVER the meeting owner's own task, even one " +
  "the owner mentions offhand — that belongs in actionItems, not here.\n\n" +
  "For actionItems and followUps, assign urgency based on genuine signals in the transcript — " +
  "default to \"medium\" rather than forcing \"high\" or \"low\" without real support. For " +
  "followUps, only assign a person when the transcript actually supports it — leave it null " +
  "rather than guessing, and never assign the owner as the person.\n\n" +
  "Before finalizing, re-read your actionItems and followUps side by side as a cross-check: " +
  "anything about the owner's OWN work belongs in actionItems, not followUps, and should not " +
  "appear in both. If actionItems looks thin or empty, treat that as a sign you scanned too " +
  "narrowly rather than as a sign the owner genuinely has nothing to do — go back through the " +
  "transcript specifically for the owner's first-person language before settling on a short " +
  "list. actionItems and followUps are candidates, not a final list — always produce the " +
  "requested 5-8 for each even if some entries end up more marginal than others; " +
  "under-generating is worse than over-generating for these two categories (not for takeaways).";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return client;
}

// Forced tool-use is supposed to guarantee the declared shape, but it's not
// a hard guarantee — hit live (2026-07-16) where Claude returned a field as
// something other than an array, and `?? []` only guards against
// null/undefined, not "defined but the wrong type". Coerce defensively so
// one malformed field can't crash the whole call.
function toArray<T>(value: unknown, label: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== undefined) {
    console.warn(`extractInsights: expected an array for "${label}", got`, value);
  }
  return [];
}

// Bounded retry specifically for under-generation (actionItems and/or
// followUps coming back empty despite the prompt asking for 5-8) — separate
// from withRetry's hard-failure retries below. Reworked 2026-07-16 after a
// real bug: an earlier version THREW after exhausting retries, which meant
// one thin category failed the entire call (losing everything else it got
// right, including categories that succeeded). This always resolves — if
// still empty after MAX attempts, it logs a warning and the caller proceeds
// with whatever it has rather than failing anything.
const MAX_UNDERGENERATION_ATTEMPTS = 3;

async function callExtraction(input: ExtractInsightsInput, model: string): Promise<ExtractInsightsResult> {
  return withRetry(
    async () => {
      const message = await getClient().messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [RECORD_INSIGHTS_TOOL],
        tool_choice: { type: "tool", name: "record_meeting_notes" },
        messages: [
          {
            role: "user",
            content:
              `Meeting: ${input.topic}\n` +
              `Meeting date: ${input.meetingDate}\n` +
              `Participants: ${input.participants}\n` +
              `Meeting owner (find THIS person's action items, and never attribute a follow-up ` +
              `to them): ${input.ownerName}\n` +
              `Participant names (use exactly these for a follow-up's "person", or null): ` +
              `${input.participantNames.join(", ") || "(none recorded)"}\n\n` +
              `Transcript:\n${input.transcript}`,
          },
        ],
      });

      const toolUse = message.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );
      if (!toolUse) {
        throw new Error("Claude did not return a tool_use block for record_meeting_notes.");
      }

      const result = toolUse.input as RawExtractionResult;
      return {
        keywords: toArray<string>(result.keywords, "keywords"),
        takeaways: toArray<string>(result.takeaways, "takeaways").map((text) => ({ text, approved: true })),
        actionItems: toArray<RawActionItem>(result.actionItems, "actionItems").map((item) => ({
          ...item,
          approved: false,
        })),
        followUps: toArray<RawFollowUp>(result.followUps, "followUps").map((item) => ({
          ...item,
          approved: false,
        })),
      };
    },
    {
      onRetry: (err, attempt) =>
        console.warn(
          `extractInsights: extraction attempt ${attempt} failed, retrying — ${err instanceof Error ? err.message : err}`
        ),
    }
  );
}

/** Full extraction — keywords, takeaways, action items, follow-ups — as a
 * single Claude call. Used by processMeeting.ts for a fresh/full (re)process,
 * and by regenerateCategory.ts (which discards whichever categories it
 * didn't ask for — a trivial cost at personal scale). */
export async function extractInsights(input: ExtractInsightsInput): Promise<ExtractInsightsResult> {
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-5";

  let result = await callExtraction(input, model);
  for (
    let attempt = 1;
    attempt < MAX_UNDERGENERATION_ATTEMPTS &&
    (result.actionItems.length === 0 || result.followUps.length === 0);
    attempt++
  ) {
    const thin = [
      result.actionItems.length === 0 ? "actionItems" : null,
      result.followUps.length === 0 ? "followUps" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    console.warn(
      `extractInsights: "${thin}" came back empty (attempt ${attempt}/${MAX_UNDERGENERATION_ATTEMPTS}) — retrying with a fresh Claude call.`
    );
    result = await callExtraction(input, model);
  }
  if (result.actionItems.length === 0) {
    console.warn(
      `extractInsights: "actionItems" still empty after ${MAX_UNDERGENERATION_ATTEMPTS} attempts — proceeding anyway ` +
        "rather than failing the whole extraction over one thin category."
    );
  }
  if (result.followUps.length === 0) {
    console.warn(
      `extractInsights: "followUps" still empty after ${MAX_UNDERGENERATION_ATTEMPTS} attempts — proceeding anyway ` +
        "rather than failing the whole extraction over one thin category."
    );
  }
  return result;
}
