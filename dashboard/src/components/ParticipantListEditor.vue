<template>
  <div>
    <div class="text-subtitle2 q-mb-xs">Participants</div>
    <div v-for="(p, i) in modelValue" :key="i" class="row q-gutter-sm items-center q-mb-xs">
      <q-input v-model="p.name" placeholder="Name" filled dense class="col" />
      <q-input v-model="p.email" placeholder="Email (optional)" filled dense class="col" />
      <q-btn
        flat
        round
        dense
        icon="close"
        @click="modelValue.splice(i, 1)"
        :disable="preventEmptyList && modelValue.length === 1"
      />
    </div>
    <q-btn flat dense icon="add" label="Add participant" @click="modelValue.push({ name: '', email: '' })" />
  </div>
</template>

<script setup lang="ts">
// Shared by CaptureForm.vue and MeetingEditDialog.vue — both rendered an
// identical name/email row + remove button + "Add participant" loop over a
// `{ name, email }[]` array. `preventEmptyList` preserves CaptureForm's
// original rule (must keep at least one row); MeetingEditDialog never had
// that restriction, so it defaults to false.
withDefaults(
  defineProps<{
    preventEmptyList?: boolean;
  }>(),
  { preventEmptyList: false }
);

const modelValue = defineModel<{ name: string; email: string }[]>({ required: true });
</script>
