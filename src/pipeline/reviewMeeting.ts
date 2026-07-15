// Review step for the suggest-then-approve workflow (added 2026-07-16 — see
// db/schema.ts's meeting_insights comment for the full rationale).
//
// This is what each review column's own Save button calls once Peter has
// picked which of the 5-8 suggested action items/follow-ups to keep. It
// persists that ONE category's selections and, the FIRST time THAT
// category's reviewed-at moves from null to set, fires the email/chat
// notifications with whatever's currently approved across all categories —
// matching Peter's call that notifications should wait until review rather
// than firing immediately on raw AI output. Later re-saves of an
// already-reviewed category persist normally but don't re-fire
// notifications, so routine edits don't spam the same channels again.
//
// Split 2026-07-15 (CODE-AUDIT.md items #2/#3/#4) from a single meeting-wide
// reviewedAt to independent action-items/follow-ups tracking: with per-panel
// Save buttons, only ONE category is ever included in a given call, so a
// single shared "reviewed" flag meant only the first-saved category could
// ever trigger a notification — approving the other category later would
// silently never notify. Now each category's own first save fires its own
// notification (which, since it re-reads the whole meeting_insights row,
// naturally includes whatever the OTHER category currently has approved
// too — so if that happens to be empty because you haven't gotten to it
// yet, you'll simply see another notification once you do).
//
// Takeaways are NOT part of this review step at all (changed 2026-07-16, per
// Peter — see extractInsights.ts): they're auto-approved at generation time,
// so `takeaways` here is optional and, when omitted, is simply left
// untouched. They have no reviewed-at of their own.
//
// A given call is expected to include exactly one of actionItems/followUps
// (matching the two independent Save buttons) — both optional so a
// keywords-only call is possible without accidentally marking either
// category reviewed (previously a real bug: the old single `markReviewed`
// flag fired on ANY call through this endpoint, keywords-only included).

import type { ActionItem, FollowUpItem, SuggestionItem } from "../../db/schema";
import { updateMeetingInsights } from "../server/queries";
import { sendNotifications, type SendNotificationsResult } from "../notify/sendNotifications";

export interface ReviewMeetingInput {
  /** Optional — the review UI can also let you tweak keywords in passing. */
  keywords?: string[];
  /** Optional — takeaways aren't reviewed/edited here anymore; omit to leave unchanged. */
  takeaways?: SuggestionItem[];
  /** Optional — present only when this call is saving the Action Items panel. */
  actionItems?: ActionItem[];
  /** Optional — present only when this call is saving the Follow-ups panel. */
  followUps?: FollowUpItem[];
}

export interface ReviewMeetingResult {
  meetingId: string;
  /** True only if THIS call is what moved Action Items from needs_review to reviewed. */
  justReviewedActionItems: boolean;
  /** True only if THIS call is what moved Follow-ups from needs_review to reviewed. */
  justReviewedFollowUps: boolean;
  /** Present only when either justReviewed* flag is true — the notification fire-and-log result. */
  notified?: SendNotificationsResult;
}

/** Returns null if no meeting exists with this id (caller should 404). */
export async function submitMeetingReview(
  meetingId: string,
  input: ReviewMeetingInput
): Promise<ReviewMeetingResult | null> {
  const { found, justReviewedActionItems, justReviewedFollowUps } = await updateMeetingInsights(meetingId, {
    keywords: input.keywords,
    takeaways: input.takeaways,
    actionItems: input.actionItems,
    followUps: input.followUps,
    // Only mark a category reviewed if THIS call actually included it — a
    // keywords-only or takeaways-only call must never flip either flag.
    markActionItemsReviewed: input.actionItems !== undefined,
    markFollowUpsReviewed: input.followUps !== undefined,
  });

  if (!found) return null;

  if (!justReviewedActionItems && !justReviewedFollowUps) {
    return { meetingId, justReviewedActionItems: false, justReviewedFollowUps: false };
  }

  // Reached whenever THIS call is what first-reviewed either category.
  const notified = await sendNotifications(meetingId);
  return { meetingId, justReviewedActionItems, justReviewedFollowUps, notified };
}
