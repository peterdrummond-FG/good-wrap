// Stage 4: read/write helpers backing the dashboard API. Kept separate from
// the route definitions (app.ts) so they're easy to reuse or test on their own.

import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { ActionItem, FollowUpItem, FollowUpTiming, SuggestionItem } from "../../db/schema";
import { resolveParticipantIds, type CaptureParticipantInput } from "../ingest/captureManualMeeting";

// Three-state status the dashboard badges key off (added 2026-07-16 with the
// suggest-then-approve workflow — see db/schema.ts's meeting_insights comment).
export type ReviewStatus = "pending" | "needs_review" | "reviewed";

function computeReviewStatus(hasInsights: boolean, reviewedAt: Date | null): ReviewStatus {
  if (!hasInsights) return "pending";
  return reviewedAt ? "reviewed" : "needs_review";
}

// --- legacy-shape normalization (added 2026-07-16) --------------------------
// Every meeting_insights row written before today's suggest-then-approve
// migration has takeaways/action_items/follow_ups in an older shape: plain
// strings for takeaways (no `approved` field at all), and/or follow-up
// objects missing `approved`. Reading those rows straight through the new
// SuggestionItem/ActionItem/FollowUpItem types silently produced blank
// checkbox rows in the dashboard (t.text was undefined on a raw string item)
// — caught live when Peter reviewed a pre-migration meeting. These helpers
// coerce whatever shape is actually in the column into the current type, so
// old meetings are immediately usable in the review UI without forcing a
// reprocess first. Saving a review afterward (submitMeetingReview) writes the
// row back out in the current shape, so this only ever matters for reads.
const VALID_TIMINGS = new Set(["tomorrow", "this_week", "next_week", "unspecified"]);

function normalizeTiming(value: unknown): FollowUpTiming {
  return typeof value === "string" && VALID_TIMINGS.has(value) ? (value as FollowUpTiming) : "unspecified";
}

// Takeaways no longer go through a review step (changed 2026-07-16, per
// Peter — see extractInsights.ts's ExtractInsightsResult comment), so this
// always returns approved: true regardless of what's actually stored,
// including for pre-2026-07-16 rows that predate the `approved` field
// existing at all. There's nothing to "select" for this category anymore.
export function normalizeTakeaways(raw: unknown): SuggestionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): SuggestionItem => {
      if (typeof item === "string") return { text: item, approved: true };
      const obj = item as Partial<SuggestionItem> | null;
      return { text: String(obj?.text ?? ""), approved: true };
    })
    .filter((t) => t.text.trim());
}

export function normalizeActionItems(raw: unknown): ActionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ActionItem => {
      if (typeof item === "string") return { text: item, timing: "unspecified", approved: false };
      const obj = item as Partial<ActionItem> | null;
      return {
        text: String(obj?.text ?? ""),
        timing: normalizeTiming(obj?.timing),
        approved: Boolean(obj?.approved),
      };
    })
    .filter((a) => a.text.trim());
}

export function normalizeFollowUps(raw: unknown): FollowUpItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): FollowUpItem => {
      if (typeof item === "string") return { text: item, person: null, timing: "unspecified", approved: false };
      const obj = item as Partial<FollowUpItem> | null;
      return {
        text: String(obj?.text ?? ""),
        person: obj?.person ?? null,
        timing: normalizeTiming(obj?.timing),
        approved: Boolean(obj?.approved),
      };
    })
    .filter((f) => f.text.trim());
}

export interface MeetingListItem {
  id: string;
  topic: string;
  startTime: Date;
  durationMinutes: number | null;
  source: "manual" | "zoom";
  participants: string[];
  reviewStatus: ReviewStatus;
  // Top 3 APPROVED takeaways — powers the Meetings Overview panel, whose
  // whole point is letting someone scan "what happened today" without
  // opening each meeting. Empty until reviewed (raw unapproved suggestions
  // aren't shown here — they aren't confirmed real takeaways yet).
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
      reviewedAt: schema.meetingInsights.reviewedAt,
    })
    .from(schema.meetingInsights)
    .where(inArray(schema.meetingInsights.meetingId, meetingIds));

  const reviewStatusByMeeting = new Map<string, ReviewStatus>();
  const takeawaysByMeeting = new Map<string, string[]>();
  for (const row of insightRows) {
    reviewStatusByMeeting.set(row.meetingId, computeReviewStatus(true, row.reviewedAt));
    const approved = normalizeTakeaways(row.takeaways)
      .filter((t) => t.approved)
      .map((t) => t.text);
    takeawaysByMeeting.set(row.meetingId, approved.slice(0, 3));
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
    reviewStatus: reviewStatusByMeeting.get(m.id) ?? "pending",
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
  reviewStatus: ReviewStatus;
  insights: {
    keywords: string[];
    // takeaways: always all approved:true (no review step — see
    // normalizeTakeaways). actionItems/followUps: full candidate sets
    // (approved AND unapproved) — the meeting detail page's review UI needs
    // every candidate, not just the approved subset, so someone can change
    // their mind on a previous review.
    takeaways: SuggestionItem[];
    actionItems: ActionItem[];
    followUps: FollowUpItem[];
    reviewedAt: Date | null;
  } | null;
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
    reviewStatus: computeReviewStatus(Boolean(insights), insights?.reviewedAt ?? null),
    insights: insights
      ? {
          keywords: insights.keywords ?? [],
          takeaways: normalizeTakeaways(insights.takeaways),
          actionItems: normalizeActionItems(insights.actionItems),
          followUps: normalizeFollowUps(insights.followUps),
          reviewedAt: insights.reviewedAt,
        }
      : null,
  };
}

