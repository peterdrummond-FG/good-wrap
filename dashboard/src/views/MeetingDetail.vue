<template>
  <q-page padding>
    <div class="row items-center justify-between q-mb-md">
      <q-btn flat icon="arrow_back" label="Back to dashboard" to="/" />
      <div class="row q-gutter-sm" v-if="meeting && !editing">
        <q-btn
          v-if="meeting.insights"
          outline
          color="primary"
          icon="refresh"
          label="Reprocess meeting"
          dense
          no-caps
          :loading="processing"
          @click="confirmReprocess"
        />
        <q-btn outline color="primary" icon="edit" label="Edit" dense no-caps @click="startEdit" />
        <q-btn
          outline
          color="negative"
          icon="delete"
          label="Delete"
          dense
          no-caps
          :loading="deleting"
          @click="confirmDelete"
        />
      </div>
    </div>

    <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
      {{ error }}
    </q-banner>

    <template v-if="meeting">
      <div class="bw-panel q-pa-lg">
        <!-- ---------------- read-only view ---------------- -->
        <template v-if="!editing">
          <div class="row items-center q-gutter-sm">
            <div class="text-h5">{{ meeting.topic }}</div>
            <span :class="['bw-pill', pillClass(meeting.reviewStatus)]">{{
              reviewStatusLabel(meeting.reviewStatus)
            }}</span>
          </div>
          <div class="text-caption text-grey-6 q-mb-md">
            {{ formatDate(meeting.startTime) }}
            <span v-if="meeting.durationMinutes"> · {{ meeting.durationMinutes }} min</span>
            <span v-if="meeting.participants.length">
              ·
              <template v-for="(p, i) in meeting.participants" :key="p"
                ><PersonTag :name="p" /><span v-if="i < meeting.participants.length - 1">, </span></template
              >
            </span>
            <span> · source: {{ meeting.source }}</span>
          </div>

          <q-card
            v-if="!meeting.insights"
            flat
            bordered
            class="q-pa-md q-mb-md"
            style="background: var(--bw-surface-raised)"
          >
            <div class="row items-center">
              <div class="col">
                This meeting hasn't been processed yet — no suggestions to review.
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

            <q-separator class="q-my-md" />

            <div class="row items-center justify-between q-mb-xs">
              <div class="text-subtitle1">Review suggestions</div>
              <div class="text-caption text-grey-6">
                Nothing is emailed/pinged until you save at least one approval.
              </div>
            </div>

            <div class="row q-col-gutter-md q-mb-sm">
              <!-- Takeaways column — no selection needed here (Peter's call:
                   the 5 generated are good enough as-is), so this is a plain
                   bulleted read-only list with no checkboxes and no
                   add-your-own row, unlike the other two columns. The pencil
                   just reveals a "Regenerate" button (nothing else to edit). -->
              <div class="col-12 col-md-4">
                <div class="bw-review-col">
                  <div class="row items-center justify-between bw-review-col__title">
                    <span>Takeaways</span>
                    <q-btn
                      flat round dense size="sm" icon="edit" color="grey-6"
                      @click="editModeTakeaways = !editModeTakeaways"
                    />
                  </div>
                  <q-scroll-area style="height: 320px">
                    <ul class="bw-bullet-list">
                      <li v-for="(t, i) in meeting.insights.takeaways" :key="i">{{ t.text }}</li>
                      <li v-if="!meeting.insights.takeaways.length" class="text-grey-6">(none suggested)</li>
                    </ul>
                  </q-scroll-area>
                  <q-btn
                    v-if="editModeTakeaways"
                    flat
                    dense
                    no-caps
                    icon="autorenew"
                    label="Regenerate takeaways"
                    class="q-mt-sm full-width"
                    :loading="regeneratingCategory === 'takeaways'"
                    @click="onRegenerate('takeaways')"
                  />
                </div>
              </div>

              <!-- Action Items column — collapses to a plain bulleted list of
                   approved items once the meeting's been reviewed; the pencil
                   reopens the checkbox/add-your-own edit view (and reveals
                   "Regenerate") so Peter can adjust or refresh it later. -->
              <div class="col-12 col-md-4">
                <div class="bw-review-col">
                  <div class="row items-center justify-between bw-review-col__title">
                    <span>Action Items <span class="text-grey-6">(you)</span></span>
                    <q-btn
                      flat round dense size="sm" icon="edit" color="grey-6"
                      @click="editModeActionItems = !editModeActionItems"
                    />
                  </div>

                  <template v-if="showActionItemsChecklist">
                    <q-scroll-area style="height: 320px">
                      <q-item v-for="(a, i) in reviewActionItems" :key="i" dense>
                        <q-item-section avatar top>
                          <q-checkbox v-model="a.approved" dense />
                        </q-item-section>
                        <q-item-section>
                          <q-input
                            v-model="a.text"
                            type="textarea"
                            autogrow
                            dense
                            borderless
                            input-class="text-body2"
                          />
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
                      :loading="regeneratingCategory === 'actionItems'"
                      @click="onRegenerate('actionItems')"
                    />
                  </template>
                  <template v-else>
                    <q-scroll-area style="height: 320px">
                      <ul class="bw-bullet-list">
                        <li
                          v-for="a in approvedActionItemsWithIndex"
                          :key="a.index"
                          class="row items-center justify-between q-gutter-x-xs"
                        >
                          <span class="col">{{ a.text }}</span>
                          <q-icon v-if="a.asanaTaskGid" name="check_circle" color="positive" size="18px">
                            <q-tooltip>Sent to Asana</q-tooltip>
                          </q-icon>
                          <q-btn
                            v-else
                            flat
                            round
                            dense
                            size="sm"
                            icon="send"
                            color="grey-5"
                            :loading="sendingToAsanaIndex === a.index"
                            @click="onSendToAsana(a.index)"
                          >
                            <q-tooltip>Send to Asana</q-tooltip>
                          </q-btn>
                        </li>
                        <li v-if="!approvedActionItemsWithIndex.length" class="text-grey-6">(none approved)</li>
                      </ul>
                    </q-scroll-area>
                  </template>
                </div>
              </div>

              <!-- Follow-ups column — same collapse-to-bulleted behavior as
                   Action Items above. -->
              <div class="col-12 col-md-4">
                <div class="bw-review-col">
                  <div class="row items-center justify-between bw-review-col__title">
                    <span>Follow-ups <span class="text-grey-6">(others)</span></span>
                    <q-btn
                      flat round dense size="sm" icon="edit" color="grey-6"
                      @click="editModeFollowUps = !editModeFollowUps"
                    />
                  </div>

                  <template v-if="showFollowUpsChecklist">
                    <q-scroll-area style="height: 320px">
                      <q-item v-for="(f, i) in sortedReviewFollowUps" :key="i" dense>
                        <q-item-section avatar top>
                          <q-checkbox v-model="f.approved" dense />
                        </q-item-section>
                        <q-item-section>
                          <q-input
                            v-model="f.text"
                            type="textarea"
                            autogrow
                            dense
                            borderless
                            input-class="text-body2"
                          />
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
                      :loading="regeneratingCategory === 'followUps'"
                      @click="onRegenerate('followUps')"
                    />
                  </template>
                  <template v-else>
                    <q-scroll-area style="height: 320px">
                      <ul class="bw-bullet-list">
                        <li v-for="(f, i) in approvedFollowUps" :key="i">
                          {{ f.text }}
                          <span v-if="f.person" class="text-caption text-grey-7">— with <PersonTag :name="f.person" /></span>
                          <span class="bw-pill" :class="urgencyPillClass(f.urgency)">{{
                            urgencyLabel(f.urgency)
                          }}</span>
                        </li>
                        <li v-if="!approvedFollowUps.length" class="text-grey-6">(none approved)</li>
                      </ul>
                    </q-scroll-area>
                  </template>
                </div>
              </div>
            </div>
          </template>

          <q-expansion-item label="Full transcript" class="q-mt-md" dense-toggle>
            <q-card flat bordered style="background: var(--bw-surface-raised)">
              <q-card-section style="white-space: pre-wrap; max-height: 400px; overflow-y: auto">
                {{ meeting.transcript ?? "(no transcript)" }}
              </q-card-section>
            </q-card>
          </q-expansion-item>
        </template>

        <!-- ---------------- metadata edit view ---------------- -->
        <template v-else>
          <div class="text-h6 q-mb-md">Edit meeting</div>

          <q-input v-model="editTopic" label="Meeting title" filled dense class="q-mb-md" />

          <div class="row q-gutter-md q-mb-md">
            <q-input
              v-model="editStartTime"
              type="datetime-local"
              label="Date & time"
              filled
              dense
              class="col"
            />
            <q-input
              v-model.number="editDuration"
              type="number"
              label="Duration (minutes, optional)"
              filled
              dense
              class="col"
            />
          </div>

          <div class="q-mb-md">
            <div class="text-subtitle2 q-mb-xs">Participants</div>
            <div
              v-for="(p, i) in editParticipants"
              :key="i"
              class="row q-gutter-sm items-center q-mb-xs"
            >
              <q-input v-model="p.name" placeholder="Name" filled dense class="col" />
              <q-input v-model="p.email" placeholder="Email (optional)" filled dense class="col" />
              <q-btn flat round dense icon="close" @click="editParticipants.splice(i, 1)" />
            </div>
            <q-btn
              flat
              dense
              icon="add"
              label="Add participant"
              @click="editParticipants.push({ name: '', email: '' })"
            />
          </div>

          <q-separator class="q-my-md" />

          <div class="text-subtitle1 q-mb-xs">Keywords</div>
          <div class="row q-gutter-xs items-center q-mb-md">
            <q-chip
              v-for="(k, i) in editKeywords"
              :key="i"
              dense
              removable
              color="primary"
              text-color="white"
              @remove="editKeywords.splice(i, 1)"
            >
              {{ k }}
            </q-chip>
            <q-input
              v-model="newKeyword"
              placeholder="Add keyword"
              dense
              filled
              style="min-width: 160px"
              @keyup.enter="addKeyword"
            >
              <template #append>
                <q-btn flat round dense icon="add" @click="addKeyword" />
              </template>
            </q-input>
          </div>

          <div class="row q-gutter-sm q-mt-lg">
            <q-btn color="primary" label="Save" unelevated no-caps :loading="saving" @click="onSave" />
            <q-btn flat label="Cancel" no-caps :disable="saving" @click="cancelEdit" />
          </div>
        </template>
      </div>
    </template>

    <q-inner-loading :showing="loading" />
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { Dialog, Notify } from "quasar";
import {
  deleteMeeting,
  fetchMeetingDetail,
  fetchPeople,
  processMeeting,
  regenerateInsightCategory,
  sendActionItemToAsana,
  updateMeeting,
  updateMeetingInsights,
  type MeetingDetail,
  type RegenerateCategory,
  type Urgency,
} from "../api";
import { sortByUrgency, urgencyLabel, urgencyPillClass } from "../urgency";
import { formatMeetingDateTime as formatDate } from "../formatDate";
import { reviewStatusDetailLabel as reviewStatusLabel, reviewStatusPillClass as pillClass } from "../reviewStatus";
import { useReviewCategory } from "../composables/useReviewCategory";
import PersonTag from "../components/PersonTag.vue";

