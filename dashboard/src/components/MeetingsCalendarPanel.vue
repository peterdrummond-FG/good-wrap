<template>
  <div class="bw-panel column">
    <div class="bw-panel__header column no-wrap">
      <div class="row items-center justify-between no-wrap">
        <div class="bw-panel__title">Meetings</div>
        <q-select
          v-model="selectedCompanyId"
          dense
          borderless
          emit-value
          map-options
          clearable
          options-dense
          class="bw-company-filter"
          :options="companyFilterOptions"
        >
          <!-- Quasar's `placeholder` prop renders via CSS on q-select and
               doesn't reserve real layout width here (dense + borderless +
               no v-model collapses the field down to just the dropdown
               icon) — an explicit #selected slot guarantees visible text
               either way, selected or not. -->
          <template #selected>
            {{ selectedCompanyLabel }}
          </template>
        </q-select>
      </div>
      <!-- Compact date-nav strip (replaces the old always-visible
           "Friday, July 17" subtitle line + separate "Today" button, UI/UX
           pass 2026-07-17) — the date label itself doubles as the range
           display, and doubling chevrons/label with the Today action below
           keeps this to one row instead of two.

           The label itself is the month-calendar expand/collapse trigger
           (extended same day) — there used to be a separate icon button for
           this elsewhere in the header, but it used the same calendar glyph
           as the Calendar/List mode toggle two rows down, so two
           different-purpose buttons looked like duplicates of each other.
           Folding the toggle into the date label removes that second
           calendar icon entirely instead of just re-skinning it. -->
      <div class="row items-center justify-between no-wrap q-mt-sm">
        <div class="row items-center no-wrap q-gutter-xs">
          <q-btn flat round dense size="sm" icon="chevron_left" @click="shiftRange(-1)" />
          <button
            type="button"
            class="bw-date-nav-label"
            :class="{ 'bw-date-nav-label--active': calendarExpanded }"
            :aria-expanded="calendarExpanded"
            aria-label="Toggle month calendar"
            @click="calendarExpanded = !calendarExpanded"
          >
            {{ formattedSelectedRange }}
            <q-icon :name="calendarExpanded ? 'expand_less' : 'expand_more'" size="18px" />
          </button>
          <q-btn flat round dense size="sm" icon="chevron_right" @click="shiftRange(1)" />
        </div>
        <q-btn v-if="!isToday" flat dense no-caps size="sm" label="Today" @click="goToday" />
      </div>

      <!-- Scope toggle + view-mode toggle (Peter's ask, 2026-07-16). The
           month grid below defaults to collapsed (calendarExpanded starts
           false, toggled from the date label above) since it was eating the
           majority of this panel's height for a feature (jumping to an
           arbitrary date) used far less often than the day-by-day
           chevron/Today nav above. It no longer auto-collapses when you
           pick a date (see onPickDate) — it's a plain toggle now, open until
           the date label is clicked again, so browsing several dates in a
           row doesn't mean reopening it each time. -->
      <div class="row items-center justify-between no-wrap q-mt-xs">
        <q-btn-toggle
          v-model="scope"
          dense
          no-caps
          unelevated
          toggle-color="primary"
          color="grey-9"
          text-color="grey-4"
          :options="[
            { label: 'Day', value: 'day' },
            { label: 'Week', value: 'week' },
          ]"
        />
        <!-- Calendar mode is day-only — switching to Week scope forces List
             mode (see the scope watcher below), so there's nothing to toggle
             here once Week is selected. -->
        <q-btn-toggle
          v-if="scope === 'day'"
          v-model="mode"
          dense
          unelevated
          toggle-color="primary"
          color="grey-9"
          text-color="grey-4"
          :options="[
            { icon: 'calendar_month', value: 'calendar' },
            { icon: 'view_list', value: 'list' },
          ]"
        />
      </div>
    </div>

    <div class="bw-panel__body col column">
      <!-- Hand-built month grid (replaces Quasar's q-date, 2026-07-16) — see
           the style block below for why: q-date's day cells are a fixed
           pixel size rather than width-relative, so it never actually filled
           this panel's width, and forcing it to stretch risked the same
           "fights back" behavior we hit trying to shrink its height (see
           the .bw-mini-cal comment). A plain CSS grid gives real control
           over both dimensions. Collapsed by default — see calendarExpanded
           comment above. -->
      <template v-if="calendarExpanded">
        <div class="bw-mini-cal">
          <!-- Single row (UI/UX pass 2026-07-17, was two rows: a month
               chevron-pair and a separate year chevron-pair) — shiftViewMonth
               already rolls the year over automatically (JS Date normalizes
               month overflow), so a second dedicated year nav was redundant
               for the common case of paging month-by-month. The year label
               is still directly jumpable via its own dropdown for a bigger
               leap, without a whole extra row of chevrons. -->
          <div class="bw-mini-cal__nav row items-center justify-center no-wrap q-gutter-xs">
            <q-btn flat round dense size="xs" icon="chevron_left" @click="shiftViewMonth(-1)" />
            <div class="bw-mini-cal__nav-label">{{ viewMonthLabel }}</div>
            <q-btn-dropdown flat dense no-caps size="xs" :label="viewYearLabel" class="bw-mini-cal__year-dropdown">
              <q-list dense>
                <q-item
                  v-for="y in yearOptions"
                  :key="y"
                  clickable
                  v-close-popup
                  :active="y === viewDate.getFullYear()"
                  @click="jumpToYear(y)"
                >
                  <q-item-section>{{ y }}</q-item-section>
                </q-item>
              </q-list>
            </q-btn-dropdown>
            <q-btn flat round dense size="xs" icon="chevron_right" @click="shiftViewMonth(1)" />
          </div>
          <div class="bw-mini-cal__weekdays">
            <span v-for="d in WEEKDAY_LABELS" :key="d">{{ d }}</span>
          </div>
          <div class="bw-mini-cal__grid">
            <template v-for="(cell, i) in monthCells" :key="i">
              <button
                v-if="cell"
                type="button"
                class="bw-mini-cal__cell"
                :class="{ 'bw-mini-cal__cell--today': cell.isToday, 'bw-mini-cal__cell--selected': cell.isSelected }"
                @click="onPickDate(cell.date)"
              >
                {{ cell.day }}
              </button>
              <div v-else class="bw-mini-cal__cell bw-mini-cal__cell--empty" />
            </template>
          </div>
        </div>

        <q-separator class="q-my-sm" />
      </template>

      <template v-if="mode === 'calendar'">
        <q-scroll-area v-if="dayMeetings.length" class="col">
          <div class="bw-calendar-timeline" :style="{ height: `${timelineHeight}px` }">
            <div v-for="h in hourMarks" :key="h" class="bw-calendar-hour" :style="{ top: `${hourTop(h)}px` }">
              <span class="bw-calendar-hour__label">{{ formatHourLabel(h) }}</span>
            </div>

            <button
              v-for="m in blockLayouts"
              :key="m.id"
              type="button"
              class="bw-calendar-block"
              :class="[pillClass(m.reviewStatus), { 'bw-calendar-block--selected': m.id === selectedMeetingId }]"
              :style="{ top: `${m.top}px`, height: `${m.height}px` }"
              @click="$emit('select', m.id)"
            >
              <CompanyTag v-if="m.company" :company="m.company" class="bw-calendar-block__company" />
              <div class="bw-calendar-block__time">{{ formatTime(m.startTime) }}</div>
              <div class="bw-calendar-block__title">{{ m.topic }}</div>
            </button>
          </div>
        </q-scroll-area>

        <div v-else class="text-grey-7 q-pa-md text-center">No meetings on this day.</div>
      </template>

      <template v-else>
        <q-scroll-area class="col">
          <template v-for="group in listGroups" :key="group.dateKey">
            <div v-if="group.label" class="bw-section-label">{{ group.label }}</div>
            <button
              v-for="m in group.items"
              :key="m.id"
              type="button"
              class="bw-row bw-list-row"
              :class="{ 'bw-list-row--selected': m.id === selectedMeetingId }"
              @click="$emit('select', m.id)"
            >
              <div class="row items-center justify-between no-wrap">
                <div class="col">
                  <div class="row items-center no-wrap">
                    <CompanyTag v-if="m.company" :company="m.company" class="bw-list-row__company" />
                    <div class="bw-row__title">{{ m.topic }}</div>
                  </div>
                  <div class="bw-row__meta">{{ formatTime(m.startTime) }}</div>
                </div>
                <span class="bw-pill" :class="pillClass(m.reviewStatus)">{{ listStatusLabel(m.reviewStatus) }}</span>
              </div>
            </button>
          </template>

          <div v-if="!hasAnyListItems" class="text-grey-7 q-pa-md text-center">
            {{ scope === "day" ? "No meetings on this day." : "No meetings this week." }}
          </div>
        </q-scroll-area>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { type MeetingListItem, type ReviewStatus } from "../api";
import { UNCATEGORIZED_COMPANY_FILTER, useCompanies } from "../composables/useCompanies";
import { isSameLocalDay, startOfDay, startOfWeek } from "../dateBuckets";
import { reviewStatusListLabel, reviewStatusPillClass } from "../reviewStatus";
import CompanyTag from "./CompanyTag.vue";

const props = defineProps<{
  meetings: MeetingListItem[];
  selectedDate: Date;
  selectedMeetingId: string | null;
}>();

// Company filter (added 2026-07-17) — lets Peter see all meetings for one
// portfolio company at a glance, both in Calendar and List mode.
const { companies } = useCompanies();
// UNCATEGORIZED_COMPANY_FILTER is distinct from `null` (which means "no
// filter, show all") — lets the dropdown also filter down to meetings with
// no company tag at all, same as the per-meeting picker's own
// "Uncategorized" option.
const selectedCompanyId = ref<string | null>(null);
const companyFilterOptions = computed(() => [
  { label: "Uncategorized", value: UNCATEGORIZED_COMPANY_FILTER },
  ...companies.value.map((c) => ({ label: c.name, value: c.id })),
]);
const selectedCompanyLabel = computed(() => {
  if (selectedCompanyId.value === UNCATEGORIZED_COMPANY_FILTER) return "Uncategorized";
  return companies.value.find((c) => c.id === selectedCompanyId.value)?.name ?? "All companies";
});
const filteredMeetings = computed(() => {
  if (!selectedCompanyId.value) return props.meetings;
  if (selectedCompanyId.value === UNCATEGORIZED_COMPANY_FILTER) return props.meetings.filter((m) => !m.company);
  return props.meetings.filter((m) => m.company?.id === selectedCompanyId.value);
});

const emit = defineEmits<{
  (e: "update:selectedDate", date: Date): void;
  (e: "select", meetingId: string): void;
}>();

const HOUR_HEIGHT = 60; // px per hour on the timeline
const DEFAULT_BLOCK_MINUTES = 30; // fallback block size when durationMinutes is null
const DAY_START_HOUR = 7; // full-day baseline; widened below for an outlier meeting
const DAY_END_HOUR = 19;

const scope = ref<"day" | "week">("day");
const mode = ref<"calendar" | "list">("calendar");
// Collapsed by default (see the template comment above) — the month grid is
// an occasional "jump to a date" tool, not something that needs to be on
// screen at all times next to the day-by-day chevron/Today nav.
const calendarExpanded = ref(false);

// Calendar mode only ever shows a single day, so it has no meaning once
// Week is selected — force List there, and restore Calendar (the default,
// more visual mode) on the way back to Day.
watch(scope, (next, prev) => {
  if (next === "week") mode.value = "list";
  else if (prev === "week") mode.value = "calendar";
});

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Stable per-day key for v-for (weekGroups below) — unrelated to q-date now
// that the mini calendar is hand-built, but still a convenient stable string
// key derived from a Date.
function toDateModel(d: Date): string {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

const weekStart = computed(() => startOfWeek(props.selectedDate));

// --- mini calendar (hand-built month grid) ---------------------------------
// Which month the grid is *displaying* — independent of selectedDate while
// the user browses months (mirrors q-date's old model-vs-view distinction).
// Re-synced whenever selectedDate changes from outside (day-nav, Today,
// clicking a meeting, or picking a day in the grid itself).
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const viewDate = ref<Date>(startOfMonth(props.selectedDate));

watch(
  () => props.selectedDate,
  (d) => {
    viewDate.value = startOfMonth(d);
  }
);

function shiftViewMonth(delta: number) {
  const d = viewDate.value;
  // Date's constructor normalizes month overflow/underflow on its own (month
  // 12 becomes January of the next year, month -1 becomes December of the
  // previous year) — paging month-by-month already rolls the year over for
  // free, which is what let the old dedicated year chevron-pair row go away.
  viewDate.value = new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

function jumpToYear(year: number) {
  const d = viewDate.value;
  viewDate.value = new Date(year, d.getMonth(), 1);
}

const viewMonthLabel = computed(() => viewDate.value.toLocaleDateString(undefined, { month: "long" }));
const viewYearLabel = computed(() => String(viewDate.value.getFullYear()));
// ±5 years around whatever month is currently displayed — recenters itself
// each time you jump, so repeated jumps don't wander out of the list.
const yearOptions = computed(() => {
  const base = viewDate.value.getFullYear();
  return Array.from({ length: 11 }, (_, i) => base - 5 + i);
});

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface MonthCell {
  date: Date;
  day: number;
  isToday: boolean;
  isSelected: boolean;
}

// Only as many rows as the displayed month actually needs (5 or 6), each a
// row of 7 cells — null for the leading/trailing padding around the 1st and
// last day.
const monthCells = computed<(MonthCell | null)[]>(() => {
  const year = viewDate.value.getFullYear();
  const month = viewDate.value.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const todayIso = new Date().toISOString();
  const selectedIso = props.selectedDate.toISOString();

  const cells: (MonthCell | null)[] = [];
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - firstWeekday + 1;
    if (dayNum < 1 || dayNum > daysInMonth) {
      cells.push(null);
      continue;
    }
    const date = new Date(year, month, dayNum);
    cells.push({
      date,
      day: dayNum,
      isToday: isSameLocalDay(todayIso, date),
      isSelected: isSameLocalDay(selectedIso, date),
    });
  }
  return cells;
});

const formattedSelectedRange = computed(() => {
  if (scope.value === "day") {
    return props.selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }
  const end = new Date(weekStart.value);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(weekStart.value)} – ${fmt(end)}`;
});

const isToday = computed(() => isSameLocalDay(new Date().toISOString(), props.selectedDate));

function onPickDate(date: Date) {
  emitDate(date);
  // No longer auto-collapses on pick (removed per Peter's feedback,
  // 2026-07-17) — the grid used to close itself after every single date
  // click, which made it unusable for browsing several dates in a row (open
  // it, look at one day, want to check the next, have to reopen it every
  // time). Expand/collapse is now a pure toggle driven only by the date
  // label click (see calendarExpanded above) — picking a date changes the
  // selection but leaves the grid exactly as the user left it.
}

function shiftRange(delta: number) {
  const unit = scope.value === "week" ? 7 : 1;
  const next = new Date(props.selectedDate);
  next.setDate(next.getDate() + delta * unit);
  emitDate(next);
}

function goToday() {
  emitDate(startOfDay(new Date()));
}

function emitDate(date: Date) {
  emit("update:selectedDate", date);
}

const dayMeetings = computed(() =>
  filteredMeetings.value
    .filter((m) => isSameLocalDay(m.startTime, props.selectedDate))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
);

// Tight-fit range: sized to just this day's meetings (+1hr padding either
// side) instead of a fixed baseline — a sparse day with one 10am meeting no
// Always show the full baseline day (scroll for anything outside it) —
// widened only for a meeting that actually falls outside 7am-7pm, so
// nothing ever renders clipped. Reverted 2026-07-16: a tight-fit range
// scoped to just that day's own meetings looked cramped/odd on a day with
// only 1-2 meetings.
const rangeStartHour = computed(() =>
  Math.min(DAY_START_HOUR, ...dayMeetings.value.map((m) => new Date(m.startTime).getHours()))
);
const rangeEndHour = computed(() =>
  Math.max(
    DAY_END_HOUR,
    ...dayMeetings.value.map((m) => {
      const start = new Date(m.startTime);
      const endMinutes = start.getHours() * 60 + start.getMinutes() + (m.durationMinutes ?? DEFAULT_BLOCK_MINUTES);
      return Math.ceil(endMinutes / 60);
    })
  )
);

const hourMarks = computed(() => {
  const marks: number[] = [];
  for (let h = rangeStartHour.value; h <= rangeEndHour.value; h++) marks.push(h);
  return marks;
});

function hourTop(hour: number): number {
  return (hour - rangeStartHour.value) * HOUR_HEIGHT;
}

function formatHourLabel(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { timeStyle: "short" });
}

// Tall enough that a block's own two lines (time + title) never overflow
// its own box — the previous 28px minimum was sized for one line and let
// text bleed past the bubble on short meetings (Peter's report).
const MIN_BLOCK_HEIGHT = 40;
// Vertical breathing room enforced between two blocks below, even when
// their real start times are only minutes apart.
const BLOCK_GAP = 3;

// Positions blocks strictly top-to-bottom by real start time, but pushes a
// block down (past its raw time-based position) if the previous block —
// itself padded to MIN_BLOCK_HEIGHT — would otherwise overlap it. Two
// meetings a few minutes apart no longer render on top of each other; this
// trades exact to-scale positioning for blocks that are always readable,
// same tradeoff already made for the tight-fit hour range above.
const blockLayouts = computed(() => {
  let prevBottom = -Infinity;
  return dayMeetings.value.map((m) => {
    const start = new Date(m.startTime);
    const startMinutesFromRangeStart = (start.getHours() - rangeStartHour.value) * 60 + start.getMinutes();
    const durationMinutes = m.durationMinutes ?? DEFAULT_BLOCK_MINUTES;
    const rawTop = (startMinutesFromRangeStart / 60) * HOUR_HEIGHT;
    const height = Math.max((durationMinutes / 60) * HOUR_HEIGHT, MIN_BLOCK_HEIGHT);
    const top = Math.max(rawTop, prevBottom + BLOCK_GAP);
    prevBottom = top + height;
    return { ...m, top, height };
  });
});

const timelineHeight = computed(() => {
  const natural = (rangeEndHour.value - rangeStartHour.value) * HOUR_HEIGHT;
  const layouts = blockLayouts.value;
  if (!layouts.length) return natural;
  const lastBottom = Math.max(...layouts.map((l) => l.top + l.height));
  return Math.max(natural, lastBottom);
});

function pillClass(status: ReviewStatus): string {
  return reviewStatusPillClass(status);
}

function listStatusLabel(status: ReviewStatus): string {
  return reviewStatusListLabel(status);
}

interface ListGroup {
  label: string | null;
  dateKey: string;
  items: MeetingListItem[];
}

// Week scope's own filtered+sorted set, bucketed by local calendar day below
// (isSameLocalDay) — separate from dayMeetings above, which stays
// day-scoped for the calendar timeline.
const weekMeetings = computed(() => {
  const start = weekStart.value.getTime();
  const end = new Date(weekStart.value);
  end.setDate(end.getDate() + 7);
  const endTime = end.getTime();
  return filteredMeetings.value
    .filter((m) => {
      const t = startOfDay(new Date(m.startTime)).getTime();
      return t >= start && t < endTime;
    })
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
});

const weekGroups = computed<ListGroup[]>(() => {
  const groups: ListGroup[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(weekStart.value);
    day.setDate(day.getDate() + i);
    const items = weekMeetings.value.filter((m) => isSameLocalDay(m.startTime, day));
    if (!items.length) continue;
    groups.push({
      label: day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
      dateKey: toDateModel(day),
      items,
    });
  }
  return groups;
});

// Unifies day scope (one ungrouped list, no header) and week scope (one
// group per non-empty day, with a header) behind a single template loop.
const listGroups = computed<ListGroup[]>(() =>
  scope.value === "day" ? [{ label: null, dateKey: "day", items: dayMeetings.value }] : weekGroups.value
);

const hasAnyListItems = computed(() => listGroups.value.some((g) => g.items.length));
</script>

<style scoped>
.bw-company-filter {
  max-width: 140px;
  font-size: 0.75rem;
}
/* Compact date-nav strip label (replaces the old .bw-panel__subtitle line —
   UI/UX pass 2026-07-17). A real <button> (doubles as the month-calendar
   expand/collapse trigger, extended same day) rather than a plain div —
   reset to look like text at rest, with a hover/active glass treatment so
   it reads as clickable without competing with the chevrons beside it. */
.bw-date-nav-label {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: #fff;
  min-width: 128px;
  justify-content: center;
  border: none;
  border-radius: var(--glass-radius-md);
  background: transparent;
  padding: 4px 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.bw-date-nav-label:hover {
  background: rgba(255, 255, 255, 0.08);
}
.bw-date-nav-label--active {
  background: rgba(124, 111, 238, 0.16);
  color: #b3a9ff;
}
/* Hand-built mini month calendar (replaces Quasar's q-date, 2026-07-16) —
   Peter's ask was for it to fill the panel's full width, which q-date never
   did (its day-cell buttons are a fixed pixel size, not width-relative, so
   it always rendered as a ~290px box regardless of container width). We'd
   already hit this component fighting back once this session (shrinking
   its height via :deep() overrides paradoxically made rows *taller*, since
   freeing up width via padding fed right back into its own width-driven
   height calc) — rather than risk that again forcing width to stretch, a
   plain CSS grid gives real control over both dimensions: columns via
   `1fr` fill the full width, and row height is set directly and totally
   independent of column width (unlike q-date's square-ish cells). Natural
   height ends up small (~170px for nav+weekdays+6 rows) and predictable, so
   it just sits flex-shrink:0 and lets the timeline/list below (flex:1) take
   the rest — no artificial percentage cap needed the way q-date required. */
.bw-mini-cal {
  flex-shrink: 0;
  width: 100%;
}
.bw-mini-cal__nav {
  margin-bottom: 2px;
}
.bw-mini-cal__nav-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #fff;
  min-width: 44px;
  text-align: center;
}
/* Year jump dropdown (replaces the old dedicated year chevron-pair row,
   UI/UX pass 2026-07-17) — sized to match .bw-mini-cal__nav-label's weight
   so "July" and "2026" read as one continuous label despite one being a
   plain span and the other a button. */
.bw-mini-cal__year-dropdown :deep(.q-btn__content) {
  font-size: 0.8rem;
  font-weight: 600;
  color: #fff;
}
.bw-mini-cal__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 2px;
}
.bw-mini-cal__weekdays span {
  text-align: center;
  font-size: 0.65rem;
  color: var(--bw-text-dim);
}
.bw-mini-cal__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  /* Height dropped to 26px (from 36px, UI/UX pass 2026-07-17 — Peter asked
     twice for this to be thinner) while keeping width at 34px — decoupled
     on purpose. 22px (the original size, before the touch-target fix a few
     revisions back) was well under the 44x44px guideline; going back to a
     square cell to save height would repeat that mistake. A wide-but-short
     cell keeps a reasonable tap target (34×26 ≈ 884px² vs. a 30×30 square's
     900px²) while actually addressing "too tall", which is specifically a
     vertical complaint. Rounded-rect instead of a circle below, since a
     circle needs equal width/height to not look stretched. */
  grid-auto-rows: 26px;
  row-gap: 2px;
}
.bw-mini-cal__cell {
  width: 34px;
  height: 26px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #e7e8ec;
  font-size: 0.78rem;
  line-height: 1;
  cursor: pointer;
}
.bw-mini-cal__cell:hover {
  background: rgba(255, 255, 255, 0.08);
}
.bw-mini-cal__cell--today {
  border: 1px solid var(--q-primary);
}
.bw-mini-cal__cell--selected {
  background: var(--q-primary);
  color: #fff;
  font-weight: 700;
}
.bw-mini-cal__cell--empty {
  pointer-events: none;
}
.bw-calendar-timeline {
  position: relative;
  margin-left: 52px;
  border-left: 1px solid var(--bw-border);
}
.bw-calendar-hour {
  position: absolute;
  left: 0;
  width: 100%;
  border-top: 1px solid var(--bw-border);
}
.bw-calendar-hour__label {
  position: absolute;
  left: -52px;
  top: -8px;
  width: 44px;
  text-align: right;
  font-size: 0.7rem;
  color: var(--bw-text-dim);
}
.bw-calendar-block {
  position: absolute;
  left: 10px;
  right: 4px;
  border: none;
  border-radius: 8px;
  padding: 4px 8px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  background: rgba(124, 111, 238, 0.18);
  color: #b3a9ff;
}
.bw-calendar-block--selected {
  outline: 2px solid var(--q-primary);
  outline-offset: 1px;
}
.bw-calendar-block__company {
  position: absolute;
  top: 4px;
  right: 6px;
}
.bw-calendar-block__time {
  font-size: 0.68rem;
  font-weight: 600;
  opacity: 0.85;
}
.bw-calendar-block__title {
  font-size: 0.8rem;
  font-weight: 600;
  color: #fff;
  padding-right: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --- list mode rows (button reset — .bw-row is normally a block/link) ---- */
.bw-list-row {
  position: relative;
  display: block;
  width: 100%;
  border: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.bw-list-row--selected {
  outline: 2px solid var(--q-primary);
  outline-offset: 1px;
}
.bw-list-row__company {
  margin-right: 6px;
  flex-shrink: 0;
}
</style>
