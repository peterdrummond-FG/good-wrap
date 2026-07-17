// Shared pgvector chunk retrieval used by both Stage 5 Q&A (askQuestion.ts)
// and the person-history summary (personSummary.ts) — identical similarity
// search, optionally scoped to meetings a given person attended.

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { embedQuery } from "../pipeline/embedChunks";

const TOP_K = 8;

export interface RetrievedChunk {
  chunkText: string;
  meetingId: string;
  topic: string;
  startTime: Date;
  distance: number;
}

export interface RetrieveChunksOptions {
  /** Scope retrieval to meetings this person attended (via meeting_participants). */
  personId?: string;
}

export async function retrieveChunks(
  question: string,
  opts: RetrieveChunksOptions = {}
): Promise<RetrievedChunk[]> {
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
    ${
      opts.personId
        ? sql`join meeting_participants mp on mp.meeting_id = m.id where mp.person_id = ${opts.personId}`
        : sql``
    }
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

export function formatExcerpts(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c, i) =>
        `[${i}] meeting_id: ${c.meetingId} | "${c.topic}" (${c.startTime.toISOString()})\n${c.chunkText}`
    )
    .join("\n\n---\n\n");
}

export interface CitedSource {
  meetingId: string;
  topic: string;
  startTime: Date;
}

/** Dedupes citedMeetingIds against the retrieved chunks, preserving chunk order. */
export function buildCitedSources(chunks: RetrievedChunk[], citedMeetingIds: string[] | undefined): CitedSource[] {
  const citedIds = new Set(citedMeetingIds ?? []);
  const seenMeetingIds = new Set<string>();
  const sources: CitedSource[] = [];
  for (const c of chunks) {
    if (!citedIds.has(c.meetingId) || seenMeetingIds.has(c.meetingId)) continue;
    seenMeetingIds.add(c.meetingId);
    sources.push({ meetingId: c.meetingId, topic: c.topic, startTime: c.startTime });
  }
  return sources;
}
