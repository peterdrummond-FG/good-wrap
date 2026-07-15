<template>
  <div class="bw-panel column">
    <div class="bw-panel__header">
      <div class="bw-panel__title">Action Items</div>
      <div class="bw-panel__subtitle">Approved action items — things you need to do</div>
    </div>

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-ma-sm" rounded dense>
      {{ error }}
    </q-banner>

    <div class="bw-panel__body col">
      <template v-for="group in groups" :key="group.label">
        <template v-if="group.items.length">
          <div class="bw-section-label">{{ group.label }}</div>
          <router-link
            v-for="(a, i) in group.items"
            :key="i"
            :to="`/meetings/${a.meetingId}`"
            class="bw-row"
          >
            <div class="bw-row__title">{{ a.text }}</div>
            <div class="bw-row__meta">{{ a.meetingTopic }}</div>
          </router-link>
        </template>
      </template>

      <div v-if="!actionItems.length && !loading" class="text-grey-7 q-pa-md text-center">
        Nothing approved yet — review a meeting's suggestions to see action items here.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchFollowUps, type ActionItemWithMeeting } from "../api";

const actionItems = ref<ActionItemWithMeeting[]>([]);
const loading = ref(true);
const error = ref("");

// Today/Tomorrow/This Week/Next Week/Other — same restructure as
// FollowUpsPanel.vue (see comment there), applied 2026-07-16.
const groups = computed(() => {
  const buckets = {
    today: [] as ActionItemWithMeeting[],
    tomorrow: [] as ActionItemWithMeeting[],
    thisWeek: [] as ActionItemWithMeeting[],
    nextWeek: [] as ActionItemWithMeeting[],
    other: [] as ActionItemWithMeeting[],
  };

  for (const a of actionItems.value) {
    if (a.timing === "today") buckets.today.push(a);
    else if (a.timing === "tomorrow") buckets.tomorrow.push(a);
    else if (a.timing === "this_week") buckets.thisWeek.push(a);
    else if (a.timing === "next_week") buckets.nextWeek.push(a);
    else buckets.other.push(a);
  }

  return [
    { label: "Today", items: buckets.today },
    { label: "Tomorrow", items: buckets.tomorrow },
    { label: "This Week", items: buckets.thisWeek },
    { label: "Next Week", items: buckets.nextWeek },
    // "unspecified" (no timing signal in the transcript) lands here —
    // nothing should silently disappear.
    { label: "Other", items: buckets.other },
  ];
});

onMounted(async () => {
  try {
    // Same endpoint as the Follow-ups panel (it returns both lists together)
    // — just picks the other half of the response.
    const result = await fetchFollowUps();
    actionItems.value = result.actionItems;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});
</script>
