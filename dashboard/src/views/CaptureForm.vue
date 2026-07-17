<template>
  <q-page padding style="max-width: 700px">
    <div class="bw-panel q-pa-lg">
      <div class="bw-panel__title q-mb-xs">Capture a meeting</div>
      <div class="bw-panel__subtitle q-mb-md">
        Type in a transcript plus metadata, or upload a transcript file and let Claude infer the
        title/date/participants. Both feed the same capture pipeline.
      </div>

      <q-btn-toggle
        v-model="mode"
        class="q-mb-md"
        no-caps
        unelevated
        toggle-color="primary"
        :options="[
          { label: 'Type it in', value: 'manual' },
          { label: 'Upload a file', value: 'upload' },
        ]"
      />

      <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
        {{ error }}
      </q-banner>

      <q-form v-if="mode === 'upload'" @submit.prevent="onSubmitUpload" class="q-gutter-md">
        <q-file
          v-model="uploadFile"
          label="Transcript file (.txt)"
          filled
          accept=".txt,text/plain"
          required
        >
          <template #prepend><q-icon name="attach_file" /></template>
        </q-file>

        <q-btn
          type="submit"
          color="primary"
          label="Upload & capture"
          :loading="submitting"
          :disable="!uploadFile"
          unelevated
        />
      </q-form>

      <q-form v-else @submit.prevent="onSubmit" class="q-gutter-md">
      <q-input v-model="topic" label="Meeting title" filled required />

      <div class="row q-gutter-md">
        <q-input
          v-model="startTime"
          type="datetime-local"
          label="Date & time"
          filled
          class="col"
          required
        />
        <q-input
          v-model.number="durationMinutes"
          type="number"
          label="Duration (minutes, optional)"
          filled
          class="col"
        />
      </div>

      <ParticipantListEditor v-model="participants" prevent-empty-list />

      <q-input
        v-model="transcript"
        type="textarea"
        label="Transcript"
        filled
        autogrow
        input-style="min-height: 200px"
        required
      />

      <q-btn type="submit" color="primary" label="Capture meeting" :loading="submitting" unelevated />
      </q-form>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { Notify } from "quasar";
import { captureMeeting, uploadMeetingTranscript, type CaptureMeetingResult } from "../api";
import ParticipantListEditor from "../components/ParticipantListEditor.vue";

const router = useRouter();

const mode = ref<"manual" | "upload">("manual");

const topic = ref("");
const startTime = ref("");
const durationMinutes = ref<number | null>(null);
const participants = ref<{ name: string; email: string }[]>([{ name: "", email: "" }]);
const transcript = ref("");
const uploadFile = ref<File | null>(null);
const submitting = ref(false);
const error = ref("");

// Shared by both submit paths below — capture always succeeds independently
// of processing (see api.ts's CaptureMeetingResult), so a processing failure
// is surfaced as a heads-up rather than blocking navigation to the meeting.
function notifyIfProcessingFailed(result: CaptureMeetingResult) {
  if (result.processed) return;
  Notify.create({
    type: "warning",
    message: "Meeting captured, but automatic processing failed — use Reprocess on the meeting page.",
    caption: result.processingError,
    timeout: 6000,
  });
}

async function onSubmit() {
  submitting.value = true;
  error.value = "";
  try {
    const result = await captureMeeting({
      topic: topic.value,
      startTime: new Date(startTime.value).toISOString(),
      durationMinutes: durationMinutes.value ?? undefined,
      participants: participants.value
        .filter((p) => p.name.trim() || p.email.trim())
        .map((p) => ({
          name: p.name.trim() || undefined,
          email: p.email.trim() || undefined,
        })),
      transcript: transcript.value,
    });
    notifyIfProcessingFailed(result);
    router.push(`/meetings/${result.meetingId}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

async function onSubmitUpload() {
  if (!uploadFile.value) return;
  submitting.value = true;
  error.value = "";
  try {
    const result = await uploadMeetingTranscript(uploadFile.value);
    notifyIfProcessingFailed(result);
    router.push(`/meetings/${result.meetingId}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>
