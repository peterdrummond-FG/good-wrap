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
//
// Regenerating a category doesn't discard approvals already made in THAT
// category, either (same fix as processMeeting.ts, CODE-AUDIT.md item #5,
// extended here 2026-07-16) — see mergeApprovedForward.

import { updateMeetingInsights, getMeetingDetail, type MeetingDetail } from "../server/queries";
import { loadMeetingContext } from "./meetingContext";
import { extractInsights } from "./extractInsights";
import { mergeApprovedForward } from "./mergeApprovedForward";

export type RegenerateCategory = "takeaways" | "actionItems" | "followUps";

export async function regenerateInsightCategory(
  meetingId: string,
  category: RegenerateCategory
): Promise<MeetingDetail | null> {
  // See processMeeting.ts's identical need — same shared helper so the two
  // can't drift out of sync on how any of this is resolved.
  const context = await loadMeetingContext(meetingId);
  if (!context) return null;
  const { meeting, transcript, owner, participantNames, participants, knownPeopleNames } = context;

  // Capture what's currently approved in the targeted category so it isn't
  // lost when it's replaced below — see mergeApprovedForward.
  const existing = await getMeetingDetail(meetingId);

  const fresh = await extractInsights({
    topic: meeting.topic,
    participants,
    transcript: transcript.rawText,
    meetingDate: meeting.startTime.toISOString(),
    participantNames,
    ownerName: owner.name,
    knownPeopleNames,
  });

  switch (category) {
    case "takeaways": {
      // Auto-approved with no review step (see extractInsights.ts) — nothing
      // to protect, always fully replaced.
      await updateMeetingInsights(meetingId, { takeaways: fresh.takeaways });
      break;
    }
    case "actionItems": {
      const previouslyApproved = (existing?.insights?.actionItems ?? []).filter((a) => a.approved);
      await updateMeetingInsights(meetingId, {
        actionItems: mergeApprovedForward(previouslyApproved, fresh.actionItems),
        resetActionItemsReview: true,
      });
      break;
    }
    case "followUps": {
      const previouslyApproved = (existing?.insights?.followUps ?? []).filter((f) => f.approved);
      await updateMeetingInsights(meetingId, {
        followUps: mergeApprovedForward(previouslyApproved, fresh.followUps),
        resetFollowUpsReview: true,
      });
      break;
    }
  }

  return getMeetingDetail(meetingId);
}
