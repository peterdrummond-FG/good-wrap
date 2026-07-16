// Stage 4: read/write helpers backing the dashboard API. Kept separate from
// the route definitions (app.ts) so they're easy to reuse or test on their own.

import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { ActionItem, FollowUpItem, SuggestionItem, Urgency } from "../../db/schema";
import { resolveParticipantIds, type CaptureParticipantInput } from "../ingest/captureManualMeeting";
import { createAsanaTask } from "../integrations/asana";

// Three-state status the dashboard badges key off (added 2026-07-16 with the
// suggest-then-approve workflow — see db/schema.ts's meeting_insights comment).
// "reviewed" now requires BOTH action items and follow-ups to have been
// saved at least once (changed 2026-07-15 alongside the per-category review
// split — CODE-AUDIT.md items #2/#4) — takeaways aren't part of this since
// they're auto-approved and have no review timestamp of their own.
export type ReviewStatus = "pending" | "needs_review" | "reviewed";

function computeReviewStatus(
  hasInsights: boolean,
  actionItemsReviewedAt: Date | null,
  followUpsReviewedAt: Date | null
): ReviewStatus {
  if (!hasInsights) return "pending";
  return actionItemsReviewedAt && followUpsReviewedAt ? "reviewed" : "needs_review";
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
const VALID_URGENCY = new Set(["high", "medium", "low"]);

function normalizeUrgency(value: unknown): Urgency {
  return typeof value === "string" && VALID_URGENCY.has(value) ? (value as Urgency) : "medium";
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
      if (typeof item === "string") return { text: item, urgency: "medium", approved: false };
      const obj = item as Partial<ActionItem> | null;
      return {
        text: String(obj?.text ?? ""),
        urgency: normalizeUrgency(obj?.urgency),
        approved: Boolean(obj?.approved),
        asanaTaskGid: typeof obj?.asanaTaskGid === "string" ? obj.asanaTaskGid : undefined,
      };
    })
    .filter((a) => a.text.trim());
}

export function normalizeFollowUps(raw: unknown): FollowUpItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): FollowUpItem => {
      if (typeof item === "string") return { text: item, person: null, urgency: "medium", approved: false };
      const obj = item as Partial<FollowUpItem> | null;
      return {
        text: String(obj?.text ?? ""),
        person: obj?.person ?? null,
        urgency: normalizeUrgency(obj?.urgency),
        approved: Boolean(obj?.approved),
      };
    })
    .filter((f) => f.text.trim());
}

// --- "who is the user" — single source of truth --------------------------
// Added 2026-07-16 after a live bug where the Claude extraction pipeline had
// no way to know which participant name was "the meeting owner", because
// nothing told it — the concept only existed implicitly via
// meetings.owner_id. Rather than let every future feature that needs to
// know "the user" (email/chat notification recipients, extraction, any
// future personalization) re-derive this independently — and risk drifting
// out of sync the way extraction did — this is the one place that resolves
// it. Callers should always go through these, never read
// process.env.DEFAULT_OWNER_EMAIL or re-join meetings->users themselves.
export interface MeetingOwner {
  id: string;
  name: string;
  email: string;
}

/** Resolves a specific meeting's owner via meetings.owner_id -> users. Used
 * by the extraction pipeline (processMeeting.ts, regenerateCategory.ts) and,
 * eventually, by real email/chat notification senders once a provider is
 * chosen. Returns null if the meeting doesn't exist (the owner_id FK means
 * a resolved meeting should always have a valid owner). */
export async function getMeetingOwner(meetingId: string): Promise<MeetingOwner | null> {
  const [row] = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.meetings)
    .innerJoin(schema.users, eq(schema.users.id, schema.meetings.ownerId))
    .where(eq(schema.meetings.id, meetingId))
    .limit(1);
  return row ?? null;
}

/** The dashboard's implicit "current user" — there's no real auth yet (this
 * is a personal-use POC, see CODE-AUDIT.md), so "signed in" just means
 * whichever user DEFAULT_OWNER_EMAIL points at. Backs GET /api/me, which
 * exists so that assumption is visible in the UI ("Signed in as X") instead
 * of buried in an env var nothing ever surfaces. Returns null if the env var
 * is unset or doesn't resolve to a real users row. */