// --- follow-ups / action items overview -----------------------------------------
// Flattens every reviewed meeting's APPROVED follow-ups/action items into
// individual rows with their source meeting attached, so the dashboard can
// group them by timing ("tomorrow" / "next_week" / etc.) without the caller
// needing to know about the meeting_insights <-> meetings join. Unapproved
// suggestions never appear here — only the meeting detail page's review UI
// sees the full candidate set.
export interface FollowUpWithMeeting extends FollowUpItem {
  meetingId: string;
  meetingTopic: string;
  meetingStartTime: Date;
}

export interface ActionItemWithMeeting extends ActionItem {
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
    // normalizeFollowUps also absorbs pre-migration shapes (plain strings,
    // or objects missing `approved`) — those always come back approved:
    // false here, so they simply won't surface until reviewed.
    const followUps = normalizeFollowUps(row.followUps);
    for (const item of followUps) {
      if (!item.approved) continue;
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

export async function listActionItems(): Promise<ActionItemWithMeeting[]> {
  const rows = await db
    .select({
      meetingId: schema.meetings.id,
      meetingTopic: schema.meetings.topic,
      meetingStartTime: schema.meetings.startTime,
      actionItems: schema.meetingInsights.actionItems,
    })
    .from(schema.meetingInsights)
    .innerJoin(schema.meetings, eq(schema.meetings.id, schema.meetingInsights.meetingId))
    .orderBy(desc(schema.meetings.startTime));

  const flattened: ActionItemWithMeeting[] = [];
  for (const row of rows) {
    const actionItems = normalizeActionItems(row.actionItems);
    for (const item of actionItems) {
      if (!item.approved) continue;
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
  takeaways?: SuggestionItem[];
  actionItems?: ActionItem[];
  followUps?: FollowUpItem[];
  /**
   * When true, stamps reviewed_at = now() as part of this same update (see
   * src/pipeline/reviewMeeting.ts, which is the only caller that sets this —
   * it's what gates the notification send). Plain metadata/keyword edits
   * from the dashboard's generic edit flow should leave this false/omitted.
   */
  markReviewed?: boolean;
}

export interface UpdateMeetingInsightsResult {
  /** false if the meeting doesn't exist at all — caller should 404. */
  found: boolean;
  /** true only if THIS call is what moved reviewedAt from null to set. */
  justReviewed: boolean;
}

/**
 * If the meeting exists but has never been processed (no meeting_insights
 * row yet — e.g. auto-processing failed after capture), this creates one
 * from scratch rather than erroring, so edits aren't blocked on processing
 * having succeeded first.
 */
export async function updateMeetingInsights(
  meetingId: string,
  input: UpdateMeetingInsightsInput
): Promise<UpdateMeetingInsightsResult> {
  return db.transaction(async (tx) => {
    const [meeting] = await tx
      .select({ id: schema.meetings.id })
      .from(schema.meetings)
      .where(eq(schema.meetings.id, meetingId))
      .limit(1);
    if (!meeting) return { found: false, justReviewed: false };

    const [existingInsights] = await tx
      .select({ id: schema.meetingInsights.id, reviewedAt: schema.meetingInsights.reviewedAt })
      .from(schema.meetingInsights)
      .where(eq(schema.meetingInsights.meetingId, meetingId))
      .orderBy(desc(schema.meetingInsights.generatedAt))
      .limit(1);

    if (!existingInsights) {
      await tx.insert(schema.meetingInsights).values({
        meetingId,
        keywords: input.keywords ?? [],
        takeaways: input.takeaways ?? [],
        actionItems: input.actionItems ?? [],
        followUps: input.followUps ?? [],
        reviewedAt: input.markReviewed ? new Date() : null,
      });
      return { found: true, justReviewed: Boolean(input.markReviewed) };
    }

    const wasReviewed = existingInsights.reviewedAt !== null;

    const fieldsToUpdate: Partial<typeof schema.meetingInsights.$inferInsert> = {};
    if (input.keywords !== undefined) fieldsToUpdate.keywords = input.keywords;
    if (input.takeaways !== undefined) fieldsToUpdate.takeaways = input.takeaways;
    if (input.actionItems !== undefined) fieldsToUpdate.actionItems = input.actionItems;
    if (input.followUps !== undefined) fieldsToUpdate.followUps = input.followUps;
    if (input.markReviewed) fieldsToUpdate.reviewedAt = new Date();

    if (Object.keys(fieldsToUpdate).length > 0) {
      await tx
        .update(schema.meetingInsights)
        .set(fieldsToUpdate)
        .where(eq(schema.meetingInsights.id, existingInsights.id));
    }

    return { found: true, justReviewed: Boolean(input.markReviewed) && !wasReviewed };
  });
}

/**
 * Returns false if no meeting exists with this id (caller should 404).
 *
 * Deletes child rows explicitly rather than relying solely on DB-level
 * cascade — all of meeting_insights/notifications_log/transcripts/
 * transcript_chunks/meeting_participants are declared onDelete: "cascade" in
 * db/schema.ts, but doing it explicitly here in dependency order, inside one
 * transaction, is correct regardless of what's actually enforced at the DB
 * level (and doesn't depend on the FK config staying that way).
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
