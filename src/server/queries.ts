// Stage 4: read/write helpers backing the dashboard API. Kept separate from
// the route definitions (app.ts) so they're easy to reuse or test on their own.

import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { FollowUpItem } from "../../db/schema";
import { resolveParticipantIds, type CaptureParticipantInput } from "../ingest/captureManualMeeting";

export interface MeetingListItem {
  id: string;
  topic: string;
  startTime: Date;
  durationMinutes: number | null;
  source: "manual" | "zoom";
  participants: string[];
  processed: boolean;
  // Top 3 takeaways (if processed) — powers the Meetings Overview panel,
  // whose whole point is letting someone scan "what happened today" without
  // opening each meeting. Empty when not yet processed.
  topTakeaways: string[];
}

export async function listMeetings(): Promise<MeetingListItem[]> {
  const meetings = await db
    .select({
      id: schema.meetings.id,
      topic: schema.meetings.topic,
      startTime: schema.meetings.startTime,
      durationMinutes: schema.meetings.durationMinutes,
      source: schema.meetings.source,
    })
    .from(schema.meetings)
    .orderBy(desc(schema.meetings.startTime));

  if (meetings.length === 0) return [];

  const meetingIds = meetings.map((m) => m.id);

  const participantRows = await db
    .select({
      meetingId: schema.meetingParticipants.meetingId,
      name: schema.people.name,
      email: schema.people.email,
    })
    .from(schema.meetingParticipants)
    .innerJoin(schema.people, eq(schema.people.id, schema.meetingParticipants.personId))
    .where(inArray(schema.meetingParticipants.meetingId, meetingIds));

  const insightRows = await db
    .select({
      meetingId: schema.meetingInsights.meetingId,
      takeaways: schema.meetingInsights.takeaways,
    })
    .from(schema.meetingInsights)
    .where(inArray(schema.meetingInsights.meetingId, meetingIds));

  const processedIds = new Set(insightRows.map((r) => r.meetingId));
  const takeawaysByMeeting = new Map<string, string[]>();
  for (const row of insightRows) {
    takeawaysByMeeting.set(row.meetingId, (row.takeaways ?? []).slice(0, 3));
  }

  const participantsByMeeting = new Map<string, string[]>();
  for (const row of participantRows) {
    const label = row.name ?? row.email ?? "Unknown";
    const list = participantsByMeeting.get(row.meetingId) ?? [];
    list.push(label);
    participantsByMeeting.set(row.meetingId, list);
  }

  return meetings.map((m) => ({
    ...m,
    participants: participantsByMeeting.get(m.id) ?? [],
    processed: processedIds.has(m.id),
    topTakeaways: takeawaysByMeeting.get(m.id) ?? [],
  }));
}

export interface MeetingDetail {
  id: string;
  topic: string;
  startTime: Date;
  durationMinutes: number | null;
  source: "manual" | "zoom";
  participants: string[];
  transcript: string | null;
  insights: { keywords: string[]; takeaways: string[]; followUps: FollowUpItem[] } | null;
}

export async function getMeetingDetail(meetingId: string): Promise<MeetingDetail | null> {
  const [meeting] = await db
    .select()
    .from(schema.meetings)
    .where(eq(schema.meetings.id, meetingId))
    .limit(1);
  if (!meeting) return null;

  const participantRows = await db
    .select({ name: schema.people.name, email: schema.people.email })
    .from(schema.meetingParticipants)
    .innerJoin(schema.people, eq(schema.people.id, schema.meetingParticipants.personId))
    .where(eq(schema.meetingParticipants.meetingId, meetingId));

  const [transcript] = await db
    .select()
    .from(schema.transcripts)
    .where(eq(schema.transcripts.meetingId, meetingId))
    .limit(1);

  const [insights] = await db
    .select()
    .from(schema.meetingInsights)
    .where(eq(schema.meetingInsights.meetingId, meetingId))
    .orderBy(desc(schema.meetingInsights.generatedAt))
    .limit(1);

  return {
    id: meeting.id,
    topic: meeting.topic,
    startTime: meeting.startTime,
    durationMinutes: meeting.durationMinutes,
    source: meeting.source,
    participants: participantRows.map((p) => p.name ?? p.email ?? "Unknown"),
    transcript: transcript?.rawText ?? null,
    insights: insights
      ? {
          keywords: insights.keywords ?? [],
          takeaways: insights.takeaways ?? [],
          followUps: insights.followUps ?? [],
        }
      : null,
  };
}

