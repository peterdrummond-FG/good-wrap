// Shared "medium date + short time" formatting, used anywhere a meeting's
// startTime is shown as a full date+time (Dashboard.vue's list rows,
// MeetingsView.vue's header) — as opposed to the Meetings calendar panel's
// time-only formatting or dateBuckets.ts's recency bucketing, which have
// their own display needs.

export function formatMeetingDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
