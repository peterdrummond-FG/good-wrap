<template>
  <div class="bw-review-col">
    <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-sm" rounded dense>
      {{ error }}
    </q-banner>

    <div class="row items-center justify-between bw-review-col__title">
      <span>Follow-ups <span class="text-grey-6">(others)</span></span>
      <q-btn flat round dense size="sm" icon="edit" color="grey-6" @click="editModeFollowUps = !editModeFollowUps" />
    </div>

    <template v-if="showFollowUpsChecklist">
      <q-scroll-area style="height: 320px">
        <q-item v-for="(f, i) in sortedReviewFollowUps" :key="i" dense>
          <q-item-section avatar top>
            <q-checkbox v-model="f.approved" dense />
          </q-item-section>
          <q-item-section>
            <q-input v-model="f.text" type="textarea" autogrow dense borderless input-class="text-body2" />
            <div class="row items-center q-gutter-x-sm">
              <q-select
                v-model="f.person"
                :options="followUpPersonOptions"
                label="Person"
                dense
                borderless
                clearable
                options-dense
                style="min-width: 130px"
              />
              <q-select
                v-model="f.urgency"
                :options="URGENCY_SELECT_OPTIONS"
                label="Urgency"
                dense
                borderless
                emit-value
                map-options
                options-dense
                style="min-width: 110px"
              />
            </div>
          </q-item-section>
        </q-item>
        <q-item v-if="!reviewFollowUps.length" dense>
          <q-item-section class="text-grey-6">(none suggested)</q-item-section>
        </q-item>
      </q-scroll-area>
      <q-input
        v-model="newFollowUpText"
        placeholder="Add your own follow-up"
        dense
        filled
        class="q-mt-sm"
        @keyup.enter="addFollowUp"
      >
        <template #append>
          <q-btn flat round dense icon="add" @click="addFollowUp" />
        </template>
      </q-input>
      <q-btn
        color="primary"
        label="Save"
        unelevated
        no-caps
        dense
        class="q-mt-sm full-width"
        :disable="!followUpsDirty"
        :loading="savingFollowUps"
        @click="onSaveFollowUps"
      />
      <q-btn
        v-if="editModeFollowUps"
        flat
        dense
        no-caps
        icon="autorenew"
        label="Regenerate follow-ups"
        class="q-mt-sm full-width"
        :loading="regeneratingKey !== null"
        @click="onRegenerate"
      />
    </template>
    <template v-else>
      <q-scroll-area style="height: 320px">
        <ul class="bw-bullet-list">
          <li
            v-for="f in approvedFollowUpsWithIndex"
            :key="f.index"
            class="row items-center justify-between q-gutter-x-xs"
            :style="f.done ? 'opacity: 0.5' : ''"
          >
            <span class="col">
              {{ f.text }}
              <span v-if="f.person" class="text-caption text-grey-7">— with <PersonTag :name="f.person" /></span>
              <span class="bw-pill" :class="urgencyPillClass(f.urgency)">{{ urgencyLabel(f.urgency) }}</span>
            </span>
            <q-btn
              flat round dense size="sm"
              :icon="f.done ? 'check_box' : 'check_box_outline_blank'"
              :color="f.done ? 'positive' : 'grey-5'"
              :loading="togglingDoneKey === `followup-${f.index}`"
              @click="onToggleFollowUpDone(f.index, !f.done)"
            >
              <q-tooltip>{{ f.done ? "Mark not done" : "Mark done" }}</q-tooltip>
            </q-btn>
            <q-btn
              flat round dense size="sm" icon="delete" color="grey-5"
              :loading="deletingKey === `followup-${f.index}`"
              @click="onDeleteFollowUp(f.index)"
            >
              <q-tooltip>Delete</q-tooltip>
            </q-btn>
          </li>
          <li v-if="!approvedFollowUpsWithIndex.length" class="text-grey-6">(none approved)</li>
        </ul>
      </q-scroll-area>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Notify } from "quasar";
import {
  deleteFollowUp,
  fetchPeople,
  regenerateInsightCategory,
  setFollowUpDone,
  type MeetingDetail,
  type Urgency,
} from "../api";
import { sortByUrgency, urgencyLabel, urgencyPillClass } from "../urgency";
import { useKeyedAsyncAction } from "../composables/useKeyedAsyncAction";
import { useReviewCategory } from "../composables/useReviewCategory";
import PersonTag from "./PersonTag.vue";

const props = defineProps<{ meetingId: string; meeting: MeetingDetail }>();
const emit = defineEmits<{ (e: "update:meeting", value: MeetingDetail): void }>();