const props = defineProps<{ id: string }>();
const router = useRouter();

// Follow-ups' urgency is editable (Action Items stays urgency-free — Peter's
// earlier "no ranking" call, see urgency.ts). q-select needs {label, value}
// pairs (not plain strings) since the displayed label ("High") differs from
// the stored value ("high") — built from urgencyLabel so the wording can't
// drift from the read-only pill display.
const URGENCY_SELECT_OPTIONS: { label: string; value: Urgency }[] = (
  ["high", "medium", "low"] as Urgency[]
).map((value) => ({ value, label: urgencyLabel(value) }));

const meeting = ref<MeetingDetail | null>(null);
const loading = ref(true);
const processing = ref(false);
const deleting = ref(false);
const saving = ref(false);
const error = ref("");

// Everyone Peter's ever met with, not just this meeting's attendees — lets a
// follow-up be manually reassigned to someone who wasn't in this meeting,
// consistent with what the AI can now attribute automatically (2026-07-16).
// Fetched once on mount; if it fails, the dropdown just falls back to this
// meeting's attendees, so this isn't wrapped in the page's error banner.
const allKnownPeopleNames = ref<string[]>([]);
onMounted(async () => {
  try {
    const result = await fetchPeople();
    allKnownPeopleNames.value = result.people.map((p) => p.name);
  } catch {
    // Non-critical — see comment above.
  }
});

