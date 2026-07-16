<template>
  <q-page padding>
    <q-btn flat icon="arrow_back" label="Back to people" to="/people" class="q-mb-md" />

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
      {{ error }}
    </q-banner>

    <template v-if="person">
      <div class="bw-panel q-pa-lg q-mb-md">
        <div class="row items-center q-gutter-sm q-mb-md">
          <PersonTag :name="person.name" />
        </div>

        <div class="row items-center justify-between q-mb-xs">
          <div class="text-subtitle1">What to bring up next time</div>
          <q-btn
            outline
            color="primary"
            icon="auto_awesome"
            label="Generate summary"
            dense
            no-caps
            :loading="summarizing"
            @click="onGenerateSummary"
          />
        </div>
        <div v-if="summary" class="bw-panel q-pa-md" style="background: var(--bw-surface-raised)">
          <div style="white-space: pre-wrap">{{ summary.summary }}</div>
          <template v-if="summary.sources.length">
            <div class="text-caption text-grey-6 q-mt-sm">Sources</div>
            <q-list dense>
              <q-item
                v-for="s in summary.sources"
                :key="s.meetingId"
                clickable
                :to="`/meetings/${s.meetingId}`"
                class="q-pa-none"
              >
                <q-item-section>
                  <span class="text-primary">{{ s.topic }} — {{ formatDate(s.startTime) }}</span>
                </q-item-section>
              </q-item>
            </q-list>
          </template>
        </div>
        <div v-else class="text-grey-6 text-caption">
          Not generated yet — click "Generate summary" for an AI-written recap of what's worth
          remembering, based on your meetings with {{ person.name }}.
        </div>
      </div>

      <div class="row q-col-gutter-md">
        <div class="col-12 col-md-6">
          <div class="bw-panel q-pa-lg">
            <div class="text-subtitle1 q-mb-sm">Meetings ({{ person.meetings.length }})</div>
            <q-scroll-area style="height: 320px">
              <router-link
                v-for="m in person.meetings"
                :key="m.meetingId"
                :to="`/meetings/${m.meetingId}`"
                class="bw-row"
              >
                <div class="row items-center no-wrap">
                  <div class="col">
                    <div class="bw-row__title">{{ m.topic }}</div>
                    <div class="bw-row__meta">{{ formatDate(m.startTime) }}</div>
                  </div>
                  <span class="bw-pill" :class="pillClass(m.reviewStatus)">{{
                    pillLabel(m.reviewStatus)
                  }}</span>
                </div>
              </router-link>
              <div v-if="!person.meetings.length" class="text-grey-6 q-pa-sm">
                No meetings recorded with {{ person.name }} yet.
              </div>
            </q-scroll-area>
          </div>
        </div>

        <div class="col-12 col-md-6">
          <div class="bw-panel q-pa-lg">
            <div class="text-subtitle1 q-mb-sm">Follow-ups involving them ({{ person.followUps.length }})</div>
            <q-scroll-area style="height: 320px">
              <router-link
                v-for="(f, i) in person.followUps"
                :key="i"
                :to="`/meetings/${f.meetingId}`"
                class="bw-row"
              >
                <div class="bw-row__title">{{ f.text }}</div>
                <div class="bw-row__meta">
                  <span class="bw-pill" :class="urgencyPillClass(f.urgency)">{{
                    urgencyLabel(f.urgency)
                  }}</span>
                  · {{ f.meetingTopic }}
                </div>
              </router-link>
              <div v-if="!person.followUps.length" class="text-grey-6 q-pa-sm">
                No approved follow-ups involving {{ person.name }} yet.
              </div>
            </q-scroll-area>
          </div>
        </div>
      </div>
    </template>

    <q-inner-loading :showing="loading" />
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  fetchPersonDetail,
  fetchPersonSummary,
  type PersonDetail,
  type PersonSummaryResult,
} from "../api";
import { formatMeetingDateTime as formatDate } from "../formatDate";
import { reviewStatusListLabel as pillLabel, reviewStatusPillClass as pillClass } from "../reviewStatus";
import { urgencyLabel, urgencyPillClass } from "../urgency";
import PersonTag from "../components/PersonTag.vue";

const props = defineProps<{ id: string }>();

const person = ref<PersonDetail | null>(null);
const loading = ref(true);
const error = ref("");
const summarizing = ref(false);
const summary = ref<PersonSummaryResult | null>(null);

async function load() {
  loading.value = true;
  try {
    const result = await fetchPersonDetail(props.id);
    person.value = result.person;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function onGenerateSummary() {
  summarizing.value = true;
  error.value = "";
  try {
    summary.value = await fetchPersonSummary(props.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    summarizing.value = false;
  }
}

onMounted(load);
</script>
