<template>
  <q-page padding>
    <q-btn flat icon="arrow_back" label="Back to dashboard" to="/" class="q-mb-md" />

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
      {{ error }}
    </q-banner>

    <template v-if="meeting">
      <div class="bw-panel q-pa-lg">
      <div class="row items-start justify-between">
        <div class="text-h5">{{ meeting.topic }}</div>
        <q-btn
          v-if="meeting.insights"
          outline
          color="primary"
          icon="refresh"
          label="Reprocess meeting"
          dense
          no-caps
          :loading="processing"
          @click="onProcess"
        />
      </div>
      <div class="text-caption text-grey-6 q-mb-md">
        {{ formatDate(meeting.startTime) }}
        <span v-if="meeting.durationMinutes"> · {{ meeting.durationMinutes }} min</span>
        <span v-if="meeting.participants.length"> · {{ meeting.participants.join(", ") }}</span>
        <span> · source: {{ meeting.source }}</span>
      </div>

      <q-card v-if="!meeting.insights" flat bordered class="q-pa-md q-mb-md" style="background: var(--bw-surface-raised)">
        <div class="row items-center">
          <div class="col">
            This meeting hasn't been processed yet — no keywords, takeaways, or follow-ups.
            {{ " " }}Meetings normally process automatically right after capture; this one either
            predates that or its automatic run failed.
          </div>
          <q-btn
            color="primary"
            label="Process this meeting"
            :loading="processing"
            @click="onProcess"
            unelevated
          />
        </div>
      </q-card>

      <template v-else>
        <div class="text-subtitle1 q-mt-md">Keywords</div>
        <div class="q-gutter-xs q-mb-md">
          <q-chip v-for="k in meeting.insights.keywords" :key="k" dense color="primary" text-color="white">
            {{ k }}
          </q-chip>
        </div>

        <div class="text-subtitle1 q-mt-md">Takeaways</div>
        <q-list dense bordered class="q-mb-md rounded-borders">
          <q-item v-for="(t, i) in meeting.insights.takeaways" :key="i">
            <q-item-section>{{ t }}</q-item-section>
          </q-item>
          <q-item v-if="!meeting.insights.takeaways.length">
            <q-item-section class="text-grey-6">(none)</q-item-section>
          </q-item>
        </q-list>

        <div class="text-subtitle1 q-mt-md">Follow-ups</div>
        <q-list dense bordered class="q-mb-md rounded-borders">
          <q-item v-for="(f, i) in meeting.insights.followUps" :key="i">
            <q-item-section>
              {{ f.text }}
              <template v-if="f.person || f.timing !== 'unspecified'">
                <br />
                <span class="text-caption text-grey-7">
                  <span v-if="f.person">with {{ f.person }}</span>
                  <span v-if="f.person && f.timing !== 'unspecified'"> · </span>
                  <span v-if="f.timing !== 'unspecified'">{{ timingLabel(f.timing) }}</span>
                </span>
              </template>
            </q-item-section>
          </q-item>
          <q-item v-if="!meeting.insights.followUps.length">
            <q-item-section class="text-grey-6">(none)</q-item-section>
          </q-item>
        </q-list>
      </template>

      <q-expansion-item label="Full transcript" class="q-mt-md" dense-toggle>
        <q-card flat bordered style="background: var(--bw-surface-raised)">
          <q-card-section style="white-space: pre-wrap; max-height: 400px; overflow-y: auto">
            {{ meeting.transcript ?? "(no transcript)" }}
          </q-card-section>
        </q-card>
      </q-expansion-item>
      </div>
    </template>

    <q-inner-loading :showing="loading" />
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchMeetingDetail, processMeeting, type MeetingDetail } from "../api";

const props = defineProps<{ id: string }>();

const meeting = ref<MeetingDetail | null>(null);
const loading = ref(true);
const processing = ref(false);
const error = ref("");

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function timingLabel(timing: string): string {
  return { tomorrow: "Tomorrow", this_week: "This week", next_week: "Next week" }[timing] ?? "";
}

async function load() {
  loading.value = true;
  try {
    const result = await fetchMeetingDetail(props.id);
    meeting.value = result.meeting;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function onProcess() {
  processing.value = true;
  error.value = "";
  try {
    await processMeeting(props.id);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    processing.value = false;
  }
}

onMounted(load);
</script>