// This meeting's attendees first, then everyone else known, alphabetically.
const followUpPersonOptions = computed(() => {
  const attendees = meeting.value?.participants ?? [];
  const attendeeSet = new Set(attendees);
  const others = allKnownPeopleNames.value
    .filter((name) => !attendeeSet.has(name))
    .sort((a, b) => a.localeCompare(b));
  return [...attendees, ...others];
});

// --- metadata edit (topic/date/duration/participants/keywords) ------------
const editing = ref(false);
const editTopic = ref("");
const editStartTime = ref("");
const editDuration = ref<number | null>(null);
const editParticipants = ref<{ name: string; email: string }[]>([]);
const editKeywords = ref<string[]>([]);
const newKeyword = ref("");

// --- always-visible suggestion review (independent of metadata edit mode) -
// Peter's call: checkbox-only against the AI's suggested wording (no inline
// text editing there) plus a single free-text "add your own" row per
// column for anything Claude missed. Takeaways aren't included here at all
// (see the template's Takeaways column comment) — they're read directly
// from meeting.insights.takeaways since there's nothing to review/toggle.
//
// Action Items and Follow-ups share one implementation (useReviewCategory) —
// a working copy, dirty-tracking against a save/regenerate baseline,
// edit-mode collapse, and per-panel save/notification logic, parametrized by
// this category's item shape and whether it's urgency-sorted. Follow-ups is
// (Peter's request); Action Items isn't (his "just copyable, no ranking"
// ask, extended from the dashboard panel to this review column too).
const actionItemsReview = useReviewCategory<{ text: string; urgency: Urgency; approved: boolean }>({
  meetingId: props.id,
  meeting,
  read: (m) => ({ items: m.insights!.actionItems, reviewedAt: m.insights!.actionItemsReviewedAt }),
  makeNewItem: (text) => ({ text, urgency: "medium", approved: true }),
  snapshotFields: (a) => ({ text: a.text, urgency: a.urgency, approved: a.approved }),
  buildPayload: (items) => ({ actionItems: items }),
  readJustReviewed: (result) => result.justReviewedActionItems,
});