// --- follow-ups overview -----------------------------------------------------------
// Flattens every processed meeting's follow_ups array into individual rows with
// their source meeting attached, so the dashboard can group them by timing
// ("tomorrow" / "next_week" / etc.) without the caller needing to know about
// the meeting_insights <-> meetings join.
export interface FollowUpWithMeeting extends FollowUpItem {
  meetingId: string;
  meetingTopic: string;
  meetingStartTime: Date;
}

export async function listFollowUps(): Promise<FollowUpWithMeeting[]> {
  const rows = await db
    .select({
      meetingId: schema.meetings.id,
      meetingTopic: schema.meetings.topic,
      meetingStartTime: schema.meetings.startTime,
      followUps: schema.meetingInsights.followUps,
    })
    .from(schema.meetingInsights)
    .innerJoin(schema.meetings, eq(schema.meetings.id, schema.meetingInsights.meetingId))
    .orderBy(desc(schema.meetings.startTime));

  const flattened: FollowUpWithMeeting[] = [];
  for (const row of rows) {
    // Defensive: follow_ups is expected to be an array, but a malformed row
    // (e.g. stale test data written with the wrong shape) shouldn't crash
    // this endpoint for every meeting — skip it instead.
    const followUps = Array.isArray(row.followUps) ? row.followUps : [];
    for (const item of followUps) {
      flattened.push({
        ...item,
        meetingId: row.meetingId,
        meetingTopic: row.meetingTopic,
        meetingStartTime: row.meetingStartTime,
      });
    }
  }
  return flattened;
}

// --- edit / delete (added for the meeting detail page's edit+delete controls) -----

export interface UpdateMeetingInput {
  /** Any field left undefined is unchanged. */
  topic?: string;
  startTime?: Date | string;
  durationMinutes?: number | null;
  /**
   * When provided, REPLACES the meeting's entire participant list (matches
   * the same email/name matching rules captureManualMeeting uses — see
   * resolveParticipantIds). Omit to leave participants untouched.
   */
  participants?: CaptureParticipantInput[];
}

/** Returns false if no meeting exists with this id (caller should 404). */
export async function updateMeeting(meetingId: string, input: UpdateMeetingInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.meetings.id })
      .from(schema.meetings)
      .where(eq(schema.meetings.id, meetingId))
      .limit(1);
    if (!existing) return false;

    const fieldsToUpdate: Partial<typeof schema.meetings.$inferInsert> = {};

    if (input.topic !== undefined) {
      if (!input.topic.trim()) {
        throw new Error("topic cannot be empty");
      }
      fieldsToUpdate.topic = input.topic;
    }

    if (input.startTime !== undefined) {
      const startTime =
        typeof input.startTime === "string" ? new Date(input.startTime) : input.startTime;
      if (Number.isNaN(startTime.getTime())) {
        throw new Error(`Invalid startTime: ${input.startTime}`);
      }
      fieldsToUpdate.startTime = startTime;
    }

    if (input.durationMinutes !== undefined) {
      fieldsToUpdate.durationMinutes = input.durationMinutes;
    }

    if (Object.keys(fieldsToUpdate).length > 0) {
      await tx.update(schema.meetings).set(fieldsToUpdate).where(eq(schema.meetings.id, meetingId));
    }

    if (input.participants !== undefined) {
      const participantIds = await resolveParticipantIds(tx, input.participants);
      await tx
        .delete(schema.meetingParticipants)
        .where(eq(schema.meetingParticipants.meetingId, meetingId));
      if (participantIds.length > 0) {
        await tx.insert(schema.meetingParticipants).values(
          participantIds.map((personId) => ({ meetingId, personId }))
        );
      }
    }

    return true;
  });
}

