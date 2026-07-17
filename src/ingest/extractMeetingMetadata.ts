// Metadata inference for unattended text-file capture (file upload and the
// folder auto-scan — both hand a raw .txt transcript to this module with no
// structured fields at all, unlike the manual form or Zoom's webhook payload
// which already know topic/date/participants). Same forced-tool-use pattern
// as extractInsights.ts, via the shared Claude plumbing in util/claude.ts.
//
// This ONLY infers the fields captureManualMeeting() needs to write the
// meeting row — it does not touch keywords/takeaways/action items/follow-ups,
// which stay processMeeting.ts's job, run right after capture as usual.

import Anthropic from "@anthropic-ai/sdk";
import { getClaudeClient, getClaudeModel, getToolUseInput } from "../util/claude";
import { withRetry } from "../util/retry";

export interface ExtractMeetingMetadataInput {
  rawText: string;
  /** Used only if the transcript itself doesn't clearly state a title — e.g. the uploaded filename. */
  fallbackTopic: string;
  /** Used only if the transcript itself doesn't clearly state when the meeting happened — e.g. upload time or file mtime. */
  fallbackStartTime: Date;
}

export interface ExtractedParticipant {
  name?: string;
  email?: string;
}

export interface ExtractMeetingMetadataResult {
  topic: string;
  /** ISO timestamp. */
  startTime: string;
  durationMinutes?: number;
  participants: ExtractedParticipant[];
}

type RawParticipant = { name?: string | null; email?: string | null };

interface RawMetadataResult {
  topic?: string | null;
  startTime?: string | null;
  durationMinutes?: number | null;
  participants?: RawParticipant[];
}

const RECORD_METADATA_TOOL: Anthropic.Tool = {
  name: "record_meeting_metadata",
  description:
    "Record the meeting title, date/time, duration, and participants inferred from a raw " +
    "transcript that has no structured metadata attached.",
  input_schema: {
    type: "object",
    properties: {
      topic: {
        type: ["string", "null"],
        description:
          "The meeting's title. If the transcript has ANY explicit stated name/title for the " +
          "meeting itself — a labeled metadata field (e.g. \"Name:\", \"Meeting:\", \"Title:\", " +
          "\"Subject:\", \"Topic:\") or a clear heading at the top of the document — copy that " +
          "text VERBATIM, exactly as written, even if it seems like an odd, joking, or " +
          "non-descriptive name. Do NOT paraphrase it, \"improve\" it, or replace it with your " +
          "own summary of what was discussed — an explicit stated title is a fact about the " +
          "meeting, not something to reinterpret. Only fall back to inferring a descriptive " +
          "title from the content discussed when there is genuinely no stated name anywhere in " +
          "the text. Null if there's neither a stated name nor a reasonable basis to infer one " +
          "— the caller falls back to the filename in that case.",
      },
      startTime: {
        type: ["string", "null"],
        description:
          "ISO 8601 timestamp of when the meeting happened, ONLY if the transcript text itself " +
          "states or clearly implies a specific date/time (e.g. a header, a spoken date, a " +
          "timestamp prefix on each line). Null if there's no such signal in the text — never " +
          "guess or invent a date; the caller falls back to a known-accurate timestamp in that case.",
      },
      durationMinutes: {
        type: ["number", "null"],
        description:
          "Meeting duration in minutes, ONLY if derivable from explicit timestamps in the " +
          "transcript (e.g. the gap between the first and last timestamped line). Null if the " +
          "transcript has no timestamps to derive this from — never estimate from text length.",
      },
      participants: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: ["string", "null"], description: "Speaker's name, if identifiable." },
            email: { type: ["string", "null"], description: "Only if an email address literally appears in the text attributed to this person." },
          },
        },
        description:
          "Everyone who actually SPOKE in the transcript (has their own speaker-labeled line), " +
          "deduplicated. Use whatever speaker labels the transcript itself uses (e.g. \"Sarah:\", " +
          "\"[John Doe]\"). Do NOT include someone who is merely mentioned, referred to, or " +
          "named as a follow-up contact without a speaker line of their own (e.g. \"let's loop in " +
          "Ray from Legal\" does NOT make Ray a participant) — that would misrepresent who " +
          "actually attended.",
      },
    },
    required: ["topic", "startTime", "durationMinutes", "participants"],
  },
};

const SYSTEM_PROMPT =
  "You infer meeting metadata from a raw transcript that has no structured fields attached — " +
  "just the text itself, possibly with speaker labels, timestamps, or a metadata header. Ground " +
  "every field in what the transcript actually contains: use null for topic/startTime/" +
  "durationMinutes when the text doesn't clearly support a value, rather than guessing or " +
  "inventing one — the caller has sensible fallbacks for each. If the transcript explicitly " +
  "states its own name/title anywhere (a labeled field or a heading), that is the topic, copied " +
  "verbatim — never replace a stated title with your own summary of the discussion, no matter " +
  "how much more descriptive your summary would be. Only list participants who actually have " +
  "their own speaker-labeled line in the transcript — never someone who is merely mentioned, " +
  "named, or referred to (e.g. as a follow-up contact) without speaking themselves.";

async function callExtraction(rawText: string, model: string): Promise<RawMetadataResult> {
  return withRetry(async () => {
    const message = await getClaudeClient().messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [RECORD_METADATA_TOOL],
      tool_choice: { type: "tool", name: "record_meeting_metadata" },
      messages: [
        {
          role: "user",
          content: `Transcript:\n${rawText}`,
        },
      ],
    });

    return getToolUseInput(message, "record_meeting_metadata") as RawMetadataResult;
  });
}

export async function extractMeetingMetadata(
  input: ExtractMeetingMetadataInput
): Promise<ExtractMeetingMetadataResult> {
  const model = getClaudeModel();
  const raw = await callExtraction(input.rawText, model);

  const topic = raw.topic?.trim() || input.fallbackTopic;

  // A model-supplied date that fails to parse is worse than no date at all —
  // fall back rather than writing an Invalid Date into the DB.
  let startTime = input.fallbackStartTime.toISOString();
  if (raw.startTime) {
    const parsed = new Date(raw.startTime);
    if (!Number.isNaN(parsed.getTime())) {
      startTime = parsed.toISOString();
    } else {
      console.warn(`extractMeetingMetadata: could not parse inferred startTime "${raw.startTime}", using fallback.`);
    }
  }

  const durationMinutes =
    typeof raw.durationMinutes === "number" && raw.durationMinutes > 0 ? raw.durationMinutes : undefined;

  const participants: ExtractedParticipant[] = Array.isArray(raw.participants)
    ? raw.participants
        .map((p) => ({
          name: p.name?.trim() || undefined,
          email: p.email?.trim().toLowerCase() || undefined,
        }))
        .filter((p) => p.name || p.email)
    : [];

  return { topic, startTime, durationMinutes, participants };
}
