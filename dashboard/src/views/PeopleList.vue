<template>
  <q-page padding style="max-width: 700px">
    <div class="bw-panel q-pa-lg">
      <div class="bw-panel__title q-mb-xs">People</div>
      <div class="bw-panel__subtitle q-mb-md">
        Pick someone to see your meeting history with them — no calendar integration, just
        whatever's already been captured.
      </div>

      <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>
        {{ error }}
      </q-banner>

      <router-link v-for="p in people" :key="p.id" :to="`/people/${p.id}`" class="bw-row">
        <PersonTag :name="p.name" />
      </router-link>

      <div v-if="!people.length && !loading" class="text-grey-7 q-pa-md text-center">
        No one to show yet — capture a meeting with participants first.
      </div>
    </div>

    <q-inner-loading :showing="loading" />
  </q-page>
</template>

<script setup lang="ts">
import { fetchPeople, type PersonListItem } from "../api";
import { useAsyncList } from "../composables/useAsyncList";
import PersonTag from "../components/PersonTag.vue";

const {
  data: people,
  loading,
  error,
} = useAsyncList(async () => (await fetchPeople()).people, [] as PersonListItem[]);
</script>