const followUpsReview = useReviewCategory<{
  text: string;
  person: string | null;
  urgency: Urgency;
  approved: boolean;
}>({
  meetingId: props.id,
  meeting,
  read: (m) => ({ items: m.insights!.followUps, reviewedAt: m.insights!.followUpsReviewedAt }),
  makeNewItem: (text) => ({ text, person: null, urgency: "medium", approved: true }),
  snapshotFields: (f) => ({ text: f.text, person: f.person, urgency: f.urgency, approved: f.approved }),
  sortForDisplay: sortByUrgency,
  buildPayload: (items) => ({ followUps: items }),
  readJustReviewed: (result) => result.justReviewedFollowUps,
});

const reviewActionItems = actionItemsReview.items;
const newActionItemText = actionItemsReview.newItemText;
const addActionItem = actionItemsReview.addItem;
const actionItemsDirty = actionItemsReview.dirty;
const savingActionItems = actionItemsReview.saving;
const showActionItemsChecklist = actionItemsReview.showChecklist;

// Approved Action Items, with each item's real index in the underlying
// actionItems array attached — needed so "Send to Asana" (Action Items
// only, see api.ts's sendActionItemToAsana) can address the right item on
// the server, since the API identifies items by position, not id.
const approvedActionItemsWithIndex = computed(() =>
  (meeting.value?.insights?.actionItems ?? [])
    .map((a, index) => ({ ...a, index }))
    .filter((a) => a.approved)
);
const sendingToAsanaIndex = ref<number | null>(null);

