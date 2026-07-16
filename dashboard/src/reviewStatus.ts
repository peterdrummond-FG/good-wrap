// Shared review-status pill styling, used by MeetingsPanel.vue (list view)
// and MeetingDetail.vue (single-meeting view) — the pill *class* is
// identical in both; the *label* text intentionally differs by context
// ("Pending" reads fine scanning a list of many meetings, "Not processed" is
// clearer when you're already looking at just the one).

import type { ReviewStatus } from "./api";

export function reviewStatusPillClass(status: ReviewStatus): string {
  return {
    pending: "bw-pill--pending",
    needs_review: "bw-pill--needs-review",
    reviewed: "bw-pill--processed",
  }[status];
}

/** Label for the meetings list (MeetingsPanel.vue). */
export function reviewStatusListLabel(status: ReviewStatus): string {
  return { pending: "Pending", needs_review: "Needs review", reviewed: "Reviewed" }[status];
}

/** Label for the single-meeting detail page (MeetingDetail.vue). */
export function reviewStatusDetailLabel(status: ReviewStatus): string {
  return { pending: "Not processed", needs_review: "Needs review", reviewed: "Reviewed" }[status];
}
