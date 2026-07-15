<template>
  <div class="bw-panel column">
    <div class="bw-panel__header row items-center justify-between">
      <div>
        <div class="bw-panel__title">Follow-ups</div>
        <div class="bw-panel__subtitle">Approved follow-ups, and with who</div>
      </div>
      <!-- Urgency (default) vs Person grouping — added 2026-07-16 per Peter's
           request for a "by person" view. Lives as a toggle inside this same
           panel rather than a separate column, to keep the dashboard at 3
           columns. -->
      <q-btn-toggle
        v-model="groupMode"
        dense
        no-caps
        unelevated
        toggle-color="primary"
        color="grey-9"
        text-color="grey-4"
        :options="[
          { label: 'Urgency', value: 'urgency' },
          { label: 'Person', value: 'person' },
        ]"
      />
    </div>

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-ma-sm" rounded dense>
      {{ error }}
    </q-banner>

    <div class="bw-panel__body col">
      <template v-for="group in groups" :key="group.label">
        <template v-if="group.items.length">
          <div class="bw-section-label">
            <PersonTag v-if="groupMode === 'person' && group.isPerson" :name="group.label" />
            <template v-else>{{ group.label }}</template>
          </div>
          <router-link
            v-for="(f, i) in group.items"
            :key="i"
            :to="`/meetings/${f.meetingId}`"
            class="bw-row"
          >
            <div class="bw-row__title">{{ f.text }}</div>
            <div class="bw-row__meta">
              <!-- Urgency mode: who it's with (urgency is already conveyed by
                   the section label). Person mode: the reverse — urgency pill
                   per item, since grouping no longer shows it. -->
              <template v-if="groupMode === 'urgency'">
                <span v-if="f.person"
                  >with <PersonTag :name="f.person" /> · </span
                >{{ f.meetingTopic }}
              </template>
              <template v-else>
                <span class="bw-pill" :class="urgencyPillClass(f.urgency)">{{
                  urgencyLabel(f.urgency)
                }}</span>
                · {{ f.meetingTopic }}
              </template>
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
import { urgencyLabel, urgencyPillClass } from "../urgency";
import PersonTag from "./PersonTag.vue";

const followUps = ref<FollowUpWithMeeting[]>([]);
const loading = ref(true);
const error = ref("");
const groupMode = ref<"urgency" | "person">("urgency");

interface Group {
  label: string;
  items: FollowUpWithMeeting[];
  /** True for a real person-name group (so we know to render a PersonTag for
   * the label); false for "Unassigned" and for the urgency-mode labels. */
  isPerson: boolean;
}

const urgencyGroups = computed<Group[]>(() => {
  const buckets = {
    high: [] as FollowUpWithMeeting[],
    medium: [] as FollowUpWithMeeting[],
    low: [] as FollowUpWithMeeting[],
  };
  for (const f of followUps.value) buckets[f.urgency].push(f);
  return [
    { label: "High", items: buckets.high, isPerson: false },
    { label: "Medium", items: buckets.medium, isPerson: false },
    { label: "Low", items: buckets.low, isPerson: false },
  ];
});

// Alphabetical by person, with a final "Unassigned" bucket for follow-ups
// with no identifiable person — nothing should silently disappear just
// because it wasn't attributable to someone.
const personGroups = computed<Group[]>(() => {
  const byPerson = new Map<string, FollowUpWithMeeting[]>();
  const unassigned: FollowUpWithMeeting[] = [];

  for (const f of followUps.value) {
    if (!f.person) {
      unassigned.push(f);
      continue;
    }
    const list = byPerson.get(f.person) ?? [];
    list.push(f);
    byPerson.set(f.person, list);
  }

  const names = [...byPerson.keys()].sort((a, b) => a.localeCompare(b));
  const groups: Group[] = names.map((name) => ({
    label: name,
    items: byPerson.get(name)!,
    isPerson: true,
  }));
  groups.push({ label: "Unassigned", items: unassigned, isPerson: false });
  return groups;
});

const groups = computed(() => (groupMode.value === "urgency" ? urgencyGroups.value : personGroups.value));

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
