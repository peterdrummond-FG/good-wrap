// Backs the redesigned Dashboard.vue's stat tiles + summary lists. Computed
// entirely client-side off the two calls the app already makes everywhere
// else (fetchMeetings/fetchFollowUps) — no new backend endpoints needed,
// same "personal scale, just filter in the browser" approach as
// MeetingsOverviewPanel's bucketByRecency.

import { computed } from "vue";
import {
  fetchFollowUps,
  fetchMeetings,
  type ActionItemWithMeeting,
  type FollowUpWithMeeting,
  type MeetingListItem,
} from "../api";
import { useAsyncList } from "./useAsyncList";
import { startOfWeek } from "../dateBuckets";
import { sortByUrgency } from "../urgency";

// Approved-and-not-done items whose meeting happened more than this many
// days ago — a proxy for "overdue" since items have no approved-at
// timestamp of their own, only the meeting's startTime.
const OVERDUE_DAYS = 3;
const TOP_FOLLOW_UPS_LIMIT = 5;
const MEETINGS_NEEDING_APPROVAL_LIMIT = 5;

export interface CategoryWeekStats {
  total: number;
  open: number;
  done: number;
}

export function useDashboardStats() {
  const {
    data: meetings,
    loading: meetingsLoading,
    error: meetingsError,
  } = useAsyncList(async () => (await fetchMeetings()).meetings, [] as MeetingListItem[]);

  const {
    data: followUpData,
    loading: followUpsLoading,
    error: followUpsError,
  } = useAsyncList(async () => fetchFollowUps(), {
    followUps: [] as FollowUpWithMeeting[],
    actionItems: [] as ActionItemWithMeeting[],
  });

  const loading = computed(() => meetingsLoading.value || followUpsLoading.value);
  const error = computed(() => meetingsError.value || followUpsError.value);

  // Mon-Sun, computed once per render pass rather than kept reactive to the
  // literal current instant — good enough for a dashboard that's re-fetched
  // on every page load.
  const weekStart = startOfWeek(new Date());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  function isThisWeek(iso: string): boolean {
    const t = new Date(iso).getTime();
    return t >= weekStart.getTime() && t < weekEnd.getTime();
  }

  function toWeekStats<T extends { done?: boolean; meetingStartTime: string }>(items: T[]): CategoryWeekStats {
    const thisWeek = items.filter((i) => isThisWeek(i.meetingStartTime));
    const done = thisWeek.filter((i) => i.done).length;
    return { total: thisWeek.length, open: thisWeek.length - done, done };
  }

  const needsApprovalMeetings = computed(() => meetings.value.filter((m) => m.reviewStatus === "needs_review"));

  const actionItemsThisWeek = computed(() => toWeekStats(followUpData.value.actionItems));
  const followUpsThisWeek = computed(() => toWeekStats(followUpData.value.followUps));

  const overdueCutoff = new Date();
  overdueCutoff.setDate(overdueCutoff.getDate() - OVERDUE_DAYS);

  function isOverdue(item: { done?: boolean; meetingStartTime: string }): boolean {
    return !item.done && new Date(item.meetingStartTime).getTime() < overdueCutoff.getTime();
  }

  const overdueCount = computed(
    () =>
      followUpData.value.actionItems.filter(isOverdue).length +
      followUpData.value.followUps.filter(isOverdue).length
  );

  const topFollowUpsThisWeek = computed(() =>
    sortByUrgency(followUpData.value.followUps.filter((f) => !f.done && isThisWeek(f.meetingStartTime))).slice(
      0,
      TOP_FOLLOW_UPS_LIMIT
    )
  );

  const meetingsNeedingApproval = computed(() =>
    [...needsApprovalMeetings.value]
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
      .slice(0, MEETINGS_NEEDING_APPROVAL_LIMIT)
  );

  return {
    loading,
    error,
    needsApprovalCount: computed(() => needsApprovalMeetings.value.length),
    actionItemsThisWeek,
    followUpsThisWeek,
    overdueCount,
    topFollowUpsThisWeek,
    meetingsNeedingApproval,
  };
}
