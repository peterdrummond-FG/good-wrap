// Shared "load everything Claude extraction needs for one meeting" step,
// used identically by a fresh/full process (processMeeting.ts) and a
// single-category regenerate (regenerateCategory.ts) — both need the
// meeting row, its transcript, its resolved owner (see queries.ts's
// getMeetingOwner comment for why extraction needs this), and the
// participant names in the same "comma-joined, falls back to Unknown" shape
// extractInsights expects.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { getMeetingOwner, type MeetingOwner } from "../server/queries";

export interface MeetingContext {
  meeting: typeof schema.meetings.$inferSelect;
  transcript: typeof schema.transcripts.$inferSelect;
  owner: MeetingOwner;
  /** Attendee names as recorded in the DB — for extractInsights' participantNames. */
  participantNames: string[];
  /** Same names, comma-joined for display/prompt text — "Unknown" if none recorded. */
  participants: string;
}

/**
 * Returns null only if no meeting exists with this id (caller should treat
 * that as a 404-equivalent). A meeting that DOES exist is expected to always
 * have a transcript and a resolvable owner (owner_id is a NOT NULL FK) — if
 * either is somehow missing, that's a data-integrity problem worth throwing
 * loudly on rather than silently degrading extraction.
 */
export async function loadMeetingContext(meetingId: string): Promise<MeetingContext | null> {
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

  // Needed so extractInsights can tell Claude which participant name is the
  // meeting owner (see extractInsights.ts's comment — without this, the
  // owner's own tasks get misfiled as follow-ups instead of action items).
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

  return { meeting, transcript, owner, participantNames, participants };
}
