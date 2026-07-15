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
      <!-- Flat, unranked list — changed 2026-07-16 per Peter's request: no
           urgency/timing grouping here (unlike Follow-ups), just every
           approved action item in the order the API returns them (newest
           meeting first), each with its own copy button so an item's text
           can be pulled out individually (e.g. to paste into a task
           manager) without opening the meeting. -->
      <router-link
        v-for="(a, i) in actionItems"
        :key="i"
        :to="`/meetings/${a.meetingId}`"
        class="bw-row"
      >
        <div class="row items-center no-wrap">
          <div class="col">
            <div class="bw-row__title">{{ a.text }}</div>
            <div class="bw-row__meta">{{ a.meetingTopic }}</div>
          </div>
          <q-btn
            flat
            round
            dense
            size="sm"
            icon="content_copy"
            color="grey-5"
            @click.stop.prevent="copyItem(a.text)"
          />
        </div>
      </router-link>

      <div v-if="!actionItems.length && !loading" class="text-grey-7 q-pa-md text-center">
        Nothing approved yet — review a meeting's suggestions to see action items here.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Notify } from "quasar";
import { fetchFollowUps, type ActionItemWithMeeting } from "../api";

const actionItems = ref<ActionItemWithMeeting[]>([]);
const loading = ref(true);
const error = ref("");

async function copyItem(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    Notify.create({ type: "positive", message: "Copied to clipboard", timeout: 1200 });
  } catch {
    Notify.create({ type: "negative", message: "Couldn't copy — clipboard access denied", timeout: 2500 });
  }
}

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
