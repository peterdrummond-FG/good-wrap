// Manual "Person" page (on-demand meeting prep, no calendar integration —
// see Project-Handoff-Brief.md's deferred Stage 7 for the automatic
// version). A person-scoped variant of Stage 5's Q&A (see askQuestion.ts):
// retrieves transcript chunks only from meetings the given person attended
// (retrieveChunks.ts, shared with askQuestion.ts, scoped via personId), then
// asks Claude to summarize what's worth remembering or bringing up before
// meeting with them again. Triggered explicitly (a button on the person
// page), not run automatically on every page view, since it costs a real
// Claude call.

import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { callToolOnce } from "../util/claude";
import { buildCitedSources, formatExcerpts, retrieveChunks } from "./retrieveChunks";

export interface PersonSummaryResult {
  summary: string;
  sources: { meetingId: string; topic: string; startTime: Date }[];
}

const SUMMARY_TOOL: Anthropic.Tool = {
  name: "record_person_summary",
  description: "Record a summary of what's worth remembering before meeting with this person again.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "A concise summary (a few sentences to a short paragraph) of key context, decisions, and " +
          "open items involving this person, grounded only in the provided excerpts. If the excerpts " +
          "don't have much to go on, say so plainly rather than padding it out.",
      },
      citedMeetingIds: {
        type: "array",
        items: { type: "string" },
        description: "meeting_id values (from the provided excerpts) actually used to construct the summary.",
      },
    },
    required: ["summary", "citedMeetingIds"],
  },
};

/** Returns null if no person exists with this id (caller should 404). */
export async function summarizePersonHistory(personId: string): Promise<PersonSummaryResult | null> {
  const [person] = await db
    .select({ name: schema.people.name, email: schema.people.email })
    .from(schema.people)
    .where(eq(schema.people.id, personId))
    .limit(1);
  if (!person) return null;

  const name = person.name ?? person.email ?? "Unknown";
  const question = `What do I need to know before meeting with ${name} again? Summarize key context, decisions, and open items.`;
  const chunks = await retrieveChunks(question, { personId });

  if (chunks.length === 0) {
    return {
      summary: `No processed meeting transcripts found for ${name} yet — nothing to summarize.`,
      sources: [],
    };
  }

  const result = await callToolOnce<{ summary: string; citedMeetingIds?: string[] }>(
    "You summarize meeting history involving a specific person, using only the provided excerpts. " +
      "Don't use outside knowledge or invent details not present in the excerpts.",
    SUMMARY_TOOL,
    `${question}\n\nMeeting excerpts:\n\n${formatExcerpts(chunks)}`
  );

  return { summary: result.summary, sources: buildCitedSources(chunks, result.citedMeetingIds) };
}