async function onSendToAsana(index: number) {
  sendingToAsanaIndex.value = index;
  error.value = "";
  try {
    const result = await sendActionItemToAsana(props.id, index);
    meeting.value = result.meeting;
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

const reviewFollowUps = followUpsReview.items;
const sortedReviewFollowUps = followUpsReview.displayItems;
const newFollowUpText = followUpsReview.newItemText;
const addFollowUp = followUpsReview.addItem;
const followUpsDirty = followUpsReview.dirty;
const savingFollowUps = followUpsReview.saving;
const showFollowUpsChecklist = followUpsReview.showChecklist;
const approvedFollowUps = followUpsReview.approvedItems;

// --- pencil-triggered edit/regenerate state (added 2026-07-16) ------------
// Once a meeting is reviewed, Action Items/Follow-ups collapse to a plain
// bulleted list of approved items (see showActionItemsChecklist/
// showFollowUpsChecklist above) — the pencil on each column re-opens the
// checkbox/add-your-own view. Takeaways have no such collapse (always
// bulleted); their pencil only reveals the "Regenerate" button.
const editModeTakeaways = ref(false);
const editModeActionItems = actionItemsReview.editMode;
const editModeFollowUps = followUpsReview.editMode;
const regeneratingCategory = ref<RegenerateCategory | null>(null);

// datetime-local inputs need "YYYY-MM-DDTHH:mm" in local time (no timezone
// suffix) — Date#toISOString() is UTC, so build the local string by hand.
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function addKeyword() {
  const value = newKeyword.value.trim();
  if (value) editKeywords.value.push(value);
  newKeyword.value = "";
}

// Re-seeds BOTH review columns — only appropriate on initial load or a full
// reprocess, where discarding any in-progress edits is correct (a reprocess
// regenerates every category and resets reviewStatus anyway).
function initReviewCopies() {
  actionItemsReview.resetCopy();
  followUpsReview.resetCopy();
}

async function load() {
  loading.value = true;
  try {
    const result = await fetchMeetingDetail(props.id);
    meeting.value = result.meeting;
    initReviewCopies();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

// Refreshes meeting.value without touching the review working copies or
// their dirty baselines. Used after a metadata-only save (topic/date/
// participants/keywords), which never touches actionItems/followUps
// server-side — calling the full load() there used to re-seed both review
// columns from the server and silently discard any in-progress unsaved
// checkbox edits sitting in either panel. Added 2026-07-15, CODE-AUDIT.md
// item #6.
async function refreshMeetingKeepingReviewEdits() {
  const result = await fetchMeetingDetail(props.id);
  meeting.value = result.meeting;
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

// Reprocessing regenerates keywords/takeaways/action items/follow-ups from
// scratch and resets both review flags to null (see processMeeting.ts) —
// any approvals made so far are discarded with no way to recover them.
// Only the "Reprocess meeting" button (shown once insights already exist)
// goes through this confirm; the first-time "Process this meeting" button
// (shown when there's nothing yet to lose) calls onProcess directly.
// Added 2026-07-15, CODE-AUDIT.md item #5.
function confirmReprocess() {
  Dialog.create({
    title: "Reprocess this meeting?",
    message:
      "This regenerates keywords, takeaways, action items, and follow-ups from scratch using a fresh AI pass. " +
      "Any takeaways/action items/follow-ups you've already approved will be discarded, and the meeting will " +
      "need to be reviewed again. This can't be undone.",
    persistent: true,
    ok: { label: "Reprocess", color: "primary", flat: true },
    cancel: { label: "Cancel", flat: true },
  }).onOk(onProcess);
}

// Saves ONLY this panel's category — the other category is omitted from the
// request entirely (see ReviewMeetingInput/SubmitReviewInput), so an
// in-progress unsaved edit sitting in the other panel is left alone rather
// than being silently persisted or discarded. State work (persist, reseed,
// collapse edit mode) lives in useReviewCategory's save() — this just adds
// the page-level error/success feedback around it.
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

async function onRegenerate(category: RegenerateCategory) {
  regeneratingCategory.value = category;
  error.value = "";
  try {
    const result = await regenerateInsightCategory(props.id, category);
    meeting.value = result.meeting;
    // Only reset the copy for the category that was actually regenerated —
    // resetting both here would blow away any in-progress unsaved edit the
    // user has sitting in the OTHER panel.
    if (category === "actionItems") actionItemsReview.resetCopy();
    else if (category === "followUps") followUpsReview.resetCopy();
    if (category === "takeaways") {
      // Takeaways have no separate approve/save step — regenerating IS the
      // save, so collapse the edit affordance back down automatically.
      editModeTakeaways.value = false;
    }
    const label = { takeaways: "Takeaways", actionItems: "Action items", followUps: "Follow-ups" }[category];
    Notify.create({ type: "positive", message: `${label} regenerated`, timeout: 3000 });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    regeneratingCategory.value = null;
  }
}

function startEdit() {
  if (!meeting.value) return;
  const m = meeting.value;

  editTopic.value = m.topic;
  editStartTime.value = toDatetimeLocal(m.startTime);
  editDuration.value = m.durationMinutes;
  // Participants come back from the API as flat display-name strings (see
  // getMeetingDetail) rather than {name, email} pairs, so there's no way to
  // recover which were matched by email vs. name-only — editing here treats
  // every existing participant as a name. Add a new row with an email to
  // upgrade one to email-matched identity.
  editParticipants.value = m.participants.map((name) => reactive({ name, email: "" }));
  editKeywords.value = [...(m.insights?.keywords ?? [])];
  newKeyword.value = "";
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
}

async function onSave() {
  if (!editTopic.value.trim()) {
    error.value = "Meeting title cannot be empty";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    await Promise.all([
      updateMeeting(props.id, {
        topic: editTopic.value,
        startTime: new Date(editStartTime.value).toISOString(),
        durationMinutes: editDuration.value,
        participants: editParticipants.value
          .filter((p) => p.name.trim() || p.email.trim())
          .map((p) => ({
            name: p.name.trim() || undefined,
            email: p.email.trim() || undefined,
          })),
      }),
      updateMeetingInsights(props.id, {
        keywords: editKeywords.value.filter((k) => k.trim()),
      }),
    ]);
    editing.value = false;
    await refreshMeetingKeepingReviewEdits();
    Notify.create({ type: "positive", message: "Meeting updated", timeout: 3000 });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

function confirmDelete() {
  if (!meeting.value) return;
  Dialog.create({
    title: "Delete meeting?",
    message: `This permanently deletes "${meeting.value.topic}" — its transcript, keywords, takeaways, and follow-ups. This can't be undone.`,
    persistent: true,
    ok: { label: "Delete", color: "negative", flat: true },
    cancel: { label: "Cancel", flat: true },
  }).onOk(onDelete);
}

async function onDelete() {
  deleting.value = true;
  error.value = "";
  try {
    await deleteMeeting(props.id);
    Notify.create({ type: "positive", message: "Meeting deleted", timeout: 3000 });
    router.push("/");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    deleting.value = false;
  }
}

onMounted(load);
</script>
