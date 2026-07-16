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
    </div>

    <q-inner-loading :showing="loading" />
  </div>
</template>

<script setup lang="ts">
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
</script>
