// Shared "Today / Yesterday / This Week / Older" bucketing logic, used by
// both the Meetings Overview panel and (if needed elsewhere) anything else
// that groups items by recency. Local-calendar-day based, not a rolling 24h
// window — "yesterday" means the previous calendar date, matching how a
// person would describe it.

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Week starts Monday. "This week" excludes today/yesterday (they get their
// own buckets) but still covers the rest of the current calendar week.
// Exported for the Dashboard's Mon-Sun weekly stats (useDashboardStats.ts).
export function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMonday);
}

// Local-calendar-day equality check — used by the Meetings screen's calendar
// panel to filter the full meetings list down to whatever day is selected.
export function isSameLocalDay(iso: string, date: Date): boolean {
  return startOfDay(new Date(iso)).getTime() === startOfDay(date).getTime();
}

export type RecencyBucket = "today" | "yesterday" | "thisWeek" | "older";

export function bucketByRecency(iso: string, now: Date = new Date()): RecencyBucket {
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekStart = startOfWeek(now);

  const day = startOfDay(new Date(iso));
  if (day.getTime() === today.getTime()) return "today";
  if (day.getTime() === yesterday.getTime()) return "yesterday";
  if (day.getTime() >= weekStart.getTime() && day.getTime() < today.getTime()) return "thisWeek";
  return "older";
}
