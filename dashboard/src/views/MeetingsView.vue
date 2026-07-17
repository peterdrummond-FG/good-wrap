<template>
  <q-page class="q-pa-md bw-meetings-page">
    <div class="row no-wrap bw-meetings-layout">
      <div class="bw-meetings-layout__calendar">
        <MeetingsCalendarPanel
          :meetings="meetings"
          :selected-date="selectedDate"
          :selected-meeting-id="selectedMeetingId"
          @update:selected-date="onDateChange"
          @select="onSelectMeeting"
        />
      </div>

      <div class="bw-meetings-layout__detail">
        <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
          {{ error }}
        </q-banner>

        <template v-if="meeting">
          <div class="bw-panel q-pa-lg column" style="height: auto; min-height: 100%">
            <div class="row items-center justify-between q-mb-sm">
              <div class="row items-center q-gutter-sm">
                <div class="text-h6">{{ meeting.topic }}</div>
                <span class="bw-pill" :class="pillClass(meeting.reviewStatus)">{{
                  reviewStatusLabel(meeting.reviewStatus)
                }}</span>
              </div>
              <div class="row q-gutter-sm">
                <q-btn
                  v-if="meeting.insights"
                  outline color="primary" icon="refresh" label="Reprocess" dense no-caps
                  :loading="processing"
                  @click="confirmReprocess"
                />
                <q-btn outline color="primary" icon="edit" label="Edit" dense no-caps @click="editDialogOpen = true" />
                <q-btn
                  outline color="negative" icon="delete" label="Delete" dense no-caps
                  :loading="deleting"
                  @click="confirmDelete"
                />
              </div>
            </div>

            <div class="text-caption text-grey-6 q-mb-md">
              {{ formatDate(meeting.startTime) }}
              <span v-if="meeting.durationMinutes"> · {{ meeting.durationMinutes }} min</span>
              <span v-if="meeting.participants.length">
                ·
                <template v-for="(p, i) in meeting.participants" :key="p"
                  ><PersonTag :name="p" /><span v-if="i < meeting.participants.length - 1">, </span></template
                >
              </span>
              <span> · source: {{ meeting.source }}</span>
            </div>

            <q-card
              v-if="!meeting.insights"
              flat bordered class="q-pa-md q-mb-md"
              style="background: var(--bw-surface-raised)"
            >
              <div class="row items-center">
                <div class="col">
                  This meeting hasn't been processed yet — no suggestions to review.
                  {{ " " }}Meetings normally process automatically right after capture; this one either
                  predates that or its automatic run failed.
                </div>
                <q-btn color="primary" label="Process this meeting" :loading="processing" @click="onProcess" unelevated />
              </div>
            </q-card>

            <template v-else>
              <MeetingTakeawaysStrip
                :takeaways="meeting.insights.takeaways"
                :regenerating="regeneratingTakeaways"
                @regenerate="onRegenerateTakeaways"
              />

              <div class="row q-col-gutter-md col" style="min-height: 0">
                <div class="col-12 col-md-6" style="min-height: 0">
                  <MeetingActionItemsReview
                    :key="`ai-${meeting.id}`"
                    ref="actionItemsReviewRef"
                    :meeting-id="meeting.id"
                    :meeting="meeting"
                    @update:meeting="onMeetingUpdated"
                  />
                </div>
                <div class="col-12 col-md-6" style="min-height: 0">
                  <MeetingFollowUpsReview
                    :key="`fu-${meeting.id}`"
                    ref="followUpsReviewRef"
                    :meeting-id="meeting.id"
                    :meeting="meeting"
                    @update:meeting="onMeetingUpdated"
                  />
                </div>
              </div>

              <q-expansion-item label="Full transcript" class="q-mt-md" dense-toggle>
                <q-card flat bordered style="background: var(--bw-surface-raised)">
                  <q-card-section style="white-space: pre-wrap; max-height: 400px; overflow-y: auto">
                    {{ meeting.transcript ?? "(no transcript)" }}
                  </q-card-section>
                </q-card>
              </q-expansion-item>
            </template>
          </div>
        </template>

        <div v-else-if="!loadingMeeting" class="bw-panel column flex flex-center full-height text-grey-6">
          No meeting selected for this day.
        </div>

        <q-inner-loading :showing="loadingMeeting" />
      </div>
    </div>

    <MeetingEditDialog v-if="meeting" v-model="editDialogOpen" :meeting="meeting" @saved="onMeetingUpdated" />
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Dialog, Notify } from "quasar";
import {
  deleteMeeting,
  fetchMeetingDetail,
  fetchMeetings,
  processMeeting,
  regenerateInsightCategory,
  type MeetingDetail,
  type MeetingListItem,
} from "../api";
import { useAsyncList } from "../composables/useAsyncList";
import { isSameLocalDay, startOfDay } from "../dateBuckets";
import { formatMeetingDateTime as formatDate } from "../formatDate";
import { reviewStatusDetailLabel as reviewStatusLabel, reviewStatusPillClass as pillClass } from "../reviewStatus";
import PersonTag from "../components/PersonTag.vue";
import MeetingsCalendarPanel from "../components/MeetingsCalendarPanel.vue";
import MeetingTakeawaysStrip from "../components/MeetingTakeawaysStrip.vue";
import MeetingActionItemsReview from "../components/MeetingActionItemsReview.vue";
import MeetingFollowUpsReview from "../components/MeetingFollowUpsReview.vue";
import MeetingEditDialog from "../components/MeetingEditDialog.vue";

