// Backs the redesigned Dashboard.vue's stat tiles + summary lists. Computed
// entirely client-side off the two calls the app already makes everywhere
// else (fetchMeetings/fetchFollowUps) — no new backend endpoints needed,
// same "personal scale, just filter in the browser" approach as
// MeetingsOverviewPanel's bucketByRecency.

import { computed, type Ref } from "vue";
import {
  fetchFollowUps,
  fetchMeetings,
  type ActionItemWithMeeting,
  type FollowUpWithMeeting,
  type MeetingListItem,
} from "../api";
import { useAsyncList } from "./useAsyncList";
import { UNCATEGORIZED_COMPANY_FILTER } from "./useCompanies";
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

// companyId: optional filter (added 2026-07-17) — when set, every stat/list
// below is scoped to meetings tagged with that one company. followUpData
// items don't carry their own company field, so they're matched via
// meetingCompanyById below (built off the same `meetings` list this
// composable already fetches).
export function useDashboardStats(companyId?: Ref<string | null>) {
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

  // Keyed by the full Company object (not just its id) so callers — e.g.
  // Dashboard.vue's Top Follow-ups list, whose items don't carry their own
  // `company` field — can render a company badge without a second lookup.
  const meetingCompanyById = computed(() => new Map(meetings.value.map((m) => [m.id, m.company])));

  function matchesCompanyFilter(meetingId: string): boolean {
    if (!companyId?.value) return true;
    const company = meetingCompanyById.value.get(meetingId) ?? null;
    if (companyId.value === UNCATEGORIZED_COMPANY_FILTER) return company === null;
    return company?.id === companyId.value;
  }

  const scopedMeetings = computed(() => {
    if (!companyId?.value) return meetings.value;
    if (companyId.value === UNCATEGORIZED_COMPANY_FILTER) return meetings.value.filter((m) => !m.company);
    return meetings.value.filter((m) => m.company?.id === companyId.value);
  });
  const scopedFollowUps = computed(() => followUpData.value.followUps.filter((f) => matchesCompanyFilter(f.meetingId)));
  const scopedActionItems = computed(() =>
    followUpData.value.actionItems.filter((a) => matchesCompanyFilter(a.meetingId))
  );

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

  const needsApprovalMeetings = computed(() => scopedMeetings.value.filter((m) => m.reviewStatus === "needs_review"));

  const actionItemsThisWeek = computed(() => toWeekStats(scopedActionItems.value));
  const followUpsThisWeek = computed(() => toWeekStats(scopedFollowUps.value));

  const overdueCutoff = new Date();
  overdueCutoff.setDate(overdueCutoff.getDate() - OVERDUE_DAYS);

  function isOverdue(item: { done?: boolean; meetingStartTime: string }): boolean {
    return !item.done && new Date(item.meetingStartTime).getTime() < overdueCutoff.getTime();
  }

  const overdueCount = computed(
    () => scopedActionItems.value.filter(isOverdue).length + scopedFollowUps.value.filter(isOverdue).length
  );

  const topFollowUpsThisWeek = computed(() =>
    sortByUrgency(scopedFollowUps.value.filter((f) => !f.done && isThisWeek(f.meetingStartTime))).slice(
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
    // Exposed so a template can look up a follow-up/action-item's company
    // badge (those items don't carry their own `company` field — see the
    // comment on meetingCompanyById above).
    meetingCompanyById,
  };
}
