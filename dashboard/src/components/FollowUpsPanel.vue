<template>
  <div class="bw-panel column">
    <div class="bw-panel__header">
      <div class="bw-panel__title">Follow-ups</div>
      <div class="bw-panel__subtitle">Approved action items and follow-ups, and with who</div>
    </div>

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-ma-sm" rounded dense>
      {{ error }}
    </q-banner>

    <div class="bw-panel__body col">
      <template v-for="group in groups" :key="group.label">
        <template v-if="group.items.length">
          <div class="bw-section-label">{{ group.label }}</div>
          <router-link
            v-for="(item, i) in group.items"
            :key="i"
            :to="`/meetings/${item.meetingId}`"
            class="bw-row"
          >
            <div class="row items-center no-wrap q-gutter-xs">
              <q-chip dense size="sm" :color="item.kind === 'action_item' ? 'primary' : undefined" text-color="white">
                {{ item.kind === "action_item" ? "You" : "Other" }}
              </q-chip>
              <div class="bw-row__title">{{ item.text }}</div>
            </div>
            <div class="bw-row__meta">
              <span v-if="item.person">with {{ item.person }} · </span>{{ item.meetingTopic }}
            </div>
          </router-link>
        </template>
      </template>

      <div v-if="!items.length && !loading" class="text-grey-7 q-pa-md text-center">
        Nothing approved yet — review a meeting's suggestions to see action items and follow-ups here.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchFollowUps, type ActionItemWithMeeting, type FollowUpWithMeeting } from "../api";

// Action items and follow-ups are both "things to do", differing only in
// ownership (see db/schema.ts's meeting_insights comment) — merged into one
// panel with a small "You" / "Other" tag rather than two separate panels.
interface UnifiedItem {
  kind: "action_item" | "follow_up";
  text: string;
  person: string | null;
  timing: string;
  meetingId: string;
  meetingTopic: string;
}

const items = ref<UnifiedItem[]>([]);
const loading = ref(true);
const error = ref("");

const groups = computed(() => {
  const buckets = { tomorrow: [] as UnifiedItem[], nextWeek: [] as UnifiedItem[], other: [] as UnifiedItem[] };

  for (const item of items.value) {
    if (item.timing === "tomorrow") buckets.tomorrow.push(item);
    else if (item.timing === "next_week") buckets.nextWeek.push(item);
    else buckets.other.push(item);
  }

  return [
    { label: "Tomorrow", items: buckets.tomorrow },
    { label: "Next Week", items: buckets.nextWeek },
    // "this_week" and "unspecified" land here — not what Peter asked to see
    // up front, but nothing should silently disappear.
    { label: "Other", items: buckets.other },
  ];
});

function toUnified(
  actionItems: ActionItemWithMeeting[],
  followUps: FollowUpWithMeeting[]
): UnifiedItem[] {
  return [
    ...actionItems.map((a) => ({
      kind: "action_item" as const,
      text: a.text,
      person: null,
      timing: a.timing,
      meetingId: a.meetingId,
      meetingTopic: a.meetingTopic,
    })),
    ...followUps.map((f) => ({
      kind: "follow_up" as const,
      text: f.text,
      person: f.person,
      timing: f.timing,
      meetingId: f.meetingId,
      meetingTopic: f.meetingTopic,
    })),
  ];
}

onMounted(async () => {
  try {
    const result = await fetchFollowUps();
    items.value = toUnified(result.actionItems, result.followUps);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});
</script>
