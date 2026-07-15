// Review step for the suggest-then-approve workflow (added 2026-07-16 — see
// db/schema.ts's meeting_insights comment for the full rationale).
//
// This is what the meeting detail page's "Save selections" button calls once
// Peter has picked which of the 5-8 suggested action items/follow-ups to
// keep. It persists the selections and, the FIRST time a meeting's
// reviewedAt moves from null to set, fires the email/chat notifications with
// only the approved items — matching Peter's call that notifications should
// wait until review rather than firing immediately on raw AI output. Later
// re-saves of an already-reviewed meeting persist normally but don't
// re-fire notifications, so routine edits don't spam the same channels
// again.
//
// Takeaways are NOT part of this review step (changed 2026-07-16, per Peter
// — see extractInsights.ts): they're auto-approved at generation time, so
// `takeaways` here is optional and, when omitted, is simply left untouched.
//
// actionItems/followUps are ALSO optional (changed 2026-07-16, per Peter's
// per-panel save request): the Action Items and Follow-ups review columns
// now each have their own Save button, so a single call only ever includes
// the ONE category the user just saved — the other is omitted and left
// untouched, exactly like takeaways already worked.

import type { ActionItem, FollowUpItem, SuggestionItem } from "../../db/schema";
import { updateMeetingInsights } from "../server/queries";
import { sendNotifications, type SendNotificationsResult } from "../notify/sendNotifications";

export interface ReviewMeetingInput {
  /** Optional — the review UI can also let you tweak keywords in passing. */
  keywords?: string[];
  /** Optional — takeaways aren't reviewed/edited here anymore; omit to leave unchanged. */
  takeaways?: SuggestionItem[];
  /** Optional — omitted when only the other category is being saved this call. */
  actionItems?: ActionItem[];
  /** Optional — omitted when only the other category is being saved this call. */
  followUps?: FollowUpItem[];
}

export interface ReviewMeetingResult {
  meetingId: string;
  /** True only if this call is what moved the meeting from needs_review to reviewed. */
  justReviewed: boolean;
  /** Present only when justReviewed — the notification fire-and-log result. */
  notified?: SendNotificationsResult;
}

/** Returns null if no meeting exists with this id (caller should 404). */
export async function submitMeetingReview(
  meetingId: string,
  input: ReviewMeetingInput
): Promise<ReviewMeetingResult | null> {
  const { found, justReviewed } = await updateMeetingInsights(meetingId, {
    keywords: input.keywords,
    takeaways: input.takeaways,
    actionItems: input.actionItems,
    followUps: input.followUps,
    markReviewed: true,
  });

  if (!found) return null;

  if (!justReviewed) {
    return { meetingId, justReviewed: false };
  }

  // Only reached the first time reviewedAt transitions null -> set.
  const notified = await sendNotifications(meetingId);
  return { meetingId, justReviewed: true, notified };
}
