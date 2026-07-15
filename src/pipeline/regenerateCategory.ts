// Per-category regeneration (added 2026-07-16), triggered by the pencil icon
// on each of the meeting detail page's three review columns. Re-runs the
// same Claude extraction as Stage 2 (extractInsights) but only overwrites
// ONE category in meeting_insights — the other two categories, keywords, and
// reviewedAt are all left exactly as they were.
//
// Deliberately reuses the full extractInsights() call rather than building a
// second, narrower tool schema for a single category: it's simpler and
// lower-risk than maintaining two schemas in parallel, at the cost of
// throwing away 2/3 of a ~1-cent Claude call each time this is used — a
// trivial cost at personal scale. Worth revisiting if regenerate ends up
// being used often enough for that to matter.
//
// This intentionally does NOT touch reviewedAt or fire notifications —
// regenerating is just "give me a fresh candidate set to look at", not a
// review/approval action. If the meeting was already reviewed, regenerating
// action items or follow-ups will surface fresh unapproved candidates for
// that one category while the rest of the meeting stays marked reviewed;
// the dashboard's pencil-triggered edit view is what lets Peter re-approve
// the new set via the existing "Save selections" flow.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { extractInsights } from "./extractInsights";
import { updateMeetingInsights, getMeetingDetail, type MeetingDetail } from "../server/queries";

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
  });

  switch (category) {
    case "takeaways":
      await updateMeetingInsights(meetingId, { takeaways: fresh.takeaways });
      break;
    case "actionItems":
      await updateMeetingInsights(meetingId, { actionItems: fresh.actionItems });
      break;
    case "followUps":
      await updateMeetingInsights(meetingId, { followUps: fresh.followUps });
      break;
  }

  return getMeetingDetail(meetingId);
}