export async function getCurrentUser(): Promise<MeetingOwner | null> {
  const email = process.env.DEFAULT_OWNER_EMAIL;
  if (!email) return null;
  const [row] = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  return row ?? null;
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
  // Keywords are fully automatic (no approval step — see extractInsights.ts),
  // so unlike takeaways these are shown as-is. Added so the Meetings list can
  // search on them, not just the topic text.
  keywords: string[];
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
      keywords: schema.meetingInsights.keywords,
      takeaways: schema.meetingInsights.takeaways,
      actionItemsReviewedAt: schema.meetingInsights.actionItemsReviewedAt,
      followUpsReviewedAt: schema.meetingInsights.followUpsReviewedAt,
    })
    .from(schema.meetingInsights)
    .where(inArray(schema.meetingInsights.meetingId, meetingIds));

  const reviewStatusByMeeting = new Map<string, ReviewStatus>();
  const takeawaysByMeeting = new Map<string, string[]>();
  const keywordsByMeeting = new Map<string, string[]>();
  for (const row of insightRows) {
    reviewStatusByMeeting.set(
      row.meetingId,
      computeReviewStatus(true, row.actionItemsReviewedAt, row.followUpsReviewedAt)
    );
    const approved = normalizeTakeaways(row.takeaways)
      .filter((t) => t.approved)
      .map((t) => t.text);
    takeawaysByMeeting.set(row.meetingId, approved.slice(0, 3));
    keywordsByMeeting.set(row.meetingId, row.keywords ?? []);
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
    keywords: keywordsByMeeting.get(m.id) ?? [],
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
    actionItemsReviewedAt: Date | null;
    followUpsReviewedAt: Date | null;
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
    reviewStatus: computeReviewStatus(
      Boolean(insights),
      insights?.actionItemsReviewedAt ?? null,
      insights?.followUpsReviewedAt ?? null
    ),
    insights: insights
      ? {
          keywords: insights.keywords ?? [],
          takeaways: normalizeTakeaways(insights.takeaways),
          actionItems: normalizeActionItems(insights.actionItems),
          followUps: normalizeFollowUps(insights.followUps),
          actionItemsReviewedAt: insights.actionItemsReviewedAt,
          followUpsReviewedAt: insights.followUpsReviewedAt,
        }
      : null,
  };
}

// --- follow-ups / action items overview -----------------------------------------
// Flattens every reviewed meeting's APPROVED follow-ups/action items into
// individual rows with their source meeting attached, so the dashboard can
// group them by urgency ("high" / "medium" / "low") without the caller
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
   * When true, stamps action_items_reviewed_at = now() as part of this same
   * update (see src/pipeline/reviewMeeting.ts, the only caller that sets
   * this — it's what gates that category's notification send). Split from a
   * single markReviewed flag 2026-07-15 (CODE-AUDIT.md items #2/#3/#4) so a
   * keywords-only call can no longer accidentally mark a category reviewed,
   * and so Action Items/Follow-ups can be saved — and notified on — fully
   * independently of each other.
   */
  markActionItemsReviewed?: boolean;
  /** Same as markActionItemsReviewed, but for follow_ups_reviewed_at. */
  markFollowUpsReviewed?: boolean;
  /**
   * When true, resets action_items_reviewed_at back to null — used by
   * regenerateCategory.ts when Action Items is regenerated, so a category
   * that now holds fresh unapproved candidates stops being badged
   * "reviewed" (CODE-AUDIT.md item #4). Mutually exclusive with
   * markActionItemsReviewed in practice; if both were somehow set, mark
   * wins since it's applied first below.
   */
  resetActionItemsReview?: boolean;
  /** Same as resetActionItemsReview, but for follow_ups_reviewed_at. */
  resetFollowUpsReview?: boolean;
}

export interface UpdateMeetingInsightsResult {
  /** false if the meeting doesn't exist at all — caller should 404. */
  found: boolean;
  /** true only if THIS call is what moved action_items_reviewed_at from null to set. */
  justReviewedActionItems: boolean;
  /** true only if THIS call is what moved follow_ups_reviewed_at from null to set. */
  justReviewedFollowUps: boolean;
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
    if (!meeting) return { found: false, justReviewedActionItems: false, justReviewedFollowUps: false };

