<template>
  <div class="bw-panel column">
    <div class="bw-panel__header">
      <div class="bw-panel__title">Follow-ups</div>
      <div class="bw-panel__subtitle">What to follow up on, and with who</div>
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
        No follow-ups yet — process a meeting to extract some.
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

const groups = computed(() => {
  const buckets = {
    tomorrow: [] as FollowUpWithMeeting[],
    nextWeek: [] as FollowUpWithMeeting[],
    other: [] as FollowUpWithMeeting[],
  };

  for (const f of followUps.value) {
    if (f.timing === "tomorrow") buckets.tomorrow.push(f);
    else if (f.timing === "next_week") buckets.nextWeek.push(f);
    else buckets.other.push(f);
  }

  return [
    { label: "Tomorrow", items: buckets.tomorrow },
    { label: "Next Week", items: buckets.nextWeek },
    // "this_week" and "unspecified" land here — not what Peter asked to see
    // up front, but nothing should silently disappear.
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
