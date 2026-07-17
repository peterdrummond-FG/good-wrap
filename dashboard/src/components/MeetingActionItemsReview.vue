<template>
  <div class="bw-review-col">
    <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-sm" rounded dense>
      {{ error }}
    </q-banner>

    <div class="row items-center justify-between bw-review-col__title">
      <span>Action Items <span class="text-grey-6">(you)</span></span>
      <q-btn flat round dense size="sm" icon="edit" color="grey-6" @click="editModeActionItems = !editModeActionItems" />
    </div>

    <template v-if="showActionItemsChecklist">
      <q-scroll-area style="height: 320px">
        <q-item v-for="(a, i) in reviewActionItems" :key="i" dense>
          <q-item-section avatar top>
            <q-checkbox v-model="a.approved" dense />
          </q-item-section>
          <q-item-section>
            <q-input v-model="a.text" type="textarea" autogrow dense borderless input-class="text-body2" />
          </q-item-section>
        </q-item>
        <q-item v-if="!reviewActionItems.length" dense>
          <q-item-section class="text-grey-6">(none suggested)</q-item-section>
        </q-item>
      </q-scroll-area>
      <q-input
        v-model="newActionItemText"
        placeholder="Add your own action item"
        dense
        filled
        class="q-mt-sm"
        @keyup.enter="addActionItem"
      >
        <template #append>
          <q-btn flat round dense icon="add" @click="addActionItem" />
        </template>
      </q-input>
      <q-btn
        color="primary"
        label="Save"
        unelevated
        no-caps
        dense
        class="q-mt-sm full-width"
        :disable="!actionItemsDirty"
        :loading="savingActionItems"
        @click="onSaveActionItems"
      />
      <q-btn
        v-if="editModeActionItems"
        flat
        dense
        no-caps
        icon="autorenew"
        label="Regenerate action items"
        class="q-mt-sm full-width"
        :loading="regenerating"
        @click="onRegenerate"
      />
    </template>
    <template v-else>
      <q-scroll-area style="height: 320px">
        <ul class="bw-bullet-list">
          <li
            v-for="a in approvedActionItemsWithIndex"
            :key="a.index"
            class="row items-center justify-between q-gutter-x-xs"
            :style="a.done ? 'opacity: 0.5' : ''"
          >
            <span class="col">{{ a.text }}</span>
            <q-icon v-if="a.asanaTaskGid" name="check_circle" color="positive" size="18px">
              <q-tooltip>Sent to Asana</q-tooltip>
            </q-icon>
            <q-btn
              v-else
              flat round dense size="sm" icon="send" color="grey-5"
              :loading="sendingToAsanaIndex === a.index"
              @click="onSendToAsana(a.index)"
            >
              <q-tooltip>Send to Asana</q-tooltip>
            </q-btn>
            <q-btn
              flat round dense size="sm"
              :icon="a.done ? 'check_box' : 'check_box_outline_blank'"
              :color="a.done ? 'positive' : 'grey-5'"
              :loading="togglingDoneKey === `action-${a.index}`"
              @click="onToggleActionItemDone(a.index, !a.done)"
            >
              <q-tooltip>{{ a.done ? "Mark not done" : "Mark done" }}</q-tooltip>
            </q-btn>
            <q-btn
              flat round dense size="sm" icon="delete" color="grey-5"
              :loading="deletingKey === `action-${a.index}`"
              @click="onDeleteActionItem(a.index)"
            >
              <q-tooltip>Delete</q-tooltip>
            </q-btn>
          </li>
          <li v-if="!approvedActionItemsWithIndex.length" class="text-grey-6">(none approved)</li>
        </ul>
      </q-scroll-area>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Notify } from "quasar";
import {
  deleteActionItem,
  regenerateInsightCategory,
  sendActionItemToAsana,
  setActionItemDone,
  type MeetingDetail,
  type Urgency,
} from "../api";
import { useReviewCategory } from "../composables/useReviewCategory";

const props = defineProps<{ meetingId: string; meeting: MeetingDetail }>();
const emit = defineEmits<{ (e: "update:meeting", value: MeetingDetail): void }>();

