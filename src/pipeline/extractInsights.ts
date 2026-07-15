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
  // ISO timestamp of the meeting itself — the reference point Claude uses to
  // turn relative language in the transcript ("let's sync again next week")
  // into the timing buckets below. Without this, Claude has no basis for
  // "tomorrow" vs "next week" since it has no notion of "today".
  meetingDate: string;
  // Attendee names as recorded in the DB (see meeting_participants), so
  // Claude can attribute a follow-up to an actual participant rather than
  // inventing or mis-transcribing a name.
  participantNames: string[];
}

// Takeaways/action items/follow-ups are all suggest-then-approve (2026-07-16)
// — Claude proposes 5-8 candidates per category and Peter picks which to
// keep on the meeting detail page, so every item comes back with
// approved: false here; nothing is pre-approved by the model.
export interface ExtractInsightsResult {
  keywords: string[];
  takeaways: SuggestionItem[];
  actionItems: ActionItem[];
  followUps: FollowUpItem[];
}

// Raw shape Claude's tool call returns, before `approved: false` is stamped
// onto every item by this module.
interface RawExtractInsightsResult {
  keywords?: string[];
  takeaways?: string[];
  actionItems?: { text: string; timing: FollowUpItem["timing"] }[];
  followUps?: { text: string; person: string | null; timing: FollowUpItem["timing"] }[];
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
          "Exactly 5-8 candidate takeaways for a human to review and pick from: decisions made " +
          "or important context worth remembering. Each under ~25 words, grounded in what was " +
          "actually said — no inferred motivation. If the meeting genuinely doesn't support 8 " +
          "distinct points, it's fine for some to be more minor/marginal — the reviewer will " +
          "discard the ones that aren't useful, so err on the side of including a plausible " +
          "candidate rather than omitting it.",
      },
      actionItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "A task the meeting owner (not another attendee) appears to need to do themselves, " +
                "grounded in the transcript.",
            },
            timing: {
              type: "string",
              enum: ["tomorrow", "this_week", "next_week", "unspecified"],
              description:
                "When this action item should happen, relative to the meeting date given below. " +
                "Use \"unspecified\" unless the transcript actually gives a timing signal. Don't " +
                "guess a timing that wasn't at least implied.",
            },
          },
          required: ["text", "timing"],
        },
        description:
          "Exactly 5-8 candidate action items for the meeting owner to review and pick from — " +
          "things the owner themselves seems to need to do (as opposed to follow-ups, which are " +
          "for other people or unconfirmed items). Same reviewer-will-filter guidance as takeaways: " +
          "include plausible candidates even if some are minor.",
      },
      followUps: {
        type: "array",
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
            timing: {
              type: "string",
              enum: ["tomorrow", "this_week", "next_week", "unspecified"],
              description:
                "When this follow-up should happen, relative to the meeting date given below. " +
                "Use \"unspecified\" unless the transcript actually gives a timing signal " +
                "(e.g. \"let's touch base tomorrow\" -> tomorrow; \"circle back next week\" -> " +
                "next_week; \"sometime this week\" -> this_week). Don't guess a timing that " +
                "wasn't at least implied.",
            },
          },
          required: ["text", "person", "timing"],
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
  "You extract structured notes from meeting transcripts, as a set of CANDIDATES for a human " +
  "reviewer to approve or discard — not a final, delivered summary. Ground every point in what " +
  "was actually said in the transcript — don't infer motivation, diagnose, or invent details not " +
  "present in the text. Distinguish action items (things the meeting owner needs to do " +
  "themselves) from follow-ups (things other people need to do, or unconfirmed items worth a " +
  "reminder) — don't put the same task in both categories. For each action item or follow-up, " +
  "only assign a timing (or, for follow-ups, a person) when the transcript actually supports it " +
  "— leave it null/\"unspecified\" rather than guessing. Since a human will filter the candidates " +
  "down to what's actually useful, always produce the requested 5-8 per category even if some " +
  "entries end up more marginal than others — under-generating is worse than over-generating here.";

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

      return {
        keywords: result.keywords ?? [],
        takeaways: (result.takeaways ?? []).map((text) => ({ text, approved: false })),
        actionItems: (result.actionItems ?? []).map((item) => ({ ...item, approved: false })),
        followUps: (result.followUps ?? []).map((item) => ({ ...item, approved: false })),
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