    const [existingInsights] = await tx
      .select({
        id: schema.meetingInsights.id,
        actionItemsReviewedAt: schema.meetingInsights.actionItemsReviewedAt,
        followUpsReviewedAt: schema.meetingInsights.followUpsReviewedAt,
      })
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
        actionItemsReviewedAt: input.markActionItemsReviewed ? new Date() : null,
        followUpsReviewedAt: input.markFollowUpsReviewed ? new Date() : null,
      });
      return {
        found: true,
        justReviewedActionItems: Boolean(input.markActionItemsReviewed),
        justReviewedFollowUps: Boolean(input.markFollowUpsReviewed),
      };
    }

    const actionItemsWasReviewed = existingInsights.actionItemsReviewedAt !== null;
    const followUpsWasReviewed = existingInsights.followUpsReviewedAt !== null;

    const fieldsToUpdate: Partial<typeof schema.meetingInsights.$inferInsert> = {};
    if (input.keywords !== undefined) fieldsToUpdate.keywords = input.keywords;
    if (input.takeaways !== undefined) fieldsToUpdate.takeaways = input.takeaways;
    if (input.actionItems !== undefined) fieldsToUpdate.actionItems = input.actionItems;
    if (input.followUps !== undefined) fieldsToUpdate.followUps = input.followUps;
    if (input.markActionItemsReviewed) fieldsToUpdate.actionItemsReviewedAt = new Date();
    else if (input.resetActionItemsReview) fieldsToUpdate.actionItemsReviewedAt = null;
    if (input.markFollowUpsReviewed) fieldsToUpdate.followUpsReviewedAt = new Date();
    else if (input.resetFollowUpsReview) fieldsToUpdate.followUpsReviewedAt = null;

    if (Object.keys(fieldsToUpdate).length > 0) {
      await tx
        .update(schema.meetingInsights)
        .set(fieldsToUpdate)
        .where(eq(schema.meetingInsights.id, existingInsights.id));
    }

    return {
      found: true,
      justReviewedActionItems: Boolean(input.markActionItemsReviewed) && !actionItemsWasReviewed,
      justReviewedFollowUps: Boolean(input.markFollowUpsReviewed) && !followUpsWasReviewed,
    };
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

// --- Asana push (Action Items only — see src/integrations/asana.ts) --------------

export interface SendActionItemToAsanaResult {
  taskGid: string;
  /** True if this item already had a task (no new task was created). */
  alreadySent: boolean;
}

/**
 * Pushes one Action Item to Asana and records the created task's gid on
 * that item, so a later call for the same index is a no-op instead of
 * creating a duplicate task. `index` is the item's position in the meeting's
 * current actionItems array (same convention the review UI already uses).
 *
 * Returns null if the meeting/insights don't exist, or index is out of range
 * (caller should 404 either way).
 */
export async function sendActionItemToAsana(
  meetingId: string,
  index: number
): Promise<SendActionItemToAsanaResult | null> {
  const [meeting] = await db
    .select({ topic: schema.meetings.topic })
    .from(schema.meetings)
    .where(eq(schema.meetings.id, meetingId))
    .limit(1);
  if (!meeting) return null;

  const [existingInsights] = await db
    .select({ id: schema.meetingInsights.id, actionItems: schema.meetingInsights.actionItems })
    .from(schema.meetingInsights)
    .where(eq(schema.meetingInsights.meetingId, meetingId))
    .orderBy(desc(schema.meetingInsights.generatedAt))
    .limit(1);
  if (!existingInsights) return null;

  const actionItems = normalizeActionItems(existingInsights.actionItems);
  const item = actionItems[index];
  if (!item) return null;

  if (item.asanaTaskGid) {
    return { taskGid: item.asanaTaskGid, alreadySent: true };
  }

  const { taskGid } = await createAsanaTask({ text: item.text, meetingTopic: meeting.topic });
  actionItems[index] = { ...item, asanaTaskGid: taskGid };

  await db
    .update(schema.meetingInsights)
    .set({ actionItems })
    .where(eq(schema.meetingInsights.id, existingInsights.id));

  return { taskGid, alreadySent: false };
}

