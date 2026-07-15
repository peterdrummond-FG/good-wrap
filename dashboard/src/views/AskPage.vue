<template>
  <q-page class="column" style="max-width: 800px; margin: 0 auto">
    <div class="q-pa-md">
      <div class="text-h5">Ask across your meetings</div>
      <div class="text-caption text-grey-7">
        Stage 5 — semantic search over every processed meeting's transcript, answered by Claude
        with the source meeting(s) cited. Only meetings that have been through "Process this
        meeting" (Stage 2) are searchable.
      </div>
    </div>

    <div ref="scrollArea" class="col q-px-md" style="overflow-y: auto">
      <div v-if="turns.length === 0" class="text-grey-6 text-center q-pa-lg">
        Ask a question below to start the conversation.
      </div>

      <template v-for="turn in turns" :key="turn.id">
        <q-chat-message
          :text="[turn.question]"
          sent
          bg-color="chat-user"
          text-color="white"
          name="You"
        />

        <q-chat-message v-if="turn.error" name="good-wrap" bg-color="chat-assistant">
          <div class="text-red-4">{{ turn.error }}</div>
        </q-chat-message>

        <q-chat-message v-else-if="turn.answer !== null" name="good-wrap" bg-color="chat-assistant">
          <div style="white-space: pre-wrap">{{ turn.answer }}</div>

          <template v-if="turn.sources.length">
            <div class="text-caption text-grey-6 q-mt-sm">Sources</div>
            <q-list dense>
              <q-item
                v-for="s in turn.sources"
                :key="s.meetingId"
                clickable
                :to="`/meetings/${s.meetingId}`"
                class="q-pa-none"
              >
                <q-item-section>
                  <span class="text-primary">
                    {{ s.topic }} — {{ new Date(s.startTime).toLocaleDateString() }}
                  </span>
                </q-item-section>
              </q-item>
            </q-list>
          </template>
        </q-chat-message>

        <q-chat-message v-else name="good-wrap" bg-color="chat-assistant">
          <q-spinner-dots size="2em" />
        </q-chat-message>
      </template>
    </div>

    <q-form @submit.prevent="onAsk" class="q-pa-md row q-gutter-sm items-center">
      <q-input
        v-model="question"
        label="Your question"
        filled
        required
        class="col"
        :disable="asking"
        autofocus
      />
      <q-btn type="submit" color="primary" label="Ask" :loading="asking" unelevated />
    </q-form>
  </q-page>
</template>

<script setup lang="ts">
import { reactive, ref, nextTick } from "vue";
import { askQuestion, type AskResult } from "../api";

interface ChatTurn {
  id: number;
  question: string;
  // null while the request is in flight; set once it resolves (or errors).
  answer: string | null;
  sources: AskResult["sources"];
  error: string;
}

const question = ref("");
const asking = ref(false);
const turns = ref<ChatTurn[]>([]);
const scrollArea = ref<HTMLElement | null>(null);
let nextId = 0;

async function scrollToBottom() {
  await nextTick();
  if (scrollArea.value) {
    scrollArea.value.scrollTop = scrollArea.value.scrollHeight;
  }
}

async function onAsk() {
  const q = question.value.trim();
  if (!q) return;

  // reactive(), not a plain object literal: pushing a plain object into a
  // ref array leaves `turn` here pointing at the raw, unproxied object, so
  // later mutations (turn.answer = ...) never notify Vue's reactivity system
  // — the network call succeeds but the UI just never updates. Wrapping it
  // in reactive() up front means this same reference *is* the reactive
  // proxy, so mutating it through `turn` works correctly.
  const turn = reactive<ChatTurn>({ id: nextId++, question: q, answer: null, sources: [], error: "" });
  turns.value.push(turn);
  question.value = "";
  asking.value = true;
  scrollToBottom();

  try {
    const result = await askQuestion(q);
    turn.answer = result.answer;
    turn.sources = result.sources;
  } catch (err) {
    turn.answer = "";
    turn.error = err instanceof Error ? err.message : String(err);
  } finally {
    asking.value = false;
    scrollToBottom();
  }
}
</script>
