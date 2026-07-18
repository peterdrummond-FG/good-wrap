<template>
  <q-page padding style="max-width: 700px; margin: 0 auto">
    <div class="bw-panel q-pa-lg">
      <div class="bw-panel__title q-mb-xs">People</div>
      <div class="bw-panel__subtitle q-mb-md">
        Pick someone to see your meeting history with them — no calendar integration, just
        whatever's already been captured.
      </div>

      <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
        {{ error }}
      </q-banner>

      <q-input
        v-if="people.length"
        v-model="search"
        dense
        filled
        clearable
        placeholder="Search people…"
        class="q-mb-md"
      >
        <template #prepend><q-icon name="search" /></template>
      </q-input>

      <router-link
        v-for="p in filteredPeople"
        :key="p.id"
        :to="`/people/${p.id}`"
        class="bw-row row items-center q-gutter-xs no-wrap"
      >
        <PersonTag :name="p.name" />
        <CompanyTag v-for="c in p.companies" :key="c.id" :company="c" />
      </router-link>

      <div v-if="people.length && !filteredPeople.length" class="text-grey-7 q-pa-md text-center">
        No one matches "{{ search }}".
      </div>

      <div v-if="!people.length && !loading" class="text-grey-7 q-pa-md text-center">
        No one to show yet — capture a meeting with participants first.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { fetchPeople, type PersonListItem } from "../api";
import { useAsyncList } from "../composables/useAsyncList";
import PersonTag from "../components/PersonTag.vue";
import CompanyTag from "../components/CompanyTag.vue";

const {
  data: people,
  loading,
  error,
} = useAsyncList(async () => (await fetchPeople()).people, [] as PersonListItem[]);

// Client-side filter (added UI/UX pass, 2026-07-17) — the list has no
// pagination or grouping, so a plain substring search is enough for however
// many people get captured before this POC is rewritten into the hub app.
const search = ref("");
const filteredPeople = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return people.value;
  return people.value.filter((p) => p.name.toLowerCase().includes(q));
});
</script>
