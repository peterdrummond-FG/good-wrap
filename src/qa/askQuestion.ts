// Stage 5: natural-language Q&A over past meetings.
//
// Embeds the question with the same local model used for transcript chunks
// (asymmetric passage/query embeddings — see pipeline/embedChunks.ts),
// retrieves the closest transcript_chunks via pgvector cosine distance (see
// retrieveChunks.ts, shared with personSummary.ts), and hands the matched
// excerpts to Claude to answer, citing which meeting(s) it actually drew from
// (not just whichever chunks happened to be nearby).

import Anthropic from "@anthropic-ai/sdk";
import { callToolOnce } from "../util/claude";
import { buildCitedSources, formatExcerpts, retrieveChunks } from "./retrieveChunks";

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

  const result = await callToolOnce<{ answer: string; citedMeetingIds?: string[] }>(
    "You answer questions using only the provided meeting excerpts. Don't use outside " +
      "knowledge or invent details not present in the excerpts. If the excerpts don't answer " +
      "the question, say so plainly.",
    ANSWER_TOOL,
    `Question: ${question}\n\nMeeting excerpts:\n\n${formatExcerpts(chunks)}`
  );

  return { answer: result.answer, sources: buildCitedSources(chunks, result.citedMeetingIds) };
}
