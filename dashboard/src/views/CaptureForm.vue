<template>
  <q-page padding style="max-width: 700px">
    <div class="bw-panel q-pa-lg">
      <div class="bw-panel__title q-mb-xs">Capture a meeting</div>
      <div class="bw-panel__subtitle q-mb-md">
        Stage 0's manual-entry form — paste in a transcript plus metadata, same as pasting it in
        chat, just with a UI. Feeds the same capture pipeline either way.
      </div>

      <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
        {{ error }}
      </q-banner>

      <q-form @submit.prevent="onSubmit" class="q-gutter-md">
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

      <div>
        <div class="text-subtitle2 q-mb-xs">Participants</div>
        <div
          v-for="(p, i) in participants"
          :key="i"
          class="row q-gutter-sm items-center q-mb-xs"
        >
          <q-input v-model="p.name" placeholder="Name" filled dense class="col" />
          <q-input v-model="p.email" placeholder="Email (optional)" filled dense class="col" />
          <q-btn
            flat
            round
            dense
            icon="close"
            @click="participants.splice(i, 1)"
            :disable="participants.length === 1"
          />
        </div>
        <q-btn
          flat
          dense
          icon="add"
          label="Add participant"
          @click="participants.push({ name: '', email: '' })"
        />
      </div>

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
import { captureMeeting } from "../api";

const router = useRouter();

const topic = ref("");
const startTime = ref("");
const durationMinutes = ref<number | null>(null);
const participants = ref<{ name: string; email: string }[]>([{ name: "", email: "" }]);
const transcript = ref("");
const submitting = ref(false);
const error = ref("");

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
    if (!result.processed) {
      // Capture itself succeeded — the meeting exists and is safe. Only the
      // automatic Stage 2 run right after it failed (e.g. a flaky Claude
      // API call), so surface that as a heads-up rather than an error, and
      // point at the fix (the Reprocess button on the meeting page).
      Notify.create({
        type: "warning",
        message: "Meeting captured, but automatic processing failed — use Reprocess on the meeting page.",
        caption: result.processingError,
        timeout: 6000,
      });
    }
    router.push(`/meetings/${result.meetingId}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>