// Optional route param — "/meetings" (nav link) and "/meetings/:id" (deep
// link from Capture/Ask/Person Detail, or picking a meeting on this page)
// are the same route; props.id is undefined for the former.
const props = defineProps<{ id?: string }>();
const route = useRoute();
const router = useRouter();

const { data: meetings, loading: meetingsLoading, refetch: refetchMeetings } = useAsyncList(
  async () => (await fetchMeetings()).meetings,
  [] as MeetingListItem[]
);

const selectedDate = ref<Date>(startOfDay(new Date()));
const selectedMeetingId = ref<string | null>(props.id ?? null);
const meeting = ref<MeetingDetail | null>(null);
const loadingMeeting = ref(false);
const error = ref("");
const editDialogOpen = ref(false);
const deleting = ref(false);
const processing = ref(false);
const regeneratingTakeaways = ref(false);

const actionItemsReviewRef = ref<{ resetCopy: () => void } | null>(null);
const followUpsReviewRef = ref<{ resetCopy: () => void } | null>(null);

function meetingsForDate(date: Date): MeetingListItem[] {
  return meetings.value
    .filter((m) => isSameLocalDay(m.startTime, date))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

function autoSelectForDate(date: Date) {
  const dayItems = meetingsForDate(date);
  if (dayItems.length) router.replace(`/meetings/${dayItems[0].id}`).catch(() => {});
}

async function loadMeeting(id: string) {
  loadingMeeting.value = true;
  error.value = "";
  try {
    const result = await fetchMeetingDetail(id);
    meeting.value = result.meeting;
    selectedMeetingId.value = id;
    selectedDate.value = startOfDay(new Date(result.meeting.startTime));
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingMeeting.value = false;
  }
}

// Drives loading whenever the route's :id changes — via a direct nav link,
// a calendar-block click (onSelectMeeting), or day navigation auto-selecting
// a day's first meeting (autoSelectForDate). Bare "/meetings" clears the
// selection and, once the meetings list is loaded, tries to auto-select
// today's earliest meeting.
watch(
  () => props.id,
  (id) => {
    if (id) {
      loadMeeting(id);
    } else {
      selectedMeetingId.value = null;
      meeting.value = null;
      if (!meetingsLoading.value) autoSelectForDate(selectedDate.value);
    }
  },
  { immediate: true }
);

// Covers the initial bare "/meetings" visit, where the list is still loading
// when the watcher above first runs.
watch(meetingsLoading, (loading) => {
  if (!loading && !props.id) autoSelectForDate(selectedDate.value);
});

function onSelectMeeting(id: string) {
  if (id !== route.params.id) router.push(`/meetings/${id}`).catch(() => {});
}

function onDateChange(date: Date) {
  selectedDate.value = date;
  const dayItems = meetingsForDate(date);
  if (dayItems.length) {
    router.push(`/meetings/${dayItems[0].id}`).catch(() => {});
  } else {
    selectedMeetingId.value = null;
    meeting.value = null;
    if (props.id) router.push("/meetings").catch(() => {});
  }
}

function onMeetingUpdated(updated: MeetingDetail) {
  meeting.value = updated;
  // Topic/time/reviewStatus shown on the calendar blocks can all change from
  // here (edit, first approval, reprocess) — refetch so the list doesn't go
  // stale. Cheap at this app's personal scale (same tradeoff the old
  // Action Items/Follow-ups panels made refetching after every mutation).
  refetchMeetings();
}

function confirmReprocess() {
  if (!meeting.value) return;
  Dialog.create({
    title: "Reprocess this meeting?",
    message:
      "This regenerates keywords, takeaways, action items, and follow-ups from scratch using a fresh AI pass. " +
      "Any takeaways/action items/follow-ups you've already approved will be discarded, and the meeting will " +
      "need to be reviewed again. This can't be undone.",
    persistent: true,
    ok: { label: "Reprocess", color: "primary", flat: true },
    cancel: { label: "Cancel", flat: true },
  }).onOk(onProcess);
}

async function onProcess() {
  if (!meeting.value) return;
  processing.value = true;
  error.value = "";
  try {
    await processMeeting(meeting.value.id);
    await loadMeeting(meeting.value.id);
    // meeting.id is unchanged across a (re)process, so the keyed review
    // components below don't get recreated — reset their working copies
    // explicitly, same as MeetingDetail.vue's old initReviewCopies().
    actionItemsReviewRef.value?.resetCopy();
    followUpsReviewRef.value?.resetCopy();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    processing.value = false;
  }
}

async function onRegenerateTakeaways() {
  if (!meeting.value) return;
  regeneratingTakeaways.value = true;
  error.value = "";
  try {
    const result = await regenerateInsightCategory(meeting.value.id, "takeaways");
    meeting.value = result.meeting;
    Notify.create({ type: "positive", message: "Takeaways regenerated", timeout: 3000 });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    regeneratingTakeaways.value = false;
  }
}

function confirmDelete() {
  if (!meeting.value) return;
  Dialog.create({
    title: "Delete meeting?",
    message: `This permanently deletes "${meeting.value.topic}" — its transcript, keywords, takeaways, and follow-ups. This can't be undone.`,
    persistent: true,
    ok: { label: "Delete", color: "negative", flat: true },
    cancel: { label: "Cancel", flat: true },
  }).onOk(onDelete);
}

async function onDelete() {
  if (!meeting.value) return;
  deleting.value = true;
  error.value = "";
  try {
    await deleteMeeting(meeting.value.id);
    Notify.create({ type: "positive", message: "Meeting deleted", timeout: 3000 });
    meeting.value = null;
    selectedMeetingId.value = null;
    await refetchMeetings();
    router.replace("/meetings").catch(() => {});
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    deleting.value = false;
  }
}
</script>
