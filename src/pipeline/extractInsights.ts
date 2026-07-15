// Stage 2: Claude extraction — keywords, takeaways, follow-ups.
//
// Uses forced tool-use (tool_choice) rather than asking Claude to return JSON
// in prose, so the output is always well-formed and doesn't need a
// hand-rolled JSON parser with error handling for malformed responses.

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
  // relative to. (Used to also drive an explicit timing bucket per item;
  // replaced by "urgency" 2026-07-16 per Peter's request, but still useful
  // context for interpreting the transcript overall.)
  meetingDate: string;
  // Attendee names as recorded in the DB (see meeting_participants), so
  // Claude can attribute a follow-up to an actual participant rather than
  // inventing or mis-transcribing a name.
  participantNames: string[];
  // The meetings.owner_id user's name (see db/schema.ts) — i.e. who "Action
  // Items" are for. Added 2026-07-16 after a live bug: without this, Claude
  // has no way to know which participant name is "the meeting owner" from
  // the system prompt's abstract "things the owner needs to do themselves"
  // phrasing, so it defaulted to filing the owner's own tasks as follow-ups
  // attributed to them by name instead of as action items. See the user
  // message below and the SYSTEM_PROMPT's distinguishing paragraph.
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

// Raw shape Claude's tool call returns, before `approved: false` is stamped
// onto every item by this module.
type RawActionItem = { text: string; urgency: FollowUpItem["urgency"] };
type RawFollowUp = { text: string; person: string | null; urgency: FollowUpItem["urgency"] };

interface RawExtractInsightsResult {
  keywords?: string[];
  takeaways?: string[];
  actionItems?: RawActionItem[];
  followUps?: RawFollowUp[];
}

const RECORD_INSIGHTS_TOOL: Anthropic.Tool = {
  name: "record_meeting_insights",
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
          "inferred motivation. Unlike action items and follow-ups below, these are shown " +
          "directly with no human filtering step afterward, so pick the 5 that genuinely matter " +
          "most rather than padding out to 5 with marginal ones — precision matters more here " +
          "than for the other two categories.",
      },
      actionItems: {
        type: "array",
        // Real schema constraints (not just prose) — added 2026-07-16 after
        // a live bug where Claude returned zero action items for a meeting
        // that clearly had several (misclassified as follow-ups instead;
        // see the "Meeting owner" fix in the user message below). These are
        // a backstop on top of that fix, not a replacement for it.
        minItems: 5,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "A task the meeting owner (not another attendee) appears to need to do themselves, " +
                "grounded in the transcript.",
            },
            urgency: {
              type: "string",
              enum: ["high", "medium", "low"],
              description:
                "How urgent this action item is, independent of when it might happen. Use " +
                "\"high\" only for genuinely urgent/blocking/time-critical items (explicit " +
                "language like \"urgent\", \"ASAP\", \"critical\", \"blocker\", or clear " +
                "high-stakes framing). Use \"low\" for explicitly low-priority items (\"no " +
                "rush\", \"whenever\", \"nice to have\"). Use \"medium\" as the default for " +
                "everything else — don't force high or low without a real signal.",
            },
          },
          required: ["text", "urgency"],
        },
        description:
          "Exactly 5-8 candidate action items for the meeting owner to review and pick from — " +
          "things the owner themselves seems to need to do (as opposed to follow-ups, which are " +
          "for other people or unconfirmed items). Same reviewer-will-filter guidance as takeaways: " +
          "include plausible candidates even if some are minor.",
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
                "item worth double-checking later — grounded in the transcript.",
            },
            person: {
              type: ["string", "null"],
              description:
                "Which attendee this follow-up is waiting on or should be discussed with next, if " +
                "the transcript makes that clear. Must exactly match one of the provided " +
                "participant names — null if no specific person is identifiable, or if it's an " +
                "unconfirmed item rather than someone else's task.",
            },
            urgency: {
              type: "string",
              enum: ["high", "medium", "low"],
              description:
                "How urgent this follow-up is, independent of when it might happen. Use " +
                "\"high\" only for genuinely urgent/blocking/time-critical items (explicit " +
                "language like \"urgent\", \"ASAP\", \"critical\", \"blocker\", or clear " +
                "high-stakes framing). Use \"low\" for explicitly low-priority items (\"no " +
                "rush\", \"whenever\", \"nice to have\"). Use \"medium\" as the default for " +
                "everything else — don't force high or low without a real signal.",
            },
          },
          required: ["text", "person", "urgency"],
        },
        description:
          "Exactly 5-8 candidate follow-ups for a human to review and pick from — things other " +
          "people need to do, or unconfirmed items worth a reminder. Same reviewer-will-filter " +
          "guidance as takeaways/action items.",
      },
    },
    required: ["keywords", "takeaways", "actionItems", "followUps"],
  },
};