// useReviewCategory wants a real Ref — a get/set computed satisfies that
// (WritableComputedRef extends Ref), and routes every write back up to the
// parent, which owns the actual meeting state (shared with the Follow-ups
// column and the page header).
const meetingModel = computed<MeetingDetail | null>({
  get: () => props.meeting,
  set: (v) => {
    if (v) emit("update:meeting", v);
  },
});

const error = ref("");

const actionItemsReview = useReviewCategory<{ text: string; urgency: Urgency; approved: boolean }>({
  meetingId: props.meetingId,
  meeting: meetingModel,
  read: (m) => ({ items: m.insights!.actionItems, reviewedAt: m.insights!.actionItemsReviewedAt }),
  makeNewItem: (text) => ({ text, urgency: "medium", approved: true }),
  snapshotFields: (a) => ({ text: a.text, urgency: a.urgency, approved: a.approved }),
  buildPayload: (items) => ({ actionItems: items }),
  readJustReviewed: (result) => result.justReviewedActionItems,
});

const reviewActionItems = actionItemsReview.items;
const newActionItemText = actionItemsReview.newItemText;
const addActionItem = actionItemsReview.addItem;
const actionItemsDirty = actionItemsReview.dirty;
const savingActionItems = actionItemsReview.saving;
const showActionItemsChecklist = actionItemsReview.showChecklist;
const editModeActionItems = actionItemsReview.editMode;

// Approved items with each one's real index in the underlying actionItems
// array attached — Send-to-Asana/Done/Delete address items by position, not id.
const approvedActionItemsWithIndex = computed(() =>
  (props.meeting.insights?.actionItems ?? []).map((a, index) => ({ ...a, index })).filter((a) => a.approved)
);

const sendingToAsanaIndex = ref<number | null>(null);
const togglingDoneKey = ref<string | null>(null);
const deletingKey = ref<string | null>(null);
const regenerating = ref(false);

// These mutate actionItems from outside the review composable's own
// save()/resetCopy() flow (only reachable from the collapsed approved view,
// which only renders when the checklist is closed) — resetCopy() afterward
// keeps the working copy in sync so a later checklist Save can't silently
// overwrite the server with stale pre-mutation data.
async function onSendToAsana(index: number) {
  sendingToAsanaIndex.value = index;
  error.value = "";
  try {
    const result = await sendActionItemToAsana(props.meetingId, index);
    emit("update:meeting", result.meeting);
    actionItemsReview.resetCopy();
    Notify.create({
      type: "positive",
      message: result.alreadySent ? "Already sent to Asana" : "Sent to Asana",
      timeout: 2500,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    sendingToAsanaIndex.value = null;
  }
}

async function onToggleActionItemDone(index: number, done: boolean) {
  togglingDoneKey.value = `action-${index}`;
  error.value = "";
  try {
    const result = await setActionItemDone(props.meetingId, index, done);
    emit("update:meeting", result.meeting);
    actionItemsReview.resetCopy();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    togglingDoneKey.value = null;
  }
}

async function onDeleteActionItem(index: number) {
  deletingKey.value = `action-${index}`;
  error.value = "";
  try {
    const result = await deleteActionItem(props.meetingId, index);
    emit("update:meeting", result.meeting);
    actionItemsReview.resetCopy();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    deletingKey.value = null;
  }
}

async function onSaveActionItems() {
  error.value = "";
  try {
    const { justReviewed } = await actionItemsReview.save();
    Notify.create({
      type: "positive",
      message: justReviewed ? "Reviewed — notifications sent" : "Action items saved",
      timeout: 3000,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function onRegenerate() {
  regenerating.value = true;
  error.value = "";
  try {
    const result = await regenerateInsightCategory(props.meetingId, "actionItems");
    emit("update:meeting", result.meeting);
    actionItemsReview.resetCopy();
    Notify.create({ type: "positive", message: "Action items regenerated", timeout: 3000 });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    regenerating.value = false;
  }
}

// This component is keyed by meetingId in MeetingsView.vue (destroyed and
// recreated on selection change), so a fresh working copy on mount is the
// same "initial load" moment MeetingDetail.vue used to handle in its own
// load(). resetCopy is also exposed for the header's Reprocess action, which
// regenerates every category and needs both review columns re-seeded
// afterward (mirrors MeetingDetail.vue's old initReviewCopies()).
onMounted(() => actionItemsReview.resetCopy());
defineExpose({ resetCopy: actionItemsReview.resetCopy });
</script>
