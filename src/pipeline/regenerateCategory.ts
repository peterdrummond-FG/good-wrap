// Per-category regeneration (added 2026-07-16), triggered by the pencil icon
// on each of the meeting detail page's three review columns. Re-runs Stage
// 2's Claude extraction but only overwrites ONE category in meeting_insights
// — the others are left exactly as they were.
//
// Calls the full extractInsights() (single combined Claude call — see that
// file's header comment) and discards whichever categories it didn't ask
// for. A trivial cost at personal scale; not worth a narrower per-category
// call for what's just a "give me a fresh candidate set" action.
//
// This never fires notifications — regenerating is just "give me a fresh
// candidate set to look at", not a review/approval action. For Action Items
// and Follow-ups, though, it DOES reset that one category's own reviewed-at
// back to null (changed 2026-07-15, CODE-AUDIT.md item #4): the fresh
// candidates are unapproved, so leaving the old timestamp in place made the
// dashboard's badge keep saying "reviewed" for a category that actually
// needs a fresh look. Takeaways have no reviewed-at (they're auto-approved,
// not part of the review workflow) so there's nothing to reset there.
// The dashboard's pencil-triggered edit view is what lets Peter re-approve
// the new set via that category's own Save button.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { extractInsights } from "./extractInsights";
import { updateMeetingInsights, getMeetingDetail, getMeetingOwner, type MeetingDetail } from "../server/queries";

export type RegenerateCategory = "takeaways" | "actionItems" | "followUps";

export async function regenerateInsightCategory(
  meetingId: string,
  category: RegenerateCategory
): Promise<MeetingDetail | null> {
  const [meeting] = await db
    .select()
    .from(schema.meetings)
    .where(eq(schema.meetings.id, meetingId))
    .limit(1);
  if (!meeting) return null;

  const [transcript] = await db
    .select()
    .from(schema.transcripts)
    .where(eq(schema.transcripts.meetingId, meetingId))
    .limit(1);
  if (!transcript) {
    throw new Error(`No transcript found for meeting ${meetingId}`);
  }

  // See processMeeting.ts's identical lookup — same reason, and same shared
  // helper so the two can't drift out of sync.
  const owner = await getMeetingOwner(meetingId);
  if (!owner) {
    throw new Error(`No owner found for meeting ${meetingId}`);
  }

  const participantRows = await db
    .select({ name: schema.people.name, email: schema.people.email })
    .from(schema.meetingParticipants)
    .innerJoin(schema.people, eq(schema.people.id, schema.meetingParticipants.personId))
    .where(eq(schema.meetingParticipants.meetingId, meetingId));
  const participantNames = participantRows.map((p) => p.name ?? p.email ?? "Unknown");
  const participants = participantNames.join(", ") || "Unknown";

  const fresh = await extractInsights({
    topic: meeting.topic,
    participants,
    transcript: transcript.rawText,
    meetingDate: meeting.startTime.toISOString(),
    participantNames,
    ownerName: owner.name,
  });

  switch (category) {
    case "takeaways": {
      await updateMeetingInsights(meetingId, { takeaways: fresh.takeaways });
      break;
    }
    case "actionItems": {
      await updateMeetingInsights(meetingId, {
        actionItems: fresh.actionItems,
        resetActionItemsReview: true,
      });
      break;
    }
    case "followUps": {
      await updateMeetingInsights(meetingId, {
        followUps: fresh.followUps,
        resetFollowUpsReview: true,
      });
      break;
    }
  }

  return getMeetingDetail(meetingId);
}
