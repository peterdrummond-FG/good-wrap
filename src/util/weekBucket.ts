// Buckets a date into a "<year>/week-<NN>" folder path, for organizing
// scanFolder.ts's processed/ archive so it doesn't stay one giant flat
// folder forever (Peter's ask, 2026-07-20).
//
// Week numbering follows the standard ISO-8601 rule (Monday-start weeks,
// week 1 is whichever week contains the year's first Thursday) — a
// well-known, unambiguous algorithm. The YEAR in the folder path, however,
// is deliberately the plain calendar year (date.getFullYear()), NOT the
// stricter ISO week-year. True ISO week-years can put e.g. Jan 1 in "week
// 52/53 of last year" or Dec 31 in "week 1 of next year" — correct for
//計算 purposes, but a confusing surprise for a browsing-convenience folder
// (a January meeting filed under last year's folder). This only changes
// which folder the ~1 week/year at each boundary lands in; the week
// *number* itself is still the real ISO week number for that date.
//
// Verified boundary cases (see the calculation this file's own logic
// produces, checked by hand): 2026-01-01 and 2026-12-31 both fall on a
// Thursday, so calendar-year and strict-ISO agree for that year-end
// (2026/week-01 and 2026/week-53 respectively — no divergence). The actual
// divergence shows up at 2027-01-01/02/03 (Fri/Sat/Sun): strict ISO would
// call these "week 53 of ISO-year 2026", but this function deliberately
// files them under "2027/week-53" — same week NUMBER, calendar-year folder.
import path from "node:path";

export function computeWeekBucket(date: Date): string {
  // Work in UTC throughout so this doesn't shift by a day depending on the
  // host's local timezone/DST — same defensive approach as dateBuckets.ts's
  // local-day comparisons on the dashboard side, just UTC instead of local
  // since this only needs to be internally consistent, not match a user's
  // wall-clock day.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // shift to this week's Thursday

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);

  const weekNum = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));

  return path.join(String(date.getUTCFullYear()), `week-${String(weekNum).padStart(2, "0")}`);
}
