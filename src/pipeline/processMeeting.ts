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
import { loadMeetingContext } from "./meetingContext";

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
  // Loads the meeting, its transcript, its resolved owner, and participant
  // names/display string — shared with regenerateCategory.ts (see
  // meetingContext.ts) so the two can't drift out of sync on how any of
  // this is resolved.
  const context = await loadMeetingContext(meetingId);
  if (!context) {
    throw new Error(`No meeting found for id ${meetingId}`);
  }
  const { meeting, transcript, owner, participantNames, participants } = context;

  // Slow network calls happen outside the DB transaction below — no reason
  // to hold a transaction open while waiting on Claude/Voyage.
  const insights = await extractInsights({
    topic: meeting.topic,
    participants,
    transcript: transcript.rawText,
    meetingDate: meeting.startTime.toISOString(),
    participantNames,
    ownerName: owner.name,
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

    // actionItemsReviewedAt/followUpsReviewedAt are deliberately omitted
    // (default to null) — a fresh or re-run process always produces new
    // unreviewed suggestions in both categories, even if the prior run had
    // already been fully reviewed. See reviewMeeting.ts for what flips these
    // back to non-null. NOTE (CODE-AUDIT.md item #5): this means reprocessing
    // an already-reviewed meeting silently discards its prior approvals —
    // the "Reprocess meeting" button in MeetingDetail.vue now confirms with
    // Peter before calling this when insights already exist.
    const [insightsRow] = await tx
      .insert(schema.meetingInsights)
      .values({
        meetingId,
        keywords: insights.keywords,
        takeaways: insights.takeaways,
        actionItems: insights.actionItems,
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
