// Stage 2: Claude extraction — keywords, takeaways, follow-ups.
//
// Uses forced tool-use (tool_choice) rather than asking Claude to return JSON
// in prose, so the output is always well-formed and doesn't need a
// hand-rolled JSON parser with error handling for malformed responses.

import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "../util/env";
import { withRetry } from "../util/retry";
import type { FollowUpItem } from "../../db/schema";

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

export interface ExtractInsightsResult {
  keywords: string[];
  takeaways: string[];
  followUps: FollowUpItem[];
}

const RECORD_INSIGHTS_TOOL: Anthropic.Tool = {
  name: "record_meeting_insights",
  description:
    "Record the extracted keywords, takeaways, and follow-ups for this meeting transcript.",
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
          "3-8 concise takeaways: decisions made or important context worth remembering. " +
          "Each under ~25 words, grounded in what was actually said — no inferred motivation.",
      },
      followUps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The concrete action item or thing to follow up on, grounded in the transcript.",
            },
            person: {
              type: ["string", "null"],
              description:
                "Which attendee this follow-up should be discussed with next, if the transcript " +
                "makes that clear. Must exactly match one of the provided participant names — " +
                "null if no specific person is identifiable (e.g. it's a solo task or ambiguous).",
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
          "0-8 concrete action items or things to follow up on next time, grounded in the " +
          "transcript. Empty array if there genuinely aren't any.",
      },
    },
    required: ["keywords", "takeaways", "followUps"],
  },
};

const SYSTEM_PROMPT =
  "You extract structured notes from meeting transcripts. Ground every point in what was " +
  "actually said in the transcript — don't infer motivation, diagnose, or invent details not " +
  "present in the text. If the transcript is casual/exploratory rather than task-driven, it's " +
  "fine for follow-ups to be a short or empty list rather than padded out. For each follow-up, " +
  "only assign a person or timing when the transcript actually supports it — leave person null " +
  "and timing \"unspecified\" rather than guessing.";

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

      const result = toolUse.input as Partial<ExtractInsightsResult>;

      return {
        keywords: result.keywords ?? [],
        takeaways: result.takeaways ?? [],
        followUps: result.followUps ?? [],
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
