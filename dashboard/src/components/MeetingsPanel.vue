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

    <div class="bw-panel__body col">
      <router-link v-for="m in meetings" :key="m.id" :to="`/meetings/${m.id}`" class="bw-row">
        <div class="row items-center no-wrap">
          <div class="col">
            <div class="bw-row__title">{{ m.topic }}</div>
            <div class="bw-row__meta">
              {{ formatDate(m.startTime) }}
              <span v-if="m.participants.length"> · {{ m.participants.join(", ") }}</span>
            </div>
          </div>
          <span class="bw-pill" :class="pillClass(m.reviewStatus)">{{ pillLabel(m.reviewStatus) }}</span>
        </div>
      </router-link>

      <div v-if="!meetings.length && !loading" class="text-grey-7 q-pa-md text-center">
        No meetings captured yet. <router-link to="/capture">Capture one</router-link>.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchMeetings, type MeetingListItem, type ReviewStatus } from "../api";

const meetings = ref<MeetingListItem[]>([]);
const loading = ref(true);
const error = ref("");

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function pillLabel(status: ReviewStatus): string {
  return { pending: "Pending", needs_review: "Needs review", reviewed: "Reviewed" }[status];
}

function pillClass(status: ReviewStatus): string {
  return {
    pending: "bw-pill--pending",
    needs_review: "bw-pill--needs-review",
    reviewed: "bw-pill--processed",
  }[status];
}

onMounted(async () => {
  try {
    const result = await fetchMeetings();
    meetings.value = result.meetings;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});
</script>
