// Shared Urgency (High/Medium/Low) helpers for Action Items/Follow-ups —
// replaces the earlier timing-based (Today/Tomorrow/This Week/...) grouping
// 2026-07-16 per Peter's request: he wanted suggestions triaged by how
// urgent they are, not by when the transcript implied they'd happen.
// Centralized here since Dashboard.vue's Top Follow-ups list and
// MeetingFollowUpsReview.vue's review column all need the same
// label/pill/sort logic.

import type { Urgency } from "./api";

export const URGENCY_ORDER: Record<Urgency, number> = { high: 0, medium: 1, low: 2 };

/** Sorts most urgent first. Returns a new array — never mutates the input,
 * so this is safe to call on a `reactive()` array backing checkbox v-models
 * without disturbing the underlying item identities. */
export function sortByUrgency<T extends { urgency: Urgency }>(items: T[]): T[] {
  return [...items].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
}

export function urgencyLabel(urgency: Urgency): string {
  return { high: "High", medium: "Medium", low: "Low" }[urgency];
}

export function urgencyPillClass(urgency: Urgency): string {
  return {
    high: "bw-pill--urgency-high",
    medium: "bw-pill--urgency-medium",
    low: "bw-pill--urgency-low",
  }[urgency];
}
