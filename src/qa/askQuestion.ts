// Stage 5: natural-language Q&A over past meetings.
//
// Embeds the question with the same local model used for transcript chunks
// (asymmetric passage/query embeddings — see pipeline/embedChunks.ts),
// retrieves the closest transcript_chunks via pgvector cosine distance, and
// hands the matched excerpts to Claude to answer, citing which meeting(s) it
// actually drew from (not just whichever chunks happened to be nearby).

import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { embedQuery } from "../pipeline/embedChunks";
import { requireEnv } from "../util/env";

const TOP_K = 8;

interface RetrievedChunk {
  chunkText: string;
  meetingId: string;
  topic: string;
  startTime: Date;
  distance: number;
}

async function retrieveChunks(question: string): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedQuery(question);
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  // Raw SQL: Drizzle's query builder doesn't have a pgvector `<=>` (cosine
  // distance) helper, so this uses `db.execute` directly. embeddingLiteral is
  // built entirely from our own numeric array (never user text), and is
  // passed as a bound parameter here, not interpolated into the SQL string.
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

export interface AskQuestionResult {
  answer: string;
  sources: { meetingId: string; topic: string; startTime: Date }[];
}

const ANSWER_TOOL: Anthropic.Tool = {
  name: "record_answer",
  description:
    "Record the answer to the user's question, grounded only in the provided meeting excerpts.",
  input_schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description:
          "A direct, concise answer based only on the provided excerpts. If they don't contain " +
          "enough to answer, say so plainly rather than guessing or using outside knowledge.",
      },
      citedMeetingIds: {
        type: "array",
        items: { type: "string" },
        description:
          "meeting_id values (from the provided excerpts) actually used to construct the answer. " +
          "Empty array if the answer couldn't be grounded in any of them.",
      },
    },
    required: ["answer", "citedMeetingIds"],
  },
};

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return client;
}

export async function askQuestion(question: string): Promise<AskQuestionResult> {
  const chunks = await retrieveChunks(question);

  if (chunks.length === 0) {
    return {
      answer:
        "I don't have any processed meetings to search yet — run the Stage 2 pipeline " +
        "(npm run process) on at least one meeting first.",
      sources: [],
    };
  }

  const excerptsText = chunks
    .map(
      (c, i) =>
        `[${i}] meeting_id: ${c.meetingId} | "${c.topic}" (${c.startTime.toISOString()})\n${c.chunkText}`
    )
    .join("\n\n---\n\n");

  const model = process.env.CLAUDE_MODEL || "claude-sonnet-5";

  const message = await getClient().messages.create({
    model,
    max_tokens: 1024,
    system:
      "You answer questions using only the provided meeting excerpts. Don't use outside " +
      "knowledge or invent details not present in the excerpts. If the excerpts don't answer " +
      "the question, say so plainly.",
    tools: [ANSWER_TOOL],
    tool_choice: { type: "tool", name: "record_answer" },
    messages: [
      {
        role: "user",
        content: `Question: ${question}\n\nMeeting excerpts:\n\n${excerptsText}`,
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude did not return a tool_use block for record_answer.");
  }

  const result = toolUse.input as { answer: string; citedMeetingIds?: string[] };
  const citedIds = new Set(result.citedMeetingIds ?? []);

  const seenMeetingIds = new Set<string>();
  const sources: AskQuestionResult["sources"] = [];
  for (const c of chunks) {
    if (!citedIds.has(c.meetingId) || seenMeetingIds.has(c.meetingId)) continue;
    seenMeetingIds.add(c.meetingId);
    sources.push({ meetingId: c.meetingId, topic: c.topic, startTime: c.startTime });
  }

  return { answer: result.answer, sources };
}