export interface UpdateMeetingInsightsInput {
  /** Any field left undefined is unchanged. */
  keywords?: string[];
  takeaways?: string[];
  followUps?: FollowUpItem[];
}

/**
 * Returns false if the meeting doesn't exist at all (caller should 404).
 * If the meeting exists but has never been processed (no meeting_insights
 * row yet — e.g. auto-processing failed after capture), this creates one
 * from scratch rather than erroring, so metadata edits aren't blocked on
 * processing having succeeded first.
 */
export async function updateMeetingInsights(
  meetingId: string,
  input: UpdateMeetingInsightsInput
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [meeting] = await tx
      .select({ id: schema.meetings.id })
      .from(schema.meetings)
      .where(eq(schema.meetings.id, meetingId))
      .limit(1);
    if (!meeting) return false;

    const [existingInsights] = await tx
      .select({ id: schema.meetingInsights.id })
      .from(schema.meetingInsights)
      .where(eq(schema.meetingInsights.meetingId, meetingId))
      .orderBy(desc(schema.meetingInsights.generatedAt))
      .limit(1);

    if (!existingInsights) {
      await tx.insert(schema.meetingInsights).values({
        meetingId,
        keywords: input.keywords ?? [],
        takeaways: input.takeaways ?? [],
        followUps: input.followUps ?? [],
      });
      return true;
    }

    const fieldsToUpdate: Partial<typeof schema.meetingInsights.$inferInsert> = {};
    if (input.keywords !== undefined) fieldsToUpdate.keywords = input.keywords;
    if (input.takeaways !== undefined) fieldsToUpdate.takeaways = input.takeaways;
    if (input.followUps !== undefined) fieldsToUpdate.followUps = input.followUps;

    if (Object.keys(fieldsToUpdate).length > 0) {
      await tx
        .update(schema.meetingInsights)
        .set(fieldsToUpdate)
        .where(eq(schema.meetingInsights.id, existingInsights.id));
    }

    return true;
  });
}

/**
 * Returns false if no meeting exists with this id (caller should 404).
 *
 * Deletes child rows explicitly rather than relying on DB-level cascade:
 * meeting_participants/transcripts/transcript_chunks are declared with
 * onDelete: "cascade" in db/schema.ts, but meeting_insights and
 * notifications_log are NOT — their FK is a plain reference with no cascade
 * action, so a bare `delete from meetings` would fail with a foreign-key
 * violation once a meeting has been processed or notified. Doing all of it
 * explicitly, in dependency order, inside one transaction is correct
 * regardless of what's actually enforced at the DB level.
 */
export async function deleteMeeting(meetingId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.meetings.id })
      .from(schema.meetings)
      .where(eq(schema.meetings.id, meetingId))
      .limit(1);
    if (!existing) return false;

    await tx.delete(schema.notificationsLog).where(eq(schema.notificationsLog.meetingId, meetingId));
    await tx.delete(schema.meetingInsights).where(eq(schema.meetingInsights.meetingId, meetingId));

    const transcriptRows = await tx
      .select({ id: schema.transcripts.id })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.meetingId, meetingId));
    const transcriptIds = transcriptRows.map((t) => t.id);
    if (transcriptIds.length > 0) {
      await tx
        .delete(schema.transcriptChunks)
        .where(inArray(schema.transcriptChunks.transcriptId, transcriptIds));
    }
    await tx.delete(schema.transcripts).where(eq(schema.transcripts.meetingId, meetingId));
    await tx
      .delete(schema.meetingParticipants)
      .where(eq(schema.meetingParticipants.meetingId, meetingId));
    await tx.delete(schema.meetings).where(eq(schema.meetings.id, meetingId));

    return true;
  });
}
