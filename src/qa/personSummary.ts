// Manual "Person" page (on-demand meeting prep, no calendar integration —
// see Project-Handoff-Brief.md's deferred Stage 7 for the automatic
// version). A person-scoped variant of Stage 5's Q&A (see askQuestion.ts):
// retrieves transcript chunks only from meetings the given person attended,
// then asks Claude to summarize what's worth remembering or bringing up
// before meeting with them again. Triggered explicitly (a button on the
// person page), not run automatically on every page view, since it costs a
// real Claude call.

import Anthropic from "@anthropic-ai/sdk";
import { sql, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { embedQuery } from "../pipeline/embedChunks";
import { getClaudeClient, getClaudeModel, getToolUseInput } from "../util/claude";

const TOP_K = 8;

interface PersonChunk {
  chunkText: string;
  meetingId: string;
  topic: string;
  startTime: Date;
  distance: number;
}

async function retrievePersonChunks(personId: string, question: string): Promise<PersonChunk[]> {
  const queryEmbedding = await embedQuery(question);
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  // Same pattern as askQuestion.ts's retrieveChunks, scoped to meetings this
  // person attended via an extra join on meeting_participants.
  const rows = (await db.execute(sql`
    select
      tc.chunk_text as chunk_text,
      t.meeting_id as meeting_id,
      m.topic as topic,
      m.start_time as start_time,
      tc.embedding <=> ${embeddingLiteral}::vector as distance
    from transcript_chunks tc
    join transcripts t on t.id = tc.transcript_id
    join meetings m on m.id = t.meeting_id
    join meeting_participants mp on mp.meeting_id = m.id
    where mp.person_id = ${personId}
    order by distance asc
    limit ${TOP_K}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    chunkText: row.chunk_text as string,
    meetingId: row.meeting_id as string,
    topic: row.topic as string,
    startTime: new Date(row.start_time as string),
    distance: Number(row.distance),
  }));
}

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
  const chunks = await retrievePersonChunks(personId, question);

  if (chunks.length === 0) {
    return {
      summary: `No processed meeting transcripts found for ${name} yet — nothing to summarize.`,
      sources: [],
    };
  }

  const excerptsText = chunks
    .map(
      (c, i) =>
        `[${i}] meeting_id: ${c.meetingId} | "${c.topic}" (${c.startTime.toISOString()})\n${c.chunkText}`
    )
    .join("\n\n---\n\n");

  const model = getClaudeModel();
  const message = await getClaudeClient().messages.create({
    model,
    max_tokens: 1024,
    system:
      "You summarize meeting history involving a specific person, using only the provided excerpts. " +
      "Don't use outside knowledge or invent details not present in the excerpts.",
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "tool", name: "record_person_summary" },
    messages: [{ role: "user", content: `${question}\n\nMeeting excerpts:\n\n${excerptsText}` }],
  });

  const result = getToolUseInput(message, "record_person_summary") as {
    summary: string;
    citedMeetingIds?: string[];
  };
  const citedIds = new Set(result.citedMeetingIds ?? []);

  const seenMeetingIds = new Set<string>();
  const sources: PersonSummaryResult["sources"] = [];
  for (const c of chunks) {
    if (!citedIds.has(c.meetingId) || seenMeetingIds.has(c.meetingId)) continue;
    seenMeetingIds.add(c.meetingId);
    sources.push({ meetingId: c.meetingId, topic: c.topic, startTime: c.startTime });
  }

  return { summary: result.summary, sources };
}