const URGENCY_SELECT_OPTIONS: { label: string; value: Urgency }[] = (["high", "medium", "low"] as Urgency[]).map(
  (value) => ({ value, label: urgencyLabel(value) })
);

const meetingModel = computed<MeetingDetail | null>({
  get: () => props.meeting,
  set: (v) => {
    if (v) emit("update:meeting", v);
  },
});

const error = ref("");

// Everyone Peter's ever met with, not just this meeting's attendees — a
// follow-up can be manually reassigned to someone who wasn't in the meeting.
const allKnownPeopleNames = ref<string[]>([]);
onMounted(async () => {
  try {
    const result = await fetchPeople();
    allKnownPeopleNames.value = result.people.map((p) => p.name);
  } catch {
    // Non-critical — dropdown just falls back to this meeting's attendees.
  }
});

const followUpPersonOptions = computed(() => {
  const attendees = props.meeting.participants ?? [];
  const attendeeSet = new Set(attendees);
  const others = allKnownPeopleNames.value
    .filter((name) => !attendeeSet.has(name))
    .sort((a, b) => a.localeCompare(b));
  return [...attendees, ...others];
});

const followUpsReview = useReviewCategory<{
  text: string;
  person: string | null;
  urgency: Urgency;
  approved: boolean;
}>({
  meetingId: props.meetingId,
  meeting: meetingModel,
  read: (m) => ({ items: m.insights!.followUps, reviewedAt: m.insights!.followUpsReviewedAt }),
  makeNewItem: (text) => ({ text, person: null, urgency: "medium", approved: true }),
  snapshotFields: (f) => ({ text: f.text, person: f.person, urgency: f.urgency, approved: f.approved }),
  sortForDisplay: sortByUrgency,
  buildPayload: (items) => ({ followUps: items }),
  readJustReviewed: (result) => result.justReviewedFollowUps,
});

const reviewFollowUps = followUpsReview.items;
const sortedReviewFollowUps = followUpsReview.displayItems;
const newFollowUpText = followUpsReview.newItemText;
const addFollowUp = followUpsReview.addItem;
const followUpsDirty = followUpsReview.dirty;
const savingFollowUps = followUpsReview.saving;
const showFollowUpsChecklist = followUpsReview.showChecklist;
const editModeFollowUps = followUpsReview.editMode;

const approvedFollowUpsWithIndex = computed(() => {
  const withIndex = (props.meeting.insights?.followUps ?? [])
    .map((f, index) => ({ ...f, index }))
    .filter((f) => f.approved);
  return sortByUrgency(withIndex);
});

// One instance per button "kind" so concurrent operations on different items
// don't share a loading key (matches the original per-kind refs).
const { activeKey: togglingDoneKey, run: runToggleAction } = useKeyedAsyncAction(
  error,
  followUpsReview.resetCopy
);
const { activeKey: deletingKey, run: runDeleteAction } = useKeyedAsyncAction(error, followUpsReview.resetCopy);
const { activeKey: regeneratingKey, run: runRegenerateAction } = useKeyedAsyncAction(
  error,
  followUpsReview.resetCopy
);

async function onToggleFollowUpDone(index: number, done: boolean) {
  await runToggleAction(`followup-${index}`, async () => {
    const result = await setFollowUpDone(props.meetingId, index, done);
    emit("update:meeting", result.meeting);
  });
}

async function onDeleteFollowUp(index: number) {
  await runDeleteAction(`followup-${index}`, async () => {
    const result = await deleteFollowUp(props.meetingId, index);
    emit("update:meeting", result.meeting);
  });
}

async function onSaveFollowUps() {
  error.value = "";
  try {
    const { justReviewed } = await followUpsReview.save();
    Notify.create({
      type: "positive",
      message: justReviewed ? "Reviewed — notifications sent" : "Follow-ups saved",
      timeout: 3000,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function onRegenerate() {
  await runRegenerateAction("regenerate", async () => {
    const result = await regenerateInsightCategory(props.meetingId, "followUps");
    emit("update:meeting", result.meeting);
    Notify.create({ type: "positive", message: "Follow-ups regenerated", timeout: 3000 });
  });
}

// Keyed by meetingId in MeetingsView.vue — see MeetingActionItemsReview.vue
// for why resetCopy runs on mount and is also exposed for Reprocess.
onMounted(() => followUpsReview.resetCopy());
defineExpose({ resetCopy: followUpsReview.resetCopy });
</script>
