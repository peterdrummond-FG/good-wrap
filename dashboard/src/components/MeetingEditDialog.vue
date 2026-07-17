<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 480px; max-width: 90vw">
      <q-card-section>
        <div class="text-h6">Edit meeting</div>
      </q-card-section>

      <q-card-section>
        <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
          {{ error }}
        </q-banner>

        <q-input v-model="editTopic" label="Meeting title" filled dense class="q-mb-md" />

        <div class="row q-gutter-md q-mb-md">
          <q-input v-model="editStartTime" type="datetime-local" label="Date & time" filled dense class="col" />
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
          <div v-for="(p, i) in editParticipants" :key="i" class="row q-gutter-sm items-center q-mb-xs">
            <q-input v-model="p.name" placeholder="Name" filled dense class="col" />
            <q-input v-model="p.email" placeholder="Email (optional)" filled dense class="col" />
            <q-btn flat round dense icon="close" @click="editParticipants.splice(i, 1)" />
          </div>
          <q-btn flat dense icon="add" label="Add participant" @click="editParticipants.push({ name: '', email: '' })" />
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
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" no-caps :disable="saving" @click="$emit('update:modelValue', false)" />
        <q-btn color="primary" label="Save" unelevated no-caps :loading="saving" @click="onSave" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { Notify } from "quasar";
import { fetchMeetingDetail, updateMeeting, updateMeetingInsights, type MeetingDetail } from "../api";

const props = defineProps<{ modelValue: boolean; meeting: MeetingDetail }>();
const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "saved", meeting: MeetingDetail): void;
}>();

const editTopic = ref("");
const editStartTime = ref("");
const editDuration = ref<number | null>(null);
const editParticipants = ref<{ name: string; email: string }[]>([]);
const editKeywords = ref<string[]>([]);
const newKeyword = ref("");
const saving = ref(false);
const error = ref("");

// datetime-local inputs need "YYYY-MM-DDTHH:mm" in local time (no timezone
// suffix) — Date#toISOString() is UTC, so build the local string by hand.
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initForm() {
  const m = props.meeting;
  editTopic.value = m.topic;
  editStartTime.value = toDatetimeLocal(m.startTime);
  editDuration.value = m.durationMinutes;
  // Participants come back from the API as flat display-name strings, so
  // there's no way to recover which were matched by email vs. name-only —
  // every existing participant is treated as a name here.
  editParticipants.value = m.participants.map((name) => reactive({ name, email: "" }));
  editKeywords.value = [...(m.insights?.keywords ?? [])];
  newKeyword.value = "";
  error.value = "";
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) initForm();
  }
);

function addKeyword() {
  const value = newKeyword.value.trim();
  if (value) editKeywords.value.push(value);
  newKeyword.value = "";
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
      updateMeeting(props.meeting.id, {
        topic: editTopic.value,
        startTime: new Date(editStartTime.value).toISOString(),
        durationMinutes: editDuration.value,
        participants: editParticipants.value
          .filter((p) => p.name.trim() || p.email.trim())
          .map((p) => ({ name: p.name.trim() || undefined, email: p.email.trim() || undefined })),
      }),
      updateMeetingInsights(props.meeting.id, {
        keywords: editKeywords.value.filter((k) => k.trim()),
      }),
    ]);
    // Neither PATCH response above is guaranteed to reflect both writes (they
    // run concurrently against separate tables) — re-fetch once to get the
    // true merged state, same as MeetingDetail.vue's old
    // refreshMeetingKeepingReviewEdits().
    const { meeting: refreshed } = await fetchMeetingDetail(props.meeting.id);
    emit("saved", refreshed);
    emit("update:modelValue", false);
    Notify.create({ type: "positive", message: "Meeting updated", timeout: 3000 });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>
