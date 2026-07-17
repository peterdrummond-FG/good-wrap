// Stage 2 (back half): chunk + embed a transcript and write the given
// insights to meeting_insights/transcript_chunks.
//
// Extracted from processMeeting.ts (2026-07-17) so a meeting's insights can
// be persisted either from a fresh Claude extraction (processMeeting.ts, the
// normal path for manual/upload/Zoom capture) or from insights generated
// elsewhere and handed in already-formed (the folder-scan flow, which now
// generates these via a local Claude Code session instead of the Anthropic
// API — see src/server/app.ts's POST /api/meetings/upload-processed). Both
// callers get the same idempotent delete+insert behavior and the same
// chunking/embedding step, which is local (fastembed) either way and not
// part of what the folder-scan change is trying to avoid paying for.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { embedChunks } from "./embedChunks";
import { chunkTranscript } from "./chunkText";
import type { ExtractInsightsResult } from "./extractInsights";

export interface PersistMeetingInsightsResult {
  insightsId: string;
  chunkCount: number;
}

export interface PersistMeetingInsightsOptions {
  // Override for embedChunks' batch size — see processMeeting.ts's own
  // option of the same name for why a caller might lower this.
  embedBatchSize?: number;
}

/**
 * Idempotent: clears any prior insights/chunks for this meeting first, same
 * as processMeeting.ts always did — safe to call more than once for the same
 * meeting (e.g. a retry). actionItemsReviewedAt/followUpsReviewedAt are
 * deliberately left null (fresh candidates always need a look), matching
 * processMeeting.ts's existing behavior.
 */
export async function persistMeetingInsights(
  meetingId: string,
  transcriptId: string,
  rawText: string,
  insights: ExtractInsightsResult,
  options: PersistMeetingInsightsOptions = {}
): Promise<PersistMeetingInsightsResult> {
  const chunks = chunkTranscript(rawText);
  const embeddings = await embedChunks(chunks, options.embedBatchSize);

  return db.transaction(async (tx) => {
    await tx.delete(schema.meetingInsights).where(eq(schema.meetingInsights.meetingId, meetingId));
    await tx.delete(schema.transcriptChunks).where(eq(schema.transcriptChunks.transcriptId, transcriptId));

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
          transcriptId,
          chunkIndex: i,
          chunkText,
          embedding: embeddings[i],
        }))
      );
    }

    return { insightsId: insightsRow.id, chunkCount: chunks.length };
  });
}
