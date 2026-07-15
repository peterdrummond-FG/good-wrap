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
                          {{ a.text }}
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
                        <li v-for="(a, i) in approvedActionItems" :key="i">{{ a.text }}</li>
                        <li v-if="!approvedActionItems.length" class="text-grey-6">(none approved)</li>
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
                          {{ f.text }}
                          <div class="text-caption text-grey-7 row items-center q-gutter-x-xs">
                            <span v-if="f.person">with <PersonTag :name="f.person" /></span>
                            <span class="bw-pill" :class="urgencyPillClass(f.urgency)">{{
                              urgencyLabel(f.urgency)
                            }}</span>
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
  processMeeting,
  regenerateInsightCategory,
  submitMeetingReview,
  updateMeeting,
  updateMeetingInsights,
  type MeetingDetail,
  type RegenerateCategory,
  type ReviewStatus,
  type Urgency,
} from "../api";
import { sortByUrgency, urgencyLabel, urgencyPillClass } from "../urgency";
import PersonTag from "../components/PersonTag.vue";

const props = defineProps<{ id: string }>();
const router = useRouter();

const meeting = ref<MeetingDetail | null>(null);
const loading = ref(true);
const processing = ref(false);
const deleting = ref(false);
const saving = ref(false);
const error = ref("");

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
const reviewActionItems = ref<{ text: string; urgency: Urgency; approved: boolean }[]>([]);
const reviewFollowUps = ref<{ text: string; person: string | null; urgency: Urgency; approved: boolean }[]>(
  []
);

// Follow-ups are shown most-urgent-first (changed 2026-07-16, per Peter — see
// urgency.ts). sortByUrgency returns a new array without touching item
// identity, so the checkboxes here still bind to the same reactive objects
// backing reviewFollowUps. Action Items dropped urgency sorting/display
// entirely (changed 2026-07-15 — Peter's original "just copyable, no
// ranking" ask was scoped to the dashboard panel only at the time, but on
// reflection he wants the review column unranked too, for consistency) —
// reviewActionItems is used directly in the template, in whatever order the
// API returned it.
const sortedReviewFollowUps = computed(() => sortByUrgency(reviewFollowUps.value));
const newActionItemText = ref("");
const newFollowUpText = ref("");

// --- pencil-triggered edit/regenerate state (added 2026-07-16) ------------
// Once a meeting is reviewed, Action Items/Follow-ups collapse to a plain
// bulleted list of approved items (see showActionItemsChecklist/
// showFollowUpsChecklist below) — the pencil on each column re-opens the
// checkbox/add-your-own view. Takeaways have no such collapse (always
// bulleted); their pencil only reveals the "Regenerate" button.
const editModeTakeaways = ref(false);
const editModeActionItems = ref(false);
const editModeFollowUps = ref(false);
const regeneratingCategory = ref<RegenerateCategory | null>(null);

// --- per-panel save + dirty-tracking (added 2026-07-16) -------------------
// Each of Action Items/Follow-ups now saves independently instead of sharing
// one meeting-wide "Save selections" button. A baseline snapshot is taken
// whenever that panel's working copy is (re)seeded from the server — on
// initial load, after that panel's own save, and after that panel's own
// regenerate. The Save button stays disabled until the working copy differs
// from its baseline (a checkbox toggle or an added item), and enables again
// the instant it does. Saving/regenerating one panel deliberately only
// touches that panel's own copy+baseline, so an in-progress edit in the
// OTHER panel isn't silently discarded.
const savingActionItems = ref(false);
const savingFollowUps = ref(false);
const actionItemsBaseline = ref("[]");
const followUpsBaseline = ref("[]");

function snapshotActionItems(): string {
  return JSON.stringify(
    reviewActionItems.value.map((a) => ({ text: a.text, urgency: a.urgency, approved: a.approved }))
  );
}
function snapshotFollowUps(): string {
  return JSON.stringify(
    reviewFollowUps.value.map((f) => ({ text: f.text, person: f.person, urgency: f.urgency, approved: f.approved }))
  );
}
const actionItemsDirty = computed(() => snapshotActionItems() !== actionItemsBaseline.value);
const followUpsDirty = computed(() => snapshotFollowUps() !== followUpsBaseline.value);