const SYSTEM_PROMPT =
  "You extract structured notes from a meeting transcript. Ground every point in what was " +
  "actually said in the transcript — don't infer motivation, diagnose, or invent details not " +
  "present in the text. The user message names the meeting owner. Distinguish action items " +
  "(things the meeting OWNER needs to do themselves — including when a task is clearly the " +
  "owner's own responsibility, even though the owner is also listed as a participant) from " +
  "follow-ups (things any OTHER participant needs to do, or unconfirmed items worth a " +
  "reminder). A task belonging to the meeting owner always goes in Action Items, never in " +
  "Follow-ups with the owner's name as the person — don't put the same task in both " +
  "categories. For each action item or follow-up, " +
  "assign urgency based on genuine signals in the transcript (explicit urgency language, or how " +
  "the item was actually framed) — default to \"medium\" rather than forcing \"high\" or \"low\" " +
  "without real support. For follow-ups, only assign a person when the transcript actually " +
  "supports it — leave it null rather than guessing.\n\n" +
  "Two different standards apply here, and it matters which one you're using:\n" +
  "- Takeaways are FINAL — shown to the user directly with no further filtering. Pick exactly " +
  "the 5 that genuinely matter most; don't pad out to 5 with marginal ones if fewer than 5 " +
  "clearly stand out.\n" +
  "- Action items and follow-ups are CANDIDATES for a human reviewer to approve or discard. " +
  "Since the reviewer filters these down afterward, always produce the requested 5-8 per " +
  "category even if some entries end up more marginal than others — under-generating is worse " +
  "than over-generating for these two categories specifically (not for takeaways).";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return client;
}

export async function extractInsights(
  input: ExtractInsightsInput
): Promise<ExtractInsightsResult> {
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-5";

  return withRetry(
    async () => {
      const message = await getClient().messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [RECORD_INSIGHTS_TOOL],
        tool_choice: { type: "tool", name: "record_meeting_insights" },
        messages: [
          {
            role: "user",
            content:
              `Meeting: ${input.topic}\n` +
              `Meeting date: ${input.meetingDate}\n` +
              `Participants: ${input.participants}\n` +
              `Meeting owner: ${input.ownerName} (this is who Action Items are for — if ` +
              `${input.ownerName} is also mentioned as a participant elsewhere, tasks that are ` +
              `their own responsibility still belong in Action Items, not a Follow-up with ` +
              `them as the person)\n` +
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
        throw new Error("Claude did not return a tool_use block for record_meeting_insights.");
      }

      const result = toolUse.input as RawExtractInsightsResult;

      // Forced tool-use is supposed to guarantee this shape, but it's not a
      // hard guarantee — hit live (2026-07-16) where Claude returned
      // `actionItems` as something other than an array, and `?? []` only
      // guards against null/undefined, not "defined but the wrong type".
      // That crashed the ENTIRE extraction on `.map is not a function`,
      // losing keywords/takeaways/follow-ups too, not just the one bad
      // category. Coerce defensively instead so one malformed field doesn't
      // take down everything else Claude got right.
      const toArray = <T>(value: unknown, label: string): T[] => {
        if (Array.isArray(value)) return value as T[];
        if (value !== undefined) {
          console.warn(`extractInsights: expected an array for "${label}", got`, value);
        }
        return [];
      };

      return {
        keywords: toArray<string>(result.keywords, "keywords"),
        // Takeaways: no review step — always approved (see the type comment above).
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
          `extractInsights: attempt ${attempt} failed, retrying — ${err instanceof Error ? err.message : err}`
        ),
    }
  );
}
