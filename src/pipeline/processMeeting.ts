// Stage 2: processing pipeline.
//
// Triggered today by running the CLI after Stage 0 capture; later, Stage 6's
// Zoom webhook handler will call this same function once a transcript lands,
// same pattern as Stage 0's captureManualMeeting.
//
// 1. Load the meeting + transcript + participants already written by Stage 0/6.
// 2. Call Claude to extract keywords/takeaways/follow-ups -> meeting_insights.
// 3. Chunk the transcript and embed each chunk -> transcript_chunks (Stage 5 fuel).
//
// Idempotent: re-running for a meeting that's already been processed replaces
// its prior insights/chunks rather than duplicating them, so it's safe to
// re-run after a prompt tweak.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { extractInsights } from "./extractInsights";
import { embedChunks } from "./embedChunks";
import { chunkTranscript } from "./chunkText";

export interface ProcessMeetingResult {
  meetingId: string;
  insightsId: string;
  chunkCount: number;
}

export interface ProcessMeetingOptions {
  // Override for embedChunks' batch size — lower this for callers running
  // under tight memory constraints (see runFullPipeline). Defaults to
  // embedChunks' own default (32) when not set.
  embedBatchSize?: number;
}

export async function processMeeting(
  meetingId: string,
  options: ProcessMeetingOptions = {}
): Promise<ProcessMeetingResult> {
  const [meeting] = await db
    .select()
    .from(schema.meetings)
    .where(eq(schema.meetings.id, meetingId))
    .limit(1);
  if (!meeting) {
    throw new Error(`No meeting found for id ${meetingId}`);
  }

  const [transcript] = await db
    .select()
    .from(schema.transcripts)
    .where(eq(schema.transcripts.meetingId, meetingId))
    .limit(1);
  if (!transcript) {
    throw new Error(`No transcript found for meeting ${meetingId}`);
  }

  const participantRows = await db
    .select({ name: schema.people.name, email: schema.people.email })
    .from(schema.meetingParticipants)
    .innerJoin(schema.people, eq(schema.people.id, schema.meetingParticipants.personId))
    .where(eq(schema.meetingParticipants.meetingId, meetingId));

  const participantNames = participantRows.map((p) => p.name ?? p.email ?? "Unknown");
  const participants = participantNames.join(", ") || "Unknown";

  // Slow network calls happen outside the DB transaction below — no reason
  // to hold a transaction open while waiting on Claude/Voyage.
  const insights = await extractInsights({
    topic: meeting.topic,
    participants,
    transcript: transcript.rawText,
    meetingDate: meeting.startTime.toISOString(),
    participantNames,
  });

  const chunks = chunkTranscript(transcript.rawText);
  const embeddings = await embedChunks(chunks, options.embedBatchSize);

  return db.transaction(async (tx) => {
    // Idempotency: clear any prior run's output for this meeting first.
    await tx
      .delete(schema.meetingInsights)
      .where(eq(schema.meetingInsights.meetingId, meetingId));
    await tx
      .delete(schema.transcriptChunks)
      .where(eq(schema.transcriptChunks.transcriptId, transcript.id));

    const [insightsRow] = await tx
      .insert(schema.meetingInsights)
      .values({
        meetingId,
        keywords: insights.keywords,
        takeaways: insights.takeaways,
        followUps: insights.followUps,
      })
      .returning({ id: schema.meetingInsights.id });

    if (chunks.length > 0) {
      await tx.insert(schema.transcriptChunks).values(
        chunks.map((chunkText, i) => ({
          transcriptId: transcript.id,
          chunkIndex: i,
          chunkText,
          embedding: embeddings[i],
        }))
      );
    }

    return { meetingId, insightsId: insightsRow.id, chunkCount: chunks.length };
  });
}
