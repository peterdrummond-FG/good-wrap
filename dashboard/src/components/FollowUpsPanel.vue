<template>
  <div class="bw-panel column">
    <div class="bw-panel__header">
      <div class="bw-panel__title">Follow-ups</div>
      <div class="bw-panel__subtitle">Approved follow-ups, and with who</div>
    </div>

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-ma-sm" rounded dense>
      {{ error }}
    </q-banner>

    <div class="bw-panel__body col">
      <template v-for="group in groups" :key="group.label">
        <template v-if="group.items.length">
          <div class="bw-section-label">{{ group.label }}</div>
          <router-link
            v-for="(f, i) in group.items"
            :key="i"
            :to="`/meetings/${f.meetingId}`"
            class="bw-row"
          >
            <div class="bw-row__title">{{ f.text }}</div>
            <div class="bw-row__meta">
              <span v-if="f.person">with {{ f.person }} · </span>{{ f.meetingTopic }}
            </div>
          </router-link>
        </template>
      </template>

      <div v-if="!followUps.length && !loading" class="text-grey-7 q-pa-md text-center">
        Nothing approved yet — review a meeting's suggestions to see follow-ups here.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchFollowUps, type FollowUpWithMeeting } from "../api";

const followUps = ref<FollowUpWithMeeting[]>([]);
const loading = ref(true);
const error = ref("");

// Today/Tomorrow/This Week/Next Week/Other — mirrors Meetings Overview's
// Today/Yesterday/This Week/Older grouping style (section-label dividers),
// but forward-looking since a follow-up's timing is a prospective category
// Claude assigns, not a computed date like a meeting's actual start time.
// One bucket per FollowUpTiming value (db/schema.ts) so nothing is folded
// into a vague catch-all unless it's genuinely "unspecified" — added 2026-07-16
// per Peter's request, replacing the old Tomorrow/Next Week/Other-only view.
const groups = computed(() => {
  const buckets = {
    today: [] as FollowUpWithMeeting[],
    tomorrow: [] as FollowUpWithMeeting[],
    thisWeek: [] as FollowUpWithMeeting[],
    nextWeek: [] as FollowUpWithMeeting[],
    other: [] as FollowUpWithMeeting[],
  };

  for (const f of followUps.value) {
    if (f.timing === "today") buckets.today.push(f);
    else if (f.timing === "tomorrow") buckets.tomorrow.push(f);
    else if (f.timing === "this_week") buckets.thisWeek.push(f);
    else if (f.timing === "next_week") buckets.nextWeek.push(f);
    else buckets.other.push(f);
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
    const result = await fetchFollowUps();
    followUps.value = result.followUps;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});
</script>
