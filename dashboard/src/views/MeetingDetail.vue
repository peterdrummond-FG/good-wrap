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
          <div class="text-h5">{{ meeting.topic }}</div>
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
        </template>

        <!-- ---------------- edit view ---------------- -->
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

          <div class="text-subtitle1 q-mb-xs">Takeaways</div>
          <div v-for="(t, i) in editTakeaways" :key="i" class="row q-gutter-sm items-center q-mb-xs">
            <q-input v-model="editTakeaways[i]" filled dense class="col" />
            <q-btn flat round dense icon="close" @click="editTakeaways.splice(i, 1)" />
          </div>
          <q-btn
            flat
            dense
            icon="add"
            label="Add takeaway"
            class="q-mb-md"
            @click="editTakeaways.push('')"
          />

          <div class="text-subtitle1 q-mb-xs">Follow-ups</div>
          <div
            v-for="(f, i) in editFollowUps"
            :key="i"
            class="row q-gutter-sm items-start q-mb-sm bw-row"
            style="cursor: default"
          >
            <q-input v-model="f.text" placeholder="Follow-up" filled dense class="col-12 col-md-5" />
            <q-input v-model="f.personText" placeholder="With (optional)" filled dense class="col-6 col-md-3" />
            <q-select
              v-model="f.timing"
              :options="timingOptions"
              emit-value
              map-options
              filled
              dense
              label="Timing"
              class="col-6 col-md-3"
            />
            <q-btn flat round dense icon="close" @click="editFollowUps.splice(i, 1)" />
          </div>
          <q-btn
            flat
            dense
            icon="add"
            label="Add follow-up"
            class="q-mb-md"
            @click="editFollowUps.push({ text: '', personText: '', timing: 'unspecified' })"
          />

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
  updateMeeting,
  updateMeetingInsights,
  type FollowUpTiming,
  type MeetingDetail,
} from "../api";

const props = defineProps<{ id: string }>();
const router = useRouter();

const meeting = ref<MeetingDetail | null>(null);
const loading = ref(true);
const processing = ref(false);
const deleting = ref(false);
const saving = ref(false);
const error = ref("");

const editing = ref(false);
const editTopic = ref("");
const editStartTime = ref("");
const editDuration = ref<number | null>(null);
const editParticipants = ref<{ name: string; email: string }[]>([]);
const editKeywords = ref<string[]>([]);
const editTakeaways = ref<string[]>([]);
// `personText` here maps to the API's `person` field — named differently in
// the working copy just to avoid confusion with the `person` word appearing
// in both the display label and the underlying FollowUpItem type.
const editFollowUps = ref<{ text: string; personText: string; timing: FollowUpTiming }[]>([]);
const newKeyword = ref("");

const timingOptions: { label: string; value: FollowUpTiming }[] = [
  { label: "Unspecified", value: "unspecified" },
  { label: "Tomorrow", value: "tomorrow" },
  { label: "This week", value: "this_week" },
  { label: "Next week", value: "next_week" },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function timingLabel(timing: string): string {
  return { tomorrow: "Tomorrow", this_week: "This week", next_week: "Next week" }[timing] ?? "";
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
  editTakeaways.value = [...(m.insights?.takeaways ?? [])];
  editFollowUps.value = (m.insights?.followUps ?? []).map((f) =>
    reactive({ text: f.text, personText: f.person ?? "", timing: f.timing })
  );
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
    await updateMeeting(props.id, {
      topic: editTopic.value,
      startTime: new Date(editStartTime.value).toISOString(),
      durationMinutes: editDuration.value,
      participants: editParticipants.value
        .filter((p) => p.name.trim() || p.email.trim())
        .map((p) => ({
          name: p.name.trim() || undefined,
          email: p.email.trim() || undefined,
        })),
    });
    await updateMeetingInsights(props.id, {
      keywords: editKeywords.value.filter((k) => k.trim()),
      takeaways: editTakeaways.value.filter((t) => t.trim()),
      followUps: editFollowUps.value
        .filter((f) => f.text.trim())
        .map((f) => ({
          text: f.text.trim(),
          person: f.personText.trim() || null,
          timing: f.timing,
        })),
    });
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