// --- Manual person-history page (#9, 2026-07-16) ----------------------------------
// On-demand only — no calendar integration (see personSummary.ts's header
// comment). Powers a "People" picker + a per-person detail page showing past
// meetings and follow-ups involving them.

export interface PersonListItem {
  id: string;
  name: string;
}

/** Every person who's attended at least one meeting. */
export async function listPeople(): Promise<PersonListItem[]> {
  const rows = await db
    .select({ id: schema.people.id, name: schema.people.name, email: schema.people.email })
    .from(schema.people)
    .innerJoin(schema.meetingParticipants, eq(schema.meetingParticipants.personId, schema.people.id));

  const byId = new Map<string, PersonListItem>();
  for (const row of rows) {
    byId.set(row.id, { id: row.id, name: row.name ?? row.email ?? "Unknown" });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface PersonMeetingSummary {
  meetingId: string;
  topic: string;
  startTime: Date;
  reviewStatus: ReviewStatus;
}

export interface PersonFollowUp extends FollowUpItem {
  meetingId: string;
  meetingTopic: string;
  meetingStartTime: Date;
}

export interface PersonDetail {
  id: string;
  name: string;
  meetings: PersonMeetingSummary[];
  // Approved follow-ups attributed to this person — matched by display name,
  // same linkage the rest of the dashboard uses for "person" (see
  // PersonTag.vue's comment: it's a plain name string, not a people.id FK).
  // There's no "done"/completed concept yet, so this is every approved
  // follow-up involving them, not just ones still outstanding.
  followUps: PersonFollowUp[];
}

/** Returns null if no person exists with this id (caller should 404). */
export async function getPersonDetail(personId: string): Promise<PersonDetail | null> {
  const [person] = await db
    .select({ id: schema.people.id, name: schema.people.name, email: schema.people.email })
    .from(schema.people)
    .where(eq(schema.people.id, personId))
    .limit(1);
  if (!person) return null;

  const name = person.name ?? person.email ?? "Unknown";

  const participantRows = await db
    .select({ meetingId: schema.meetingParticipants.meetingId })
    .from(schema.meetingParticipants)
    .where(eq(schema.meetingParticipants.personId, personId));
  const meetingIds = participantRows.map((row) => row.meetingId);

  if (meetingIds.length === 0) {
    return { id: person.id, name, meetings: [], followUps: [] };
  }

  const meetingRows = await db
    .select({ id: schema.meetings.id, topic: schema.meetings.topic, startTime: schema.meetings.startTime })
    .from(schema.meetings)
    .where(inArray(schema.meetings.id, meetingIds))
    .orderBy(desc(schema.meetings.startTime));

  const insightRows = await db
    .select({
      meetingId: schema.meetingInsights.meetingId,
      followUps: schema.meetingInsights.followUps,
      actionItemsReviewedAt: schema.meetingInsights.actionItemsReviewedAt,
      followUpsReviewedAt: schema.meetingInsights.followUpsReviewedAt,
    })
    .from(schema.meetingInsights)
    .where(inArray(schema.meetingInsights.meetingId, meetingIds));

  const insightsByMeeting = new Map(insightRows.map((row) => [row.meetingId, row]));

  const meetings: PersonMeetingSummary[] = meetingRows.map((m) => {
    const insights = insightsByMeeting.get(m.id);
    return {
      meetingId: m.id,
      topic: m.topic,
      startTime: m.startTime,
      reviewStatus: computeReviewStatus(
        Boolean(insights),
        insights?.actionItemsReviewedAt ?? null,
        insights?.followUpsReviewedAt ?? null
      ),
    };
  });

  const meetingById = new Map(meetingRows.map((m) => [m.id, m]));
  const followUps: PersonFollowUp[] = [];
  for (const row of insightRows) {
    const meeting = meetingById.get(row.meetingId);
    if (!meeting) continue;
    for (const f of normalizeFollowUps(row.followUps)) {
      if (!f.approved || f.person !== name) continue;
      followUps.push({
        ...f,
        meetingId: meeting.id,
        meetingTopic: meeting.topic,
        meetingStartTime: meeting.startTime,
      });
    }
  }
  followUps.sort((a, b) => b.meetingStartTime.getTime() - a.meetingStartTime.getTime());

  return { id: person.id, name, meetings, followUps };
}
