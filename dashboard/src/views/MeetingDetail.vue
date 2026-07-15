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
          @click="onProcess"
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
            <span v-if="meeting.participants.length"> · {{ meeting.participants.join(", ") }}</span>
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
              <!-- Takeaways column -->
              <div class="col-12 col-md-4">
                <div class="bw-review-col">
                  <div class="bw-review-col__title">Takeaways</div>
                  <q-scroll-area style="height: 320px">
                    <q-item v-for="(t, i) in reviewTakeaways" :key="i" dense>
                      <q-item-section avatar top>
                        <q-checkbox v-model="t.approved" dense />
                      </q-item-section>
                      <q-item-section>{{ t.text }}</q-item-section>
                    </q-item>
                    <q-item v-if="!reviewTakeaways.length" dense>
                      <q-item-section class="text-grey-6">(none suggested)</q-item-section>
                    </q-item>
                  </q-scroll-area>
                  <q-input
                    v-model="newTakeawayText"
                    placeholder="Add your own takeaway"
                    dense
                    filled
                    class="q-mt-sm"
                    @keyup.enter="addTakeaway"
                  >
                    <template #append>
                      <q-btn flat round dense icon="add" @click="addTakeaway" />
                    </template>
                  </q-input>
                </div>
              </div>

              <!-- Action Items column -->
              <div class="col-12 col-md-4">
                <div class="bw-review-col">
                  <div class="bw-review-col__title">Action Items <span class="text-grey-6">(you)</span></div>
                  <q-scroll-area style="height: 320px">
                    <q-item v-for="(a, i) in reviewActionItems" :key="i" dense>
                      <q-item-section avatar top>
                        <q-checkbox v-model="a.approved" dense />
                      </q-item-section>
                      <q-item-section>
                        {{ a.text }}
                        <div v-if="a.timing !== 'unspecified'" class="text-caption text-grey-7">
                          {{ timingLabel(a.timing) }}
                        </div>
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
                </div>
              </div>

              <!-- Follow-ups column -->
              <div class="col-12 col-md-4">
                <div class="bw-review-col">
                  <div class="bw-review-col__title">Follow-ups <span class="text-grey-6">(others)</span></div>
                  <q-scroll-area style="height: 320px">
                    <q-item v-for="(f, i) in reviewFollowUps" :key="i" dense>
                      <q-item-section avatar top>
                        <q-checkbox v-model="f.approved" dense />
                      </q-item-section>
                      <q-item-section>
                        {{ f.text }}
                        <div v-if="f.person || f.timing !== 'unspecified'" class="text-caption text-grey-7">
                          <span v-if="f.person">with {{ f.person }}</span>
                          <span v-if="f.person && f.timing !== 'unspecified'"> · </span>
                          <span v-if="f.timing !== 'unspecified'">{{ timingLabel(f.timing) }}</span>
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
                </div>
              </div>
            </div>

            <q-btn
              color="primary"
              label="Save selections"
              unelevated
              no-caps
              :loading="savingReview"
              class="q-mb-md"
              @click="onSaveReview"
            />
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
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { Dialog, Notify } from "quasar";
import {
  deleteMeeting,
  fetchMeetingDetail,
  processMeeting,
  submitMeetingReview,
  updateMeeting,
  updateMeetingInsights,
  type FollowUpTiming,
  type MeetingDetail,
  type ReviewStatus,
} from "../api";

const props = defineProps<{ id: string }>();
const router = useRouter();

const meeting = ref<MeetingDetail | null>(null);
const loading = ref(true);
const processing = ref(false);
const deleting = ref(false);
const saving = ref(false);
const savingReview = ref(false);
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
// column for anything Claude missed.
const reviewTakeaways = ref<{ text: string; approved: boolean }[]>([]);
const reviewActionItems = ref<{ text: string; timing: FollowUpTiming; approved: boolean }[]>([]);
const reviewFollowUps = ref<{ text: string; person: string | null; timing: FollowUpTiming; approved: boolean }[]>(
  []
);
const newTakeawayText = ref("");
const newActionItemText = ref("");
const newFollowUpText = ref("");

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function timingLabel(timing: string): string {
  return { tomorrow: "Tomorrow", this_week: "This week", next_week: "Next week" }[timing] ?? "";
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

function addTakeaway() {
  const value = newTakeawayText.value.trim();
  if (value) reviewTakeaways.value.push(reactive({ text: value, approved: true }));
  newTakeawayText.value = "";
}

function addActionItem() {
  const value = newActionItemText.value.trim();
  if (value) reviewActionItems.value.push(reactive({ text: value, timing: "unspecified", approved: true }));
  newActionItemText.value = "";
}

function addFollowUp() {
  const value = newFollowUpText.value.trim();
  if (value)
    reviewFollowUps.value.push(reactive({ text: value, person: null, timing: "unspecified", approved: true }));
  newFollowUpText.value = "";
}

// Re-seeds the always-visible review columns from the latest fetched
// meeting — called after every load() so toggles never operate on stale data.
function initReviewCopies() {
  const insights = meeting.value?.insights;
  reviewTakeaways.value = (insights?.takeaways ?? []).map((t) => reactive({ ...t }));
  reviewActionItems.value = (insights?.actionItems ?? []).map((a) => reactive({ ...a }));
  reviewFollowUps.value = (insights?.followUps ?? []).map((f) => reactive({ ...f }));
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

async function onSaveReview() {
  savingReview.value = true;
  error.value = "";
  try {
    const result = await submitMeetingReview(props.id, {
      takeaways: reviewTakeaways.value,
      actionItems: reviewActionItems.value,
      followUps: reviewFollowUps.value,
    });
    await load();
    Notify.create({
      type: "positive",
      message: result.justReviewed ? "Reviewed — notifications sent" : "Selections saved",
      timeout: 3000,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingReview.value = false;
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
    await load();
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
