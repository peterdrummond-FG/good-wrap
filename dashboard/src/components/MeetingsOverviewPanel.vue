<template>
  <div class="bw-panel column">
    <div class="bw-panel__header">
      <div class="bw-panel__title">Meetings Overview</div>
      <div class="bw-panel__subtitle">Top takeaways from each meeting, grouped by when</div>
    </div>

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-ma-sm" rounded dense>
      {{ error }}
    </q-banner>

    <div class="bw-panel__body col">
      <template v-for="group in groups" :key="group.label">
        <template v-if="group.items.length">
          <div class="bw-section-label">{{ group.label }}</div>
          <div v-for="m in group.items" :key="m.id" class="bw-overview-item">
            <router-link :to="`/meetings/${m.id}`" class="bw-overview-item__name">
              {{ m.topic }} · {{ formatTime(m.startTime) }}
            </router-link>
            <ul v-if="m.topTakeaways.length" class="bw-takeaway-list">
              <li v-for="(t, i) in m.topTakeaways" :key="i">{{ t }}</li>
            </ul>
            <div v-else class="bw-overview-item__empty">{{ emptyLabel(m.reviewStatus) }}</div>
          </div>
        </template>
      </template>

      <div v-if="!meetings.length && !loading" class="text-grey-7 q-pa-md text-center">
        No meetings yet.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { fetchMeetings, type MeetingListItem, type ReviewStatus } from "../api";
import { bucketByRecency } from "../dateBuckets";
import { useAsyncList } from "../composables/useAsyncList";

function emptyLabel(status: ReviewStatus): string {
  return {
    pending: "Not processed yet — no takeaways.",
    needs_review: "Ready for review — no takeaways approved yet.",
    reviewed: "No takeaways approved.",
  }[status];
}

const {
  data: meetings,
  loading,
  error,
} = useAsyncList(async () => (await fetchMeetings()).meetings, [] as MeetingListItem[]);

// Short form (just the time) — the section label ("Today", "Yesterday", ...)
// already carries the day, so repeating a full date next to every meeting
// name would just be noise here.
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { timeStyle: "short" });
}

const groups = computed(() => {
  const buckets = {
    today: [] as MeetingListItem[],
    yesterday: [] as MeetingListItem[],
    thisWeek: [] as MeetingListItem[],
    older: [] as MeetingListItem[],
  };

  for (const m of meetings.value) {
    buckets[bucketByRecency(m.startTime)].push(m);
  }

  return [
    { label: "Today", items: buckets.today },
    { label: "Yesterday", items: buckets.yesterday },
    { label: "This Week", items: buckets.thisWeek },
    { label: "Older", items: buckets.older },
  ];
});
</script>
