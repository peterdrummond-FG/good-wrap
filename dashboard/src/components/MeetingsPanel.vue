<template>
  <div class="bw-panel column">
    <div class="bw-panel__header row items-center">
      <div class="col">
        <div class="bw-panel__title">Meetings</div>
        <div class="bw-panel__subtitle">Every captured meeting, newest first</div>
      </div>
      <q-btn color="primary" label="Capture" to="/capture" unelevated dense no-caps />
    </div>

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-ma-sm" rounded dense>
      {{ error }}
    </q-banner>

    <div class="q-px-sm q-pt-sm q-gutter-y-xs">
      <q-input
        v-model="searchText"
        placeholder="Search topic or keywords"
        dense
        filled
        clearable
      >
        <template #prepend><q-icon name="search" size="18px" /></template>
      </q-input>

      <q-select
        v-model="participantFilter"
        :options="participantOptions"
        label="Participant"
        dense
        filled
        clearable
      />

      <div class="row q-gutter-xs">
        <q-input v-model="dateFrom" type="date" label="From" dense filled class="col" />
        <q-input v-model="dateTo" type="date" label="To" dense filled class="col" />
      </div>

      <div v-if="hasActiveFilters" class="row justify-end">
        <q-btn flat dense no-caps size="sm" label="Clear filters" @click="clearFilters" />
      </div>
    </div>

    <div class="bw-panel__body col">
      <router-link
        v-for="m in filteredMeetings"
        :key="m.id"
        :to="`/meetings/${m.id}`"
        class="bw-row"
      >
        <div class="row items-center no-wrap">
          <div class="col">
            <div class="bw-row__title">{{ m.topic }}</div>
            <div class="bw-row__meta">
              {{ formatDate(m.startTime) }}
              <span v-if="m.participants.length">
                ·
                <template v-for="(p, i) in m.participants" :key="p"
                  ><PersonTag :name="p" /><span v-if="i < m.participants.length - 1">, </span></template
                >
              </span>
            </div>
          </div>
          <span class="bw-pill" :class="pillClass(m.reviewStatus)">{{ pillLabel(m.reviewStatus) }}</span>
        </div>
      </router-link>

      <div v-if="!meetings.length && !loading" class="text-grey-7 q-pa-md text-center">
        No meetings captured yet. <router-link to="/capture">Capture one</router-link>.
      </div>
      <div v-else-if="!filteredMeetings.length && !loading" class="text-grey-7 q-pa-md text-center">
        No meetings match these filters.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { fetchMeetings, type MeetingListItem } from "../api";
import { formatMeetingDateTime as formatDate } from "../formatDate";
import { reviewStatusListLabel as pillLabel, reviewStatusPillClass as pillClass } from "../reviewStatus";
import { useAsyncList } from "../composables/useAsyncList";
import PersonTag from "./PersonTag.vue";

const {
  data: meetings,
  loading,
  error,
} = useAsyncList(async () => (await fetchMeetings()).meetings, [] as MeetingListItem[]);

const searchText = ref("");
const participantFilter = ref<string | null>(null);
const dateFrom = ref("");
const dateTo = ref("");

const participantOptions = computed(() => {
  const names = new Set<string>();
  for (const m of meetings.value) {
    for (const p of m.participants) names.add(p);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
});

const hasActiveFilters = computed(
  () => Boolean(searchText.value.trim() || participantFilter.value || dateFrom.value || dateTo.value)
);

function clearFilters() {
  searchText.value = "";
  participantFilter.value = null;
  dateFrom.value = "";
  dateTo.value = "";
}

// All client-side, over the already-fetched list — fine at personal scale;
// worth revisiting as server-side pagination/filtering if the meeting count
// grows large enough that fetching everything up front becomes slow.
const filteredMeetings = computed(() => {
  const query = searchText.value.trim().toLowerCase();
  const from = dateFrom.value ? new Date(dateFrom.value) : null;
  // Inclusive of the whole "to" day, not just its midnight instant.
  const to = dateTo.value ? new Date(`${dateTo.value}T23:59:59.999`) : null;

  return meetings.value.filter((m) => {
    if (query) {
      const haystack = [m.topic, ...m.keywords].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (participantFilter.value && !m.participants.includes(participantFilter.value)) {
      return false;
    }
    if (from || to) {
      const start = new Date(m.startTime);
      if (from && start < from) return false;
      if (to && start > to) return false;
    }
    return true;
  });
});
</script>