// Per-category now (changed 2026-07-15, CODE-AUDIT.md items #2/#4) — each
// checks that category's OWN reviewed-at rather than the meeting-wide
// reviewStatus, so Action Items can be sitting collapsed-and-reviewed while
// Follow-ups is still showing its checklist (or vice versa), instead of the
// whole-meeting status forcing both panels to stay in lockstep.
const showActionItemsChecklist = computed(
  () => !meeting.value?.insights?.actionItemsReviewedAt || editModeActionItems.value
);
const showFollowUpsChecklist = computed(
  () => !meeting.value?.insights?.followUpsReviewedAt || editModeFollowUps.value
);
const approvedActionItems = computed(() =>
  (meeting.value?.insights?.actionItems ?? []).filter((a) => a.approved)
);
const approvedFollowUps = computed(() =>
  sortByUrgency((meeting.value?.insights?.followUps ?? []).filter((f) => f.approved))
);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function reviewStatusLabel(status: ReviewStatus): string {
  return { pending: "Not processed", needs_review: "Needs review", reviewed: "Reviewed" }[status];
}

function pillClass(status: ReviewStatus): string {
  return {
    pending: "bw-pill--pending",
    needs_review: "bw-pill--needs-review",
    reviewed: "bw-pill--processed",
  }[status];
}

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

function addActionItem() {
  const value = newActionItemText.value.trim();
  if (value) reviewActionItems.value.push(reactive({ text: value, urgency: "medium", approved: true }));
  newActionItemText.value = "";
}

function addFollowUp() {
  const value = newFollowUpText.value.trim();
  if (value)
    reviewFollowUps.value.push(reactive({ text: value, person: null, urgency: "medium", approved: true }));
  newFollowUpText.value = "";
}

// Re-seeds ONE panel's working copy (+ its dirty-tracking baseline) from the
// latest fetched meeting. Kept separate per panel so saving/regenerating
// Action Items, say, never clobbers an in-progress unsaved edit sitting in
// the Follow-ups working copy.
function resetActionItemsCopy() {
  reviewActionItems.value = (meeting.value?.insights?.actionItems ?? []).map((a) => reactive({ ...a }));
  actionItemsBaseline.value = snapshotActionItems();
}
function resetFollowUpsCopy() {
  reviewFollowUps.value = (meeting.value?.insights?.followUps ?? []).map((f) => reactive({ ...f }));
  followUpsBaseline.value = snapshotFollowUps();
}

// Re-seeds BOTH review columns — only appropriate on initial load or a full
// reprocess, where discarding any in-progress edits is correct (a reprocess
// regenerates every category and resets reviewStatus anyway).
function initReviewCopies() {
  resetActionItemsCopy();
  resetFollowUpsCopy();
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
// than being silently persisted or discarded.
async function onSaveActionItems() {
  savingActionItems.value = true;
  error.value = "";
  try {
    const result = await submitMeetingReview(props.id, { actionItems: reviewActionItems.value });
    meeting.value = result.meeting;
    resetActionItemsCopy();
    // Collapse back to the bulleted view now that there's a fresh save.
    editModeActionItems.value = false;
    Notify.create({
      type: "positive",
      message: result.justReviewedActionItems ? "Reviewed — notifications sent" : "Action items saved",
      timeout: 3000,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingActionItems.value = false;
  }
}

async function onSaveFollowUps() {
  savingFollowUps.value = true;
  error.value = "";
  try {
    const result = await submitMeetingReview(props.id, { followUps: reviewFollowUps.value });
    meeting.value = result.meeting;
    resetFollowUpsCopy();
    editModeFollowUps.value = false;
    Notify.create({
      type: "positive",
      message: result.justReviewedFollowUps ? "Reviewed — notifications sent" : "Follow-ups saved",
      timeout: 3000,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingFollowUps.value = false;
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
    if (category === "actionItems") resetActionItemsCopy();
    else if (category === "followUps") resetFollowUpsCopy();
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
